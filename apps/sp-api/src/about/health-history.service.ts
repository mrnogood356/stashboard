import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AboutService } from './about.service';
import type { HealthHistoryResponse, ServiceHistory } from './about.types';

export const SAMPLE_EVERY_MS = 5 * 60_000;
export const KEEP_DAYS = 7;
const HOUR_MS = 60 * 60_000;

const LABELS: Record<string, string> = {
  DATABASE: 'Database',
  STASH: 'Stash',
  STASHDB: 'StashDB',
  FANSDB: 'FansDB',
  WHISPARR: 'Whisparr',
  PROWLARR: 'Prowlarr',
  SABNZBD: 'SABnzbd',
};
const ORDER = Object.keys(LABELS);

interface Sample {
  service: string;
  at: Date;
  ok: boolean;
  ms: number | null;
  error: string | null;
}

/**
 * Checks the database and each integration every 5 minutes and keeps 7
 * days of it, so "Stash was slow last night" can be looked up in About.
 */
@Injectable()
export class HealthHistoryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(HealthHistoryService.name);
  private running = false;
  /** Swapped in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly about?: AboutService,
  ) {}

  private firstCheck: ReturnType<typeof setTimeout> | null = null;

  /** A first check soon after start, so the chart isn't empty for 5 minutes. */
  onApplicationBootstrap(): void {
    this.firstCheck = setTimeout(() => void this.record(), 30_000);
    this.firstCheck.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstCheck) {
      clearTimeout(this.firstCheck);
    }
  }

  /** The most memory seen so far (MB), and when the process started using it. */
  private memoryHigh: number | null = null;
  /** Swapped in tests. */
  memoryUsage: () => {
    rss: number;
    heapUsed: number;
    external?: number;
  } = () => process.memoryUsage();

  /**
   * Logs Stashboard's memory each time it reaches a new high, 50 MB above
   * the last one, so steady growth shows in the log with when it happened.
   * Split into JavaScript objects and buffers (downloads, files) held outside
   * them: a leak shows in one or the other, or in neither (native memory).
   */
  noteMemory(): void {
    const usage = this.memoryUsage();
    const mb = (bytes: number | undefined) =>
      Math.round((bytes ?? 0) / 1048576);
    const rss = mb(usage.rss);
    const parts = `${mb(usage.heapUsed)} MB of it JavaScript, ${mb(usage.external)} MB buffers`;
    if (this.memoryHigh === null) {
      this.memoryHigh = rss;
      this.logger.log(`Memory: ${rss} MB in use (${parts}).`);
      return;
    }
    if (rss >= this.memoryHigh + 50) {
      this.logger.warn(
        `Memory: ${rss} MB in use (${parts}), up from ${this.memoryHigh} MB.`,
      );
      this.memoryHigh = rss;
    }
  }

  @Interval(SAMPLE_EVERY_MS)
  async record(): Promise<void> {
    this.noteMemory();
    if (this.running || !this.about) {
      return;
    }
    this.running = true;
    try {
      const at = new Date(this.now());
      const samples = await this.about.sample();
      await this.prisma.healthSample.createMany({
        data: samples.map((sample) => ({ ...sample, at })),
      });
      await this.prisma.healthSample.deleteMany({
        where: { at: { lt: new Date(this.now() - KEEP_DAYS * 24 * HOUR_MS) } },
      });
    } catch (error) {
      this.logger.debug(
        `Health history check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async history(): Promise<HealthHistoryResponse> {
    const since = this.now() - KEEP_DAYS * 24 * HOUR_MS;
    const samples = (await this.prisma.healthSample.findMany({
      where: { at: { gte: new Date(since) } },
      orderBy: { at: 'asc' },
      select: { service: true, at: true, ok: true, ms: true, error: true },
    })) as Sample[];
    return {
      since: new Date(since).toISOString(),
      services: summarize(samples, since, this.now()),
    };
  }
}

/** Per service: hourly buckets oldest first, and the week's totals. */
export function summarize(
  samples: Sample[],
  since: number,
  now: number,
): ServiceHistory[] {
  const start = Math.floor(since / HOUR_MS) * HOUR_MS;
  const hours = Math.ceil((now - start) / HOUR_MS);
  const byService = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = byService.get(sample.service) ?? [];
    list.push(sample);
    byService.set(sample.service, list);
  }
  return [...byService.keys()]
    .sort((a, b) => rank(a) - rank(b))
    .map((service) => {
      const list = byService.get(service)!;
      const buckets = Array.from({ length: hours }, (_, i) => ({
        at: new Date(start + i * HOUR_MS).toISOString(),
        checks: 0,
        failed: 0,
        totalMs: 0,
        timed: 0,
      }));
      for (const sample of list) {
        const index = Math.floor((sample.at.getTime() - start) / HOUR_MS);
        const bucket = buckets[index];
        if (!bucket) {
          continue;
        }
        bucket.checks += 1;
        if (!sample.ok) {
          bucket.failed += 1;
        } else if (sample.ms !== null) {
          bucket.totalMs += sample.ms;
          bucket.timed += 1;
        }
      }
      const okSamples = list.filter(
        (sample) => sample.ok && sample.ms !== null,
      );
      const lastFailure =
        [...list].reverse().find((sample) => !sample.ok) ?? null;
      return {
        service,
        label: LABELS[service] ?? service,
        checks: list.length,
        upPercent:
          Math.round(
            (1000 * (list.length - list.filter((s) => !s.ok).length)) /
              list.length,
          ) / 10,
        averageMs: okSamples.length
          ? Math.round(
              okSamples.reduce((sum, s) => sum + (s.ms ?? 0), 0) /
                okSamples.length,
            )
          : null,
        lastProblem: lastFailure
          ? { at: lastFailure.at.toISOString(), error: lastFailure.error }
          : null,
        hours: buckets.map((bucket) => ({
          at: bucket.at,
          checks: bucket.checks,
          failed: bucket.failed,
          averageMs: bucket.timed
            ? Math.round(bucket.totalMs / bucket.timed)
            : null,
        })),
      };
    });
}

function rank(service: string): number {
  const index = ORDER.indexOf(service);
  return index === -1 ? ORDER.length : index;
}
