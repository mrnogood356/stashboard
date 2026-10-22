import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SyncJobStatus, SyncState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface SyncStateSuccessInput {
  cursor?: string | null;
  processedCount?: number | null;
  updatedCount?: number | null;
  durationMs?: number | null;
  runReason?: string | null;
}

@Injectable()
export class SyncStateService {
  private readonly logger = new Logger(SyncStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async runWithLease<T>(
    config: {
      jobName: string;
      leaseMs: number;
      onSuccess?: (
        result: T,
        context: {
          durationMs: number;
        },
      ) => SyncStateSuccessInput;
    },
    handler: () => Promise<T>,
  ): Promise<T | null> {
    const lease = await this.tryAcquireLease(config.jobName, config.leaseMs);
    if (!lease) {
      this.logger.debug(`Skipping overlapping sync job: ${config.jobName}`);
      return null;
    }

    const startedAt = Date.now();
    const label = jobLabel(config.jobName);
    // The frequent background jobs only say they started at debug.
    if (FREQUENT_JOBS.has(config.jobName)) {
      this.logger.debug(`Started ${label}.`);
    } else {
      this.logger.log(`Started ${label}.`);
    }

    try {
      const result = await handler();
      const durationMs = Date.now() - startedAt;
      const success: SyncStateSuccessInput = {
        durationMs,
        ...(config.onSuccess?.(result, { durationMs }) ?? {}),
      };
      await this.markSuccess(config.jobName, success);
      const line = `Finished ${label}${success.runReason ? ` (${success.runReason})` : ''} in ${formatDuration(durationMs)}: ${success.processedCount ?? 0} checked, ${success.updatedCount ?? 0} updated.`;
      // A frequent job that changed nothing would only be noise at info.
      if (FREQUENT_JOBS.has(config.jobName) && !success.updatedCount) {
        this.logger.debug(line);
      } else {
        this.logger.log(line);
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `${label[0].toUpperCase()}${label.slice(1)} failed after ${formatDuration(Date.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.markFailure(config.jobName, error);
      throw error;
    }
  }

  async listStates(): Promise<SyncState[]> {
    return this.prisma.syncState.findMany({
      orderBy: {
        jobName: 'asc',
      },
    });
  }

  async tryAcquireLease(
    jobName: string,
    leaseMs: number,
  ): Promise<SyncState | null> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    await this.prisma.syncState.upsert({
      where: { jobName },
      create: {
        jobName,
      },
      update: {},
    });

    const claim = await this.prisma.syncState.updateMany({
      where: {
        jobName,
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: {
        status: SyncJobStatus.RUNNING,
        startedAt: now,
        finishedAt: null,
        leaseUntil,
        lastError: null,
      },
    });

    if (claim.count === 0) {
      return null;
    }

    return this.prisma.syncState.findUnique({
      where: { jobName },
    });
  }

  async markSuccess(
    jobName: string,
    input?: SyncStateSuccessInput,
  ): Promise<void> {
    await this.recordSuccess(jobName, input);
  }

  async recordSuccess(
    jobName: string,
    input?: SyncStateSuccessInput,
  ): Promise<void> {
    const now = new Date();
    const data: Prisma.SyncStateUpdateInput = {
      status: SyncJobStatus.SUCCEEDED,
      finishedAt: now,
      leaseUntil: null,
      lastSuccessAt: now,
      lastError: null,
    };

    if (input?.cursor !== undefined) {
      data.cursor = input.cursor;
    }
    if (input?.processedCount !== undefined) {
      data.lastProcessedCount = input.processedCount;
    }
    if (input?.updatedCount !== undefined) {
      data.lastUpdatedCount = input.updatedCount;
    }
    if (input?.durationMs !== undefined) {
      data.lastDurationMs = input.durationMs;
    }
    if (input?.runReason !== undefined) {
      data.lastRunReason = input.runReason;
    }

    const create: Prisma.SyncStateCreateInput = {
      jobName,
      status: SyncJobStatus.SUCCEEDED,
      startedAt: null,
      finishedAt: now,
      leaseUntil: null,
      lastError: null,
      lastSuccessAt: now,
      lastProcessedCount: input?.processedCount ?? null,
      lastUpdatedCount: input?.updatedCount ?? null,
      lastDurationMs: input?.durationMs ?? null,
      lastRunReason: input?.runReason ?? null,
    };

    if (input?.cursor !== undefined) {
      create.cursor = input.cursor;
    }

    await this.prisma.syncState.upsert({
      where: { jobName },
      create,
      update: data,
    });
  }

  async markFailure(jobName: string, error: unknown): Promise<void> {
    const now = new Date();
    await this.prisma.syncState.update({
      where: { jobName },
      data: {
        status: SyncJobStatus.FAILED,
        finishedAt: now,
        leaseUntil: null,
        lastError: this.serializeError(error),
      },
    });
  }

  private serializeError(error: unknown): string {
    if (error instanceof Error) {
      const message = error.stack ?? error.message;
      return message.length > 4000
        ? `${message.slice(0, 4000)}...(truncated)`
        : message;
    }

    try {
      const serialized = JSON.stringify(error);
      if (!serialized) {
        return 'Unknown error';
      }

      return serialized.length > 4000
        ? `${serialized.slice(0, 4000)}...(truncated)`
        : serialized;
    } catch {
      return 'Unknown error';
    }
  }
}

/** Jobs that run every few seconds or minutes; they log at info only when they change something. */
const FREQUENT_JOBS = new Set([
  'scene-index-whisparr-queue',
  'scene-index-library-projection',
  'scene-index-metadata-backfill',
  'scene-index-stash-availability',
  'scene-index-request-rows',
]);

const JOB_LABELS: Record<string, string> = {
  'scene-index-bootstrap': 'building the scene index',
  'scene-index-request-rows': 'syncing requests',
  'scene-index-whisparr-queue': 'syncing the Whisparr queue',
  'scene-index-whisparr-movies': 'syncing Whisparr movies',
  'scene-index-library-projection': 'syncing the Stash library',
  'scene-index-stash-availability': 'checking Stash for scenes',
  'scene-index-metadata-backfill': 'filling in scene details',
};

function jobLabel(jobName: string): string {
  return JOB_LABELS[jobName] ?? `job ${jobName}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
