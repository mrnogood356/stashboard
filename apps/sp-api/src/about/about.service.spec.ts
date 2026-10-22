import { IntegrationConfig } from '@prisma/client';
import { RecentLogs } from '../logging/recent-logs';
import { PrismaService } from '../prisma/prisma.service';
import { ProwlarrAdapter } from '../providers/prowlarr/prowlarr.adapter';
import { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { RuntimeHealthService } from '../runtime-health/runtime-health.service';
import { AboutService } from './about.service';
import { JobHeartbeats } from './job-heartbeats';

function integration(
  type: IntegrationConfig['type'],
  overrides: Partial<IntegrationConfig> = {},
): IntegrationConfig {
  return {
    id: type,
    type,
    enabled: true,
    status: 'CONFIGURED',
    name: null,
    baseUrl: `http://${type.toLowerCase()}:1234`,
    apiKey: 'key',
    config: null,
    lastHealthyAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('AboutService', () => {
  let prisma: {
    $queryRaw: jest.Mock;
    integrationConfig: { findMany: jest.Mock };
    syncState: { findMany: jest.Mock };
    libraryAutomationSettings: { findUnique: jest.Mock };
    downloadHandoffSettings: { findUnique: jest.Mock };
  };
  let stash: { testConnection: jest.Mock; getLibraryRoots: jest.Mock };
  let whisparr: { testConnection: jest.Mock };
  let stashdb: { testConnection: jest.Mock };
  let prowlarr: { testConnection: jest.Mock };
  let sabnzbd: { testConnection: jest.Mock };
  let runtimeHealth: { getSummary: jest.Mock };
  let service: AboutService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      integrationConfig: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            integration('STASH'),
            integration('WHISPARR'),
            integration('PROWLARR', { enabled: false }),
            integration('SABNZBD', { status: 'NOT_CONFIGURED' }),
          ]),
      },
      syncState: { findMany: jest.fn().mockResolvedValue([]) },
      libraryAutomationSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      downloadHandoffSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    stash = {
      testConnection: jest.fn().mockResolvedValue(undefined),
      getLibraryRoots: jest.fn().mockResolvedValue(['/data', '/hidden']),
    };
    whisparr = {
      testConnection: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    stashdb = { testConnection: jest.fn() };
    prowlarr = { testConnection: jest.fn() };
    sabnzbd = { testConnection: jest.fn() };
    runtimeHealth = {
      getSummary: jest.fn().mockResolvedValue({
        services: {
          stash: {
            lastHealthyAt: null,
            lastFailureAt: '2026-10-20T10:00:00.000Z',
            lastErrorMessage: 'Stash timed out',
          },
        },
      }),
    };
    service = new AboutService(
      prisma as unknown as PrismaService,
      runtimeHealth as unknown as RuntimeHealthService,
      stash as unknown as StashAdapter,
      stashdb as unknown as StashdbAdapter,
      whisparr as unknown as WhisparrAdapter,
      prowlarr as unknown as ProwlarrAdapter,
      sabnzbd as unknown as SabnzbdAdapter,
    );
    service.env = { APP_DATA_DIR: '/appdata' };
    service.heartbeats = new JobHeartbeats();
    service.logs = new RecentLogs();
    service.see = jest.fn(async (folder: string) => folder !== '/hidden');
    service.diskSpace = jest.fn(async (path: string) => {
      if (path === '/appdata') {
        return { free: 5_000, total: 10_000 };
      }
      throw new Error('EACCES');
    });
  });

  it('returns the build and the recent errors', () => {
    service.env = {
      STASHBOARD_COMMIT: 'abcdef1234',
      STASHBOARD_BUILT_AT: 'dev',
    };
    service.logs.add('error', 'Sync failed', 'IndexingService');

    expect(service.about()).toMatchObject({
      build: { commit: 'abcdef1234', builtAt: null },
      recentErrors: [{ message: 'Sync failed', source: 'server' }],
    });
  });

  it('checks only the integrations that are set up, each on its own', async () => {
    const health = await service.health();

    expect(health.integrations).toEqual([
      expect.objectContaining({
        type: 'STASH',
        reachable: true,
        // Reachable now, with the last error it had while in use.
        error: 'Stash timed out',
        errorAt: '2026-10-20T10:00:00.000Z',
      }),
      expect.objectContaining({
        type: 'WHISPARR',
        reachable: false,
        error: 'ECONNREFUSED',
      }),
    ]);
    expect(prowlarr.testConnection).not.toHaveBeenCalled();
    expect(sabnzbd.testConnection).not.toHaveBeenCalled();
    expect(health.database).toEqual({ ok: true, error: null });
  });

  it('shows free space for the data folder and library folders it can see', async () => {
    const health = await service.health();

    expect(health.disks).toEqual([
      {
        label: 'Stashboard data',
        path: '/appdata',
        freeBytes: 5_000,
        totalBytes: 10_000,
        error: null,
      },
      {
        label: 'Library',
        path: '/data',
        freeBytes: null,
        totalBytes: null,
        error: 'EACCES',
      },
    ]);
  });

  it('reports the background jobs', async () => {
    prisma.syncState.findMany.mockResolvedValue([
      {
        jobName: 'scene-index-request-rows',
        status: 'SUCCEEDED',
        finishedAt: new Date('2026-10-20T09:00:00.000Z'),
        lastError: null,
      },
      {
        jobName: 'scene-index-whisparr-movies',
        status: 'FAILED',
        finishedAt: new Date('2026-10-20T09:30:00.000Z'),
        lastError: 'Whisparr down',
      },
    ]);
    prisma.libraryAutomationSettings.findUnique.mockResolvedValue({
      lastRunAt: new Date('2026-10-20T08:00:00.000Z'),
      lastRunStatus: 'DONE',
      lastRunMessage: 'Scanned 1 folder.',
    });
    prisma.downloadHandoffSettings.findUnique.mockResolvedValue({
      enabled: false,
    });
    service.heartbeats.record('folder-watch', 'ok', 'Watching 1 folder.');

    const { jobs } = await service.health();

    expect(jobs).toEqual([
      expect.objectContaining({
        id: 'indexing',
        status: 'failed',
        lastRunAt: '2026-10-20T09:30:00.000Z',
        message: 'scene-index-whisparr-movies: Whisparr down',
      }),
      expect.objectContaining({
        id: 'automation',
        status: 'ok',
        message: 'Scanned 1 folder.',
      }),
      expect.objectContaining({ id: 'folder-watch', status: 'ok' }),
      expect.objectContaining({ id: 'download-watch', status: 'off' }),
    ]);
  });

  it('fails soft when the database is down', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    prisma.integrationConfig.findMany.mockRejectedValue(new Error('db down'));
    prisma.syncState.findMany.mockRejectedValue(new Error('db down'));
    prisma.libraryAutomationSettings.findUnique.mockRejectedValue(
      new Error('db down'),
    );
    prisma.downloadHandoffSettings.findUnique.mockRejectedValue(
      new Error('db down'),
    );

    const health = await service.health();

    expect(health.database).toEqual({ ok: false, error: 'db down' });
    expect(health.integrations).toEqual([]);
    expect(health.jobs[0]).toMatchObject({ id: 'indexing', status: 'warn' });
    expect(health.disks[0]).toMatchObject({ freeBytes: 5_000 });
  });
});
