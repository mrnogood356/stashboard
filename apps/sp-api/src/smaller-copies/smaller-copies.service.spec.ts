import { Logger } from '@nestjs/common';
import type { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import type { DownloadsService } from '../downloads/downloads.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import { SmallerCopiesService } from './smaller-copies.service';

describe('SmallerCopiesService', () => {
  let settings: Record<string, unknown>;
  let attempts: Map<string, Record<string, unknown>>;
  let files: Array<Record<string, unknown>>;
  let linked: Record<string, string | null>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let downloads: { searchReleases: jest.Mock; grabRelease: jest.Mock };
  let handoff: { stashConfig: jest.Mock; isActive: jest.Mock };
  let stash: { listLibraryFiles: jest.Mock };
  let service: SmallerCopiesService;
  let now: number;

  const release = (overrides: Record<string, unknown> = {}) => ({
    guid: 'g1',
    indexerId: 3,
    title: 'Studio.Scene.1080p.x265',
    size: 2e9,
    protocol: 'usenet',
    match: { strength: 'strong' },
    ...overrides,
  });
  const file = (sceneId: string, overrides: Record<string, unknown> = {}) => ({
    sceneId,
    title: `Scene ${sceneId}`,
    studioId: null,
    studioName: 'Jane Studio',
    size: 8e9,
    width: 3840,
    height: 2160,
    codec: 'h264',
    duration: 1800,
    ...overrides,
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    now = new Date(2026, 10, 5, 12, 0).getTime();
    settings = {
      key: 'GLOBAL',
      enabled: true,
      targetResolution: '1080p',
      replaceHigher: true,
      upgradeLower: false,
      maxFileSizeGb: null,
      minFileSizeGb: null,
      maxNewGbPerHour: null,
      minSavingsPercent: 10,
      codec: 'any',
      prefer: 'largest',
      matchStrength: 'strong',
      studioMode: 'all',
      studioNames: [],
      autoGrab: true,
      oldCopy: 'delete',
      scenesPerHour: 10,
      activeFromHour: null,
      activeToHour: null,
      savedBytes: 0,
      replacedCount: 0,
    };
    attempts = new Map();
    files = [
      file('1'),
      file('2', { size: 9e9 }),
      file('3', { width: 1920, height: 1080 }),
    ];
    linked = { '1': 'cat-1', '2': 'cat-2' };
    prisma = {
      smallerCopySettings: {
        upsert: jest.fn(({ update }: { update: Record<string, unknown> }) => {
          Object.assign(settings, update);
          return Promise.resolve({ ...settings });
        }),
      },
      smallerCopyAttempt: {
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { stashSceneId: string };
            data: { grabbedGuids: { push: string } };
          }) => {
            const row = attempts.get(where.stashSceneId);
            if (!row) {
              return Promise.reject(new Error('not found'));
            }
            row.grabbedGuids = [
              ...((row.grabbedGuids as string[]) ?? []),
              data.grabbedGuids.push,
            ];
            return Promise.resolve();
          },
        ),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          attempts.set(data.stashSceneId as string, data);
          return Promise.resolve();
        }),
        upsert: jest.fn(
          ({
            where,
            update,
          }: {
            where: { stashSceneId: string };
            update: Record<string, unknown>;
          }) => {
            attempts.set(where.stashSceneId, {
              grabbedGuids: [],
              ...attempts.get(where.stashSceneId),
              stashSceneId: where.stashSceneId,
              ...update,
            });
            return Promise.resolve();
          },
        ),
        findMany: jest.fn(
          ({ where }: { where?: { retryAfter?: { gt: Date } } } = {}) =>
            Promise.resolve(
              [...attempts.values()].filter(
                (row) =>
                  !where?.retryAfter ||
                  (row.retryAfter as Date) > where.retryAfter.gt,
              ),
            ),
        ),
        findUnique: jest.fn(({ where }: { where: { stashSceneId: string } }) =>
          Promise.resolve(attempts.get(where.stashSceneId) ?? null),
        ),
      },
      librarySceneIndex: {
        findUnique: jest.fn(({ where }: { where: { stashSceneId: string } }) =>
          Promise.resolve({
            linkedStashId: linked[where.stashSceneId] ?? null,
          }),
        ),
      },
      downloadHandoff: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 'h9' }),
      },
    };
    downloads = {
      searchReleases: jest.fn().mockResolvedValue({ releases: [release()] }),
      grabRelease: jest.fn().mockResolvedValue({
        accepted: true,
        sentTo: 'sabnzbd',
        handoffId: 'h9',
      }),
    };
    handoff = {
      stashConfig: jest
        .fn()
        .mockResolvedValue({ baseUrl: 'http://stash:9999' }),
      isActive: jest.fn().mockResolvedValue(true),
    };
    stash = { listLibraryFiles: jest.fn(() => Promise.resolve(files)) };
    const catalog = {
      getInstanceCatalogProvider: jest
        .fn()
        .mockResolvedValue({ providerKey: 'STASHDB' }),
    };
    service = new SmallerCopiesService(
      prisma as unknown as PrismaService,
      downloads as unknown as DownloadsService,
      handoff as unknown as DownloadHandoffService,
      catalog as unknown as CatalogProviderService,
      stash as unknown as StashAdapter,
    );
    service.now = () => now;
  });

  it('searches the biggest file first, grabs the match and says it replaces that scene', async () => {
    await service.tick();

    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);
    expect(downloads.searchReleases).toHaveBeenCalledWith('cat-2', 'STASHDB');
    expect(downloads.grabRelease).toHaveBeenCalledWith(
      'cat-2',
      { guid: 'g1', indexerId: 3, title: 'Studio.Scene.1080p.x265' },
      'STASHDB',
      { replacesStashSceneId: '2' },
    );
    expect(attempts.get('2')).toMatchObject({
      outcome: 'grabbed',
      handoffId: 'h9',
    });
    // Scene 3 is already 1080p, so it's no candidate.
    expect((await service.status()).candidates).toBe(2);
  });

  it('searches no faster than the hourly limit', async () => {
    await service.tick();
    now += 5 * 60_000;
    await service.tick();
    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);

    now += 2 * 60_000;
    await service.tick();
    expect(downloads.searchReleases).toHaveBeenCalledTimes(2);
    expect(downloads.searchReleases).toHaveBeenLastCalledWith(
      'cat-1',
      'STASHDB',
    );
  });

  it('skips scenes not linked to the catalog without using a search', async () => {
    linked = { '1': 'cat-1' };
    await service.tick();

    expect(attempts.get('2')?.outcome).toBe('no-catalog-id');
    expect(downloads.searchReleases).toHaveBeenCalledWith('cat-1', 'STASHDB');
  });

  it('notes when nothing fits, and leaves the scene for a week', async () => {
    downloads.searchReleases.mockResolvedValue({
      releases: [release({ title: 'Studio.Scene.2160p', size: 9e9 })],
    });
    await service.tick(true);

    expect(attempts.get('2')).toMatchObject({ outcome: 'none-found' });
    expect(downloads.grabRelease).not.toHaveBeenCalled();
    expect((attempts.get('2')!.retryAfter as Date).getTime()).toBe(
      now + 7 * 24 * 3600_000,
    );
  });

  it('lists a match without grabbing when grabbing by itself is off, and grabs it when asked', async () => {
    settings.autoGrab = false;
    await service.tick();

    expect(downloads.grabRelease).not.toHaveBeenCalled();
    const status = await service.status();
    expect(status.recent[0]).toMatchObject({
      stashSceneId: '2',
      outcome: 'found',
      canGrab: true,
    });

    await service.grabListed('2');
    expect(downloads.grabRelease).toHaveBeenCalledWith(
      'cat-2',
      { guid: 'g1', indexerId: 3, title: 'Studio.Scene.1080p.x265' },
      'STASHDB',
      { replacesStashSceneId: '2' },
    );
    expect(attempts.get('2')?.outcome).toBe('grabbed');
  });

  it('only searches in the hours allowed, unless asked to now', async () => {
    settings.activeFromHour = 1;
    settings.activeToHour = 6;
    await service.tick();
    expect(downloads.searchReleases).not.toHaveBeenCalled();

    await service.tick(true);
    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);
  });

  it('shows the space given back so far', async () => {
    settings.savedBytes = 12.5e9;
    settings.replacedCount = 3;
    expect((await service.status()).saved).toEqual({
      bytes: 12.5e9,
      scenes: 3,
    });
  });

  it('does nothing while off or without Finished downloads, saying why', async () => {
    handoff.isActive.mockResolvedValue(false);
    await service.tick(true);
    expect(downloads.searchReleases).not.toHaveBeenCalled();
    expect((await service.status()).blocked).toContain('Finished downloads');

    settings.enabled = false;
    expect((await service.status()).blocked).toBe('Off.');
  });

  it('keeps only the studios listed, or leaves them out', async () => {
    files = [
      file('1', { studioName: 'Jane Studio' }),
      file('2', { studioName: 'Other' }),
    ];
    settings.studioMode = 'only';
    settings.studioNames = ['jane studio'];
    expect((await service.status()).candidates).toBe(1);

    service['files'] = null;
    settings.studioMode = 'skip';
    await service.tick();
    expect(downloads.searchReleases).toHaveBeenCalledWith('cat-2', 'STASHDB');
  });

  it('notes a failed search and tries it again a day later', async () => {
    downloads.searchReleases.mockRejectedValue(new Error('Prowlarr is down'));
    await service.tick();

    expect(attempts.get('2')).toMatchObject({
      outcome: 'failed',
      detail: 'Prowlarr is down',
    });
  });

  it('cleans up what it saves', async () => {
    await service.saveSettings({
      ...(await service.status()).settings,
      scenesPerHour: 500,
      minSavingsPercent: -5,
      maxNewGbPerHour: 0,
      activeFromHour: 25,
      codec: 'nonsense' as never,
      studioNames: [' A ', 'A', ''],
    });
    expect(settings).toMatchObject({
      scenesPerHour: 60,
      minSavingsPercent: 0,
      maxNewGbPerHour: null,
      activeFromHour: 23,
      codec: 'any',
      studioNames: ['A'],
    });
  });

  it('never grabs the same release again for a scene, so a kept old file isn’t replaced twice', async () => {
    attempts.set('2', {
      stashSceneId: '2',
      outcome: 'kept-both',
      releaseGuid: 'g1',
      grabbedGuids: ['g1'],
      retryAfter: new Date(now - 1),
    });
    downloads.searchReleases.mockResolvedValue({
      releases: [
        release(),
        release({ guid: 'g2', title: 'Studio.Scene.1080p.HEVC' }),
      ],
    });
    await service.tick();
    expect(downloads.grabRelease).toHaveBeenCalledWith(
      'cat-2',
      expect.objectContaining({ guid: 'g2' }),
      'STASHDB',
      { replacesStashSceneId: '2' },
    );
    expect(attempts.get('2')).toMatchObject({
      outcome: 'grabbed',
      releaseGuid: 'g2',
    });
  });

  it('remembers a grabbed release through later searches that find nothing', async () => {
    downloads.searchReleases.mockResolvedValue({ releases: [release()] });
    await service.tick(true);
    expect(attempts.get('2')).toMatchObject({
      outcome: 'grabbed',
      grabbedGuids: ['g1'],
    });

    // A month on, only the same release is out there: nothing new to grab.
    now += 31 * 24 * 3600_000;
    downloads.grabRelease.mockClear();
    await service.tick(true);
    expect(attempts.get('2')).toMatchObject({
      outcome: 'none-found',
      grabbedGuids: ['g1'],
    });

    // A week after that, still not grabbed again.
    now += 8 * 24 * 3600_000;
    await service.tick(true);
    expect(downloads.grabRelease).not.toHaveBeenCalledWith(
      'cat-2',
      expect.objectContaining({ guid: 'g1' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('searches no more for a scene while its replacement is still downloading', async () => {
    prisma.downloadHandoff.findMany.mockResolvedValue([
      { replacesStashSceneId: '2' },
    ]);
    await service.tick(true);
    // Scene 2 is skipped (its copy is on its way); the next one is searched.
    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);
    expect(downloads.searchReleases).toHaveBeenCalledWith('cat-1', 'STASHDB');
    expect(prisma.downloadHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['sent', 'downloading', 'completed'] },
        }) as unknown,
      }),
    );
  });

  it('searches nothing when it can’t tell which replacements are on their way', async () => {
    prisma.downloadHandoff.findMany.mockRejectedValue(new Error('db down'));
    await service.tick(true);
    expect(downloads.searchReleases).not.toHaveBeenCalled();
  });
});
