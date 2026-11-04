import { Injectable } from '@nestjs/common';
import {
  IntegrationConfig,
  IntegrationStatus,
  IntegrationType,
  SyncJobStatus,
} from '@prisma/client';
import { statfs } from 'node:fs/promises';
import { runtimeHealthServiceForIntegration } from '../integrations/integration-runtime-health.util';
import { recentLogs, RecentLogs } from '../logging/recent-logs';
import { canSee } from '../organizer/folder-cleanup.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProwlarrAdapter } from '../providers/prowlarr/prowlarr.adapter';
import { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { RuntimeHealthService } from '../runtime-health/runtime-health.service';
import type { RuntimeHealthServiceSummary } from '../runtime-health/runtime-health.types';
import type {
  AboutResponse,
  DiskHealth,
  HealthResponse,
  IntegrationHealth,
  JobHealth,
} from './about.types';
import { resolveBuildInfo } from './build-info';
import { jobHeartbeats, JobHeartbeats } from './job-heartbeats';

/** A slow integration shows as not answering instead of holding up the page. */
const PROBE_TIMEOUT_MS = 8_000;

const LABELS: Record<IntegrationType, string> = {
  STASH: 'Stash',
  STASHDB: 'StashDB',
  FANSDB: 'FansDB',
  WHISPARR: 'Whisparr',
  PROWLARR: 'Prowlarr',
  SABNZBD: 'SABnzbd',
};
const ORDER: IntegrationType[] = [
  'STASH',
  'STASHDB',
  'FANSDB',
  'WHISPARR',
  'PROWLARR',
  'SABNZBD',
];

type StashConfig = { baseUrl: string; apiKey: string | null };

/**
 * About & health: which build is running, whether what Stashboard depends on
 * is working, and what went wrong lately. Every part stands alone: one that
 * can't be read says so, never failing the rest.
 */
@Injectable()
export class AboutService {
  /** Swapped in tests. */
  logs: RecentLogs = recentLogs;
  heartbeats: JobHeartbeats = jobHeartbeats;
  diskSpace: (path: string) => Promise<{ free: number; total: number }> =
    async (path) => {
      const stats = await statfs(path);
      return {
        free: stats.bavail * stats.bsize,
        total: stats.blocks * stats.bsize,
      };
    };
  see: (folder: string) => Promise<boolean> = canSee;
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeHealth: RuntimeHealthService,
    private readonly stash: StashAdapter,
    private readonly stashdb: StashdbAdapter,
    private readonly whisparr: WhisparrAdapter,
    private readonly prowlarr: ProwlarrAdapter,
    private readonly sabnzbd: SabnzbdAdapter,
  ) {}

  about(): AboutResponse {
    return {
      build: resolveBuildInfo(this.env),
      recentErrors: this.logs.list(),
    };
  }

  async health(): Promise<HealthResponse> {
    const configs = await this.prisma.integrationConfig
      .findMany()
      .catch(() => [] as IntegrationConfig[]);
    const configured = ORDER.map((type) =>
      configs.find((config) => config.type === type),
    ).filter(
      (config): config is IntegrationConfig =>
        !!config &&
        config.enabled &&
        config.status !== IntegrationStatus.NOT_CONFIGURED &&
        !!config.baseUrl?.trim(),
    );
    const stashConfig = configured.find((config) => config.type === 'STASH');

    const [database, integrations, disks, jobs] = await Promise.all([
      this.database(),
      this.integrations(configured),
      this.disks(stashConfig ? connection(stashConfig) : null),
      this.jobs(),
    ]);
    return {
      checkedAt: new Date().toISOString(),
      database,
      integrations,
      disks,
      jobs,
    };
  }

  // ---------- parts ----------

  private async database(): Promise<HealthResponse['database']> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  private async integrations(
    configs: IntegrationConfig[],
  ): Promise<IntegrationHealth[]> {
    const runtime = await this.runtimeHealth
      .getSummary()
      .then((summary) => summary.services)
      .catch(() => null);
    return Promise.all(
      configs.map(async (config) => {
        const now = new Date().toISOString();
        const recorded = lastRecordedError(
          config,
          runtimeSummaryFor(config.type, runtime),
        );
        try {
          await withTimeout(this.probe(config.type, connection(config)));
          return {
            type: config.type,
            label: LABELS[config.type],
            reachable: true,
            error: recorded?.message ?? null,
            errorAt: recorded?.at ?? null,
            lastOkAt: now,
          };
        } catch (error) {
          return {
            type: config.type,
            label: LABELS[config.type],
            reachable: false,
            error: messageOf(error),
            errorAt: now,
            lastOkAt: lastOk(config, runtimeSummaryFor(config.type, runtime)),
          };
        }
      }),
    );
  }

  /** The same connection test as Settings → Integrations, without saving anything. */
  private probe(type: IntegrationType, config: StashConfig): Promise<void> {
    switch (type) {
      case 'STASH':
        return this.stash.testConnection(config);
      case 'STASHDB':
      case 'FANSDB':
        return this.stashdb.testConnection(config);
      case 'WHISPARR':
        return this.whisparr.testConnection(config);
      case 'PROWLARR':
        return this.prowlarr.testConnection(config);
      case 'SABNZBD':
        return this.sabnzbd.testConnection(config);
    }
  }

  /** Stashboard's data folder, plus Stash's library folders Stashboard can see. */
  private async disks(stash: StashConfig | null): Promise<DiskHealth[]> {
    const folders: Array<{ label: string; path: string }> = [
      {
        label: 'Stashboard data',
        path: this.env.APP_DATA_DIR?.trim() || '/var/lib/stashboard',
      },
    ];
    const cache = this.env.MEDIA_CACHE_DIR?.trim();
    if (cache) {
      folders.push({ label: 'Image cache', path: cache });
    }
    const roots = stash
      ? await withTimeout(this.stash.getLibraryRoots(stash)).catch(
          () => [] as string[],
        )
      : [];
    for (const root of roots) {
      if (await this.see(root).catch(() => false)) {
        folders.push({ label: 'Library', path: root });
      }
    }
    return Promise.all(
      folders.map(async (folder) => {
        try {
          const { free, total } = await this.diskSpace(folder.path);
          return {
            ...folder,
            freeBytes: free,
            totalBytes: total,
            error: null,
          };
        } catch (error) {
          return {
            ...folder,
            freeBytes: null,
            totalBytes: null,
            error: messageOf(error),
          };
        }
      }),
    );
  }

  private async jobs(): Promise<JobHealth[]> {
    const [syncStates, automation, handoff] = await Promise.all([
      this.prisma.syncState.findMany().catch(() => null),
      this.prisma.libraryAutomationSettings
        .findUnique({ where: { key: 'GLOBAL' } })
        .catch(() => null),
      this.prisma.downloadHandoffSettings
        .findUnique({ where: { key: 'GLOBAL' } })
        .catch(() => null),
    ]);
    return [
      indexingJob(syncStates),
      {
        id: 'automation',
        label: 'After-import automation',
        ...(automation?.lastRunAt
          ? {
              status:
                automation.lastRunStatus === 'FAILED'
                  ? 'failed'
                  : automation.lastRunStatus === 'RUNNING'
                    ? 'running'
                    : 'ok',
              lastRunAt: automation.lastRunAt.toISOString(),
              message: automation.lastRunMessage,
            }
          : { status: 'never', lastRunAt: null, message: null }),
      },
      this.heartbeatJob('folder-watch', 'Library folder watcher'),
      handoff?.enabled
        ? this.heartbeatJob('download-watch', 'Finished downloads watcher')
        : {
            id: 'download-watch',
            label: 'Finished downloads watcher',
            status: 'off',
            lastRunAt: null,
            message: 'Finished downloads is off.',
          },
    ];
  }

  private heartbeatJob(
    id: 'folder-watch' | 'download-watch',
    label: string,
  ): JobHealth {
    const beat = this.heartbeats.get(id);
    return beat
      ? {
          id,
          label,
          status: beat.status,
          lastRunAt: beat.at,
          message: beat.message,
        }
      : { id, label, status: 'never', lastRunAt: null, message: null };
  }
}

/** One line for all the indexing jobs: the latest run, and any that failed. */
function indexingJob(
  states: Array<{
    jobName: string;
    status: SyncJobStatus;
    finishedAt: Date | null;
    lastError: string | null;
  }> | null,
): JobHealth {
  const base = { id: 'indexing', label: 'Indexing' };
  if (!states) {
    return {
      ...base,
      status: 'warn',
      lastRunAt: null,
      message: 'Couldn’t read the indexing jobs.',
    };
  }
  const finished = states
    .map((state) => state.finishedAt?.getTime() ?? 0)
    .reduce((latest, at) => Math.max(latest, at), 0);
  const lastRunAt = finished ? new Date(finished).toISOString() : null;
  const failed = states.filter(
    (state) => state.status === SyncJobStatus.FAILED,
  );
  if (failed.length > 0) {
    return {
      ...base,
      status: 'failed',
      lastRunAt,
      message: failed
        .map((state) => `${state.jobName}: ${state.lastError ?? 'failed'}`)
        .join('; '),
    };
  }
  if (states.some((state) => state.status === SyncJobStatus.RUNNING)) {
    return { ...base, status: 'running', lastRunAt, message: null };
  }
  return {
    ...base,
    status: lastRunAt ? 'ok' : 'never',
    lastRunAt,
    message: null,
  };
}

function runtimeSummaryFor(
  type: IntegrationType,
  services: Record<string, RuntimeHealthServiceSummary> | null,
): RuntimeHealthServiceSummary | null {
  const key = runtimeHealthServiceForIntegration(type);
  return key && services ? (services[key.toLowerCase()] ?? null) : null;
}

/** The newer of the last test's error and the last error while in use. */
function lastRecordedError(
  config: IntegrationConfig,
  runtime: RuntimeHealthServiceSummary | null,
): { message: string; at: string } | null {
  const candidates = [
    config.lastErrorMessage && config.lastErrorAt
      ? { message: config.lastErrorMessage, at: config.lastErrorAt }
      : null,
    runtime?.lastErrorMessage && runtime.lastFailureAt
      ? {
          message: runtime.lastErrorMessage,
          at: new Date(runtime.lastFailureAt),
        }
      : null,
  ].filter((entry): entry is { message: string; at: Date } => !!entry);
  const newest = candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  return newest
    ? { message: newest.message, at: newest.at.toISOString() }
    : null;
}

function lastOk(
  config: IntegrationConfig,
  runtime: RuntimeHealthServiceSummary | null,
): string | null {
  const times = [
    config.lastHealthyAt?.getTime() ?? 0,
    runtime?.lastHealthyAt ? new Date(runtime.lastHealthyAt).getTime() : 0,
  ];
  const newest = Math.max(...times);
  return newest ? new Date(newest).toISOString() : null;
}

function connection(config: IntegrationConfig): StashConfig {
  return { baseUrl: config.baseUrl!.trim(), apiKey: config.apiKey };
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`Didn’t answer within ${PROBE_TIMEOUT_MS / 1000} seconds.`),
        ),
      PROBE_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
