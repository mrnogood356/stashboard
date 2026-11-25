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
  let tries: Array<Record<string, unknown>>;
  let handoffRows: Array<{
    id: string;
    status: string;
    error: string | null;
    replacesStashSceneId?: string;
    stashSceneId?: string;
  }>;
  let files: Array<Record<string, unknown>>;
  let linked: Record<string, string | null>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let transaction: jest.Mock;
  let downloads: {
    searchReleases: jest.Mock;
    grabRelease: jest.Mock;
    rememberedTitle: jest.Mock;
  };
  let handoff: {
    stashConfig: jest.Mock;
    isActive: jest.Mock;
    failedReleases: jest.Mock;
  };
  let stash: { listLibraryFiles: jest.Mock; getJobQueue: jest.Mock };
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
    tries = [];
    handoffRows = [];
    files = [
      file('1'),
      file('2', { size: 9e9 }),
      file('3', { width: 1920, height: 1080 }),
    ];
    linked = { '1': 'cat-1', '2': 'cat-2' };
    // Runs each write in turn; a real one would undo both on a failure.
    transaction = jest.fn((writes: Array<Promise<unknown>>) =>
      Promise.all(writes),
    );
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
          ({
            where,
          }: {
            where?: {
              retryAfter?: { gt: Date };
              outcome?: string | { in: string[] };
            };
          } = {}) =>
            Promise.resolve(
              [...attempts.values()].filter(
                (row) =>
                  (!where?.retryAfter ||
                    (row.retryAfter as Date) > where.retryAfter.gt) &&
                  (where?.outcome === undefined ||
                    (typeof where.outcome === 'string'
                      ? row.outcome === where.outcome
                      : where.outcome.in.includes(row.outcome as string))),
              ),
            ),
        ),
        findUnique: jest.fn(({ where }: { where: { stashSceneId: string } }) =>
          Promise.resolve(attempts.get(where.stashSceneId) ?? null),
        ),
        count: jest.fn(
          ({
            where,
          }: {
            where: { outcome?: string; retryAfter?: { gt: Date } };
          }) =>
            Promise.resolve(
              [...attempts.values()].filter(
                (row) =>
                  (where.outcome === undefined ||
                    row.outcome === where.outcome) &&
                  (!where.retryAfter ||
                    (row.retryAfter as Date) > where.retryAfter.gt),
              ).length,
            ),
        ),
        findFirst: jest.fn(({ where }: { where: { handoffId: string } }) =>
          Promise.resolve(
            [...attempts.values()].find(
              (row) => row.handoffId === where.handoffId,
            ) ?? null,
          ),
        ),
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: {
              stashSceneId?: string;
              retryAfter?: { gt: Date };
              outcome?: { not: string } | { notIn: string[] } | string;
              handoffId?: string;
            };
            data: Record<string, unknown>;
          }) => {
            let count = 0;
            for (const row of attempts.values()) {
              const outcome = where.outcome;
              if (
                (where.stashSceneId === undefined ||
                  row.stashSceneId === where.stashSceneId) &&
                (!where.retryAfter ||
                  (row.retryAfter as Date) > where.retryAfter.gt) &&
                (outcome === undefined ||
                  (typeof outcome === 'string'
                    ? row.outcome === outcome
                    : 'notIn' in outcome
                      ? !outcome.notIn.includes(row.outcome as string)
                      : row.outcome !== outcome.not)) &&
                (where.handoffId === undefined ||
                  row.handoffId === where.handoffId)
              ) {
                Object.assign(row, data);
                count += 1;
              }
            }
            return Promise.resolve({ count });
          },
        ),
      },
      smallerCopyTry: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          tries.push({
            id: `t${tries.length + 1}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          });
          return Promise.resolve();
        }),
        findMany: jest.fn(
          ({
            where,
          }: { where?: { outcome?: string; stashSceneId?: string } } = {}) =>
            Promise.resolve(
              [...tries]
                .reverse()
                .filter(
                  (row) =>
                    (!where?.outcome || row.outcome === where.outcome) &&
                    (!where?.stashSceneId ||
                      row.stashSceneId === where.stashSceneId),
                ),
            ),
        ),
        updateMany: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string; outcome?: string };
            data: Record<string, unknown>;
          }) => {
            const row = tries.find(
              (entry) =>
                entry.id === where.id &&
                (!where.outcome || entry.outcome === where.outcome),
            );
            if (row) {
              Object.assign(row, data);
            }
            return Promise.resolve({ count: row ? 1 : 0 });
          },
        ),
        groupBy: jest.fn(() => {
          const counts = new Map<string, number>();
          for (const row of tries) {
            const outcome = row.outcome as string;
            counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
          }
          return Promise.resolve(
            [...counts].map(([outcome, count]) => ({
              outcome,
              _count: { _all: count },
            })),
          );
        }),
      },
      librarySceneIndex: {
        findUnique: jest.fn(({ where }: { where: { stashSceneId: string } }) =>
          Promise.resolve({
            linkedStashId: linked[where.stashSceneId] ?? null,
          }),
        ),
      },
      downloadHandoff: {
        // Open replacements for dueOf; by id for settling the tried list.
        findMany: jest.fn(
          ({
            where,
          }: {
            where: { id?: { in: string[] }; status?: { in: string[] } };
          }) =>
            Promise.resolve(
              where.id
                ? handoffRows.filter((row) => where.id!.in.includes(row.id))
                : handoffRows.filter(
                    (row) =>
                      row.replacesStashSceneId &&
                      (!where.status || where.status.in.includes(row.status)),
                  ),
            ),
        ),
        findFirst: jest.fn().mockResolvedValue({ id: 'h9' }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    downloads = {
      searchReleases: jest.fn().mockResolvedValue({ releases: [release()] }),
      grabRelease: jest.fn().mockResolvedValue({
        accepted: true,
        sentTo: 'sabnzbd',
        handoffId: 'h9',
      }),
      rememberedTitle: jest.fn(
        (_indexerId: number, guid: string) =>
          ({ big: 'Studio.Scene.1080p', x: 'Studio.Scene.1080p', y: 'Other' })[
            guid
          ] ?? null,
      ),
    };
    handoff = {
      stashConfig: jest
        .fn()
        .mockResolvedValue({ baseUrl: 'http://stash:9999' }),
      isActive: jest.fn().mockResolvedValue(true),
      failedReleases: jest.fn().mockResolvedValue(new Map()),
    };
    stash = {
      listLibraryFiles: jest.fn(() => Promise.resolve(files)),
      getJobQueue: jest.fn().mockResolvedValue([]),
    };
    const catalog = {
      getInstanceCatalogProvider: jest
        .fn()
        .mockResolvedValue({ providerKey: 'STASHDB' }),
    };
    service = new SmallerCopiesService(
      { ...prisma, $transaction: transaction } as unknown as PrismaService,
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

  it('searches nothing while Stash is behind, or two replacements are still coming in', async () => {
    stash.getJobQueue.mockResolvedValue([{ id: '1', status: 'READY' }]);
    await service.tick();
    expect(downloads.searchReleases).not.toHaveBeenCalled();

    stash.getJobQueue.mockResolvedValue([{ id: '1', status: 'RUNNING' }]);
    prisma.downloadHandoff.count.mockResolvedValue(2);
    await service.tick();
    expect(downloads.searchReleases).not.toHaveBeenCalled();

    // One coming in, for another scene than the one searched.
    prisma.downloadHandoff.count.mockImplementation(
      ({ where }: { where: { replacesStashSceneId?: unknown } }) =>
        Promise.resolve(typeof where.replacesStashSceneId === 'string' ? 0 : 1),
    );
    await service.tick();
    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);
  });

  it('leaves a scene alone in the background while its replacement is on its way', async () => {
    settings.autoGrab = false;
    files = [file('2', { size: 9e9 })];
    prisma.downloadHandoff.count.mockImplementation(
      ({ where }: { where: { replacesStashSceneId?: unknown } }) =>
        Promise.resolve(where.replacesStashSceneId === '2' ? 1 : 0),
    );
    await service.tick(true);
    // Not searched, so nothing written over the replacement's record.
    expect(downloads.searchReleases).not.toHaveBeenCalled();
  });

  it('writes nothing over a replacement on its way, even unlinked or when it can’t check', async () => {
    files = [file('2', { size: 9e9 })];
    linked = {};
    prisma.downloadHandoff.count.mockImplementation(
      ({ where }: { where: { replacesStashSceneId?: unknown } }) =>
        Promise.resolve(where.replacesStashSceneId === '2' ? 1 : 0),
    );
    await service.tick(true);
    expect(prisma.smallerCopyAttempt.upsert).not.toHaveBeenCalled();

    prisma.downloadHandoff.count.mockImplementation(
      ({ where }: { where: { replacesStashSceneId?: unknown } }) =>
        where.replacesStashSceneId === '2'
          ? Promise.reject(new Error('db down'))
          : Promise.resolve(0),
    );
    await service.tick(true);
    expect(prisma.smallerCopyAttempt.upsert).not.toHaveBeenCalled();
  });

  it('doesn’t send a replacement in the background for a scene you’re replacing', async () => {
    // Scene 2 is the one the background search would pick.
    files = [file('2', { size: 9e9 })];
    // You chose a release for scene 2; it's still being sent.
    let finish: () => void = () => undefined;
    downloads.grabRelease.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ accepted: true, sentTo: 'sabnzbd', handoffId: 'h9' });
        }),
    );
    const chosen = service.grabChosen('2', {
      guid: 'big',
      indexerId: 3,
      title: 'Studio.Scene.1080p',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await service.tick(true);
    finish();
    await chosen;
    // Only yours was sent.
    expect(downloads.grabRelease).toHaveBeenCalledTimes(1);
    await expect(service.grabListed('2')).rejects.toThrow();
  });

  it('Search now still searches while Stash is busy, and says why when it can’t', async () => {
    stash.getJobQueue.mockResolvedValue([{ id: '1', status: 'READY' }]);
    await expect(service.tick()).resolves.toBe(
      'Stash has jobs waiting in its queue.',
    );
    expect(downloads.searchReleases).not.toHaveBeenCalled();

    // A tap: searching only asks Prowlarr, so a busy Stash doesn't stop it.
    await expect(service.tick(true)).resolves.toBeNull();
    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);

    // Replacements still coming in hold even a tap back, with the reason.
    prisma.downloadHandoff.count.mockResolvedValue(2);
    await expect(service.tick(true)).resolves.toContain(
      '2 replacements are still on their way in',
    );
    expect(downloads.searchReleases).toHaveBeenCalledTimes(1);
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

  it('won’t grab a listed match that failed in SABnzbd since, and looks again', async () => {
    settings.autoGrab = false;
    await service.tick();
    downloads.searchReleases.mockResolvedValue({
      releases: [release({ failedBefore: 'Out of retention.' })],
    });

    await expect(service.grabListed('2')).rejects.toThrow(
      'SABnzbd couldn’t download that release before (Out of retention.)',
    );
    expect(downloads.grabRelease).not.toHaveBeenCalled();
    expect(attempts.get('2')).toMatchObject({ outcome: 'none-found' });
    const attempt = attempts.get('2') as { retryAfter: Date } | undefined;
    expect(attempt?.retryAfter.getTime()).toBeLessThanOrEqual(now);
  });

  it('won’t grab a listed match the fresh search no longer finds if it failed since', async () => {
    settings.autoGrab = false;
    await service.tick();
    downloads.searchReleases.mockResolvedValue({ releases: [] });
    handoff.failedReleases.mockResolvedValueOnce(
      new Map([['studio.scene.1080p.x265', 'Aborted.']]),
    );

    await expect(service.grabListed('2')).rejects.toThrow(
      'SABnzbd couldn’t download that release before (Aborted.)',
    );
    expect(handoff.failedReleases).toHaveBeenCalledWith([
      'Studio.Scene.1080p.x265',
    ]);
    expect(downloads.grabRelease).not.toHaveBeenCalled();
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

  it('grabs nothing when it can’t read what was tried before, and tries again later', async () => {
    const tried = prisma.smallerCopyTry.findMany.getMockImplementation()!;
    // Only the lookup of what was tried for the scene fails.
    prisma.smallerCopyTry.findMany.mockImplementation(
      (args: { select?: { releaseTitle?: boolean } } = {}) =>
        args.select?.releaseTitle
          ? Promise.reject(new Error('database down'))
          : tried(args),
    );
    await service.tick();

    expect(downloads.grabRelease).not.toHaveBeenCalled();
    expect(attempts.get('2')).toMatchObject({
      outcome: 'failed',
      detail: 'database down',
    });
  });

  it('grabs nothing when it can’t read which releases failed in SABnzbd, and tries again later', async () => {
    handoff.failedReleases.mockRejectedValueOnce(new Error('database down'));
    await service.tick();

    expect(downloads.grabRelease).not.toHaveBeenCalled();
    expect(attempts.get('2')).toMatchObject({
      outcome: 'failed',
      detail: 'database down',
    });
  });

  it('skips a release SABnzbd failed even when the search didn’t mark it', async () => {
    downloads.searchReleases.mockResolvedValue({
      releases: [
        release({ guid: 'g1', title: 'Studio.Scene.1080p.x265' }),
        release({ guid: 'g2', title: 'Studio.Scene.1080p.HEVC' }),
      ],
    });
    handoff.failedReleases.mockResolvedValueOnce(
      new Map([['studio.scene.1080p.x265', 'Aborted.']]),
    );
    await service.tick();
    expect(downloads.grabRelease).toHaveBeenCalledWith(
      'cat-2',
      expect.objectContaining({ guid: 'g2' }),
      'STASHDB',
      { replacesStashSceneId: '2' },
    );
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

  it('skips a release tried before under a new guid, or one that failed in SABnzbd', async () => {
    tries.push({
      id: 't0',
      stashSceneId: '2',
      title: 'Scene 2',
      releaseTitle: 'Studio.Scene.1080p.x265',
      outcome: 'failed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    downloads.searchReleases.mockResolvedValue({
      releases: [
        // The same release the indexer now lists under another guid.
        release({ guid: 'g9', title: 'studio.scene.1080p.X265' }),
        release({
          guid: 'g3',
          title: 'Studio.Scene.1080p.AV1',
          failedBefore: 'RAR files failed to verify.',
        }),
        release({ guid: 'g2', title: 'Studio.Scene.1080p.HEVC' }),
      ],
    });
    await service.tick();
    expect(downloads.grabRelease).toHaveBeenCalledTimes(1);
    expect(downloads.grabRelease).toHaveBeenCalledWith(
      'cat-2',
      expect.objectContaining({ guid: 'g2' }),
      'STASHDB',
      { replacesStashSceneId: '2' },
    );
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

  it('keeps every release it grabs in the tried list, with counts, through later searches', async () => {
    await service.tick(true);
    // Its download is still going a month on.
    handoffRows.push({
      id: 'h9',
      status: 'downloading',
      error: null,
      replacesStashSceneId: '2',
    });
    now += 31 * 24 * 3600_000;
    downloads.searchReleases.mockResolvedValue({ releases: [] });
    await service.tick(true);

    const status = await service.status();
    expect(status.tries).toEqual([
      expect.objectContaining({
        stashSceneId: '2',
        releaseTitle: 'Studio.Scene.1080p.x265',
        outcome: 'grabbed',
      }),
    ]);
    expect(status.tryCounts).toEqual({ grabbed: 1 });
    // Its scene isn't searched again while the download is on its way;
    // the later search went to another scene.
    expect(attempts.get('2')).toMatchObject({ outcome: 'grabbed' });
    expect(attempts.get('1')).toMatchObject({ outcome: 'none-found' });
  });

  it('settles a grab whose download was dropped: failed, release kept skipped, scene due again', async () => {
    await service.tick(true);
    expect(attempts.get('2')).toMatchObject({
      outcome: 'grabbed',
      handoffId: 'h9',
    });
    const dueBefore = (await service.status()).due;

    // SABnzbd forgot the job: Finished downloads stopped watching it.
    handoffRows.push({ id: 'h9', status: 'ignored', error: null });
    const status = await service.status();

    expect(status.tries[0]).toMatchObject({
      outcome: 'failed',
      detail: expect.stringContaining('stopped watching') as unknown,
    });
    expect(status.tryCounts).toEqual({ failed: 1 });
    expect(attempts.get('2')).toMatchObject({
      outcome: 'failed',
      grabbedGuids: ['g1'],
    });
    expect(status.due).toBe(dueBefore + 1);
  });

  it('takes the recorded outcome for a grab whose download came in', async () => {
    await service.tick(true);
    attempts.get('2')!.outcome = 'replaced';
    attempts.get('2')!.detail = 'Deleted /lib/old.mkv.';
    handoffRows.push({ id: 'h9', status: 'imported', error: null });
    expect((await service.status()).tries[0]).toMatchObject({
      outcome: 'replaced',
      detail: 'Deleted /lib/old.mkv.',
    });
  });

  it('settles a dropped grab and its scene together, in one transaction', async () => {
    await service.tick(true);
    handoffRows.push({ id: 'h9', status: 'failed', error: 'Out of retention' });
    await service.status();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tries[0]).toMatchObject({ outcome: 'failed' });
    expect(attempts.get('2')).toMatchObject({ outcome: 'failed' });
  });

  it('doesn’t overwrite a try another call settled in the meantime', async () => {
    await service.tick(true);
    handoffRows.push({ id: 'h9', status: 'imported', error: null });
    // While this one reads the scene's row, the swap is recorded elsewhere.
    prisma.smallerCopyAttempt.findFirst.mockImplementationOnce(() => {
      tries[0].outcome = 'replaced';
      return Promise.resolve(null);
    });
    await service.status();
    expect(tries[0]).toMatchObject({ outcome: 'replaced' });
  });

  it('leaves a grab whose download is still on its way', async () => {
    await service.tick(true);
    handoffRows.push({
      id: 'h9',
      status: 'downloading',
      error: null,
      replacesStashSceneId: '2',
    });
    expect((await service.status()).tries[0]).toMatchObject({
      outcome: 'grabbed',
    });
  });

  it('looks at a scene again on the next search when asked, still skipping releases tried', async () => {
    await service.tick(true);
    downloads.searchReleases.mockResolvedValue({ releases: [] });
    now += 31 * 24 * 3600_000;
    await service.tick(true);
    expect((await service.status()).due).toBe(1);
    await service.tick(true);
    expect((await service.status()).due).toBe(0);

    await service.recheck('2');
    expect((await service.status()).due).toBe(1);

    downloads.searchReleases.mockResolvedValue({ releases: [release()] });
    downloads.grabRelease.mockClear();
    await service.tick(true);
    expect(downloads.grabRelease).not.toHaveBeenCalled();
    await expect(service.recheck('nope')).rejects.toThrow('looked at');
  });

  it('looks at every scene again when asked, leaving matches waiting for you alone', async () => {
    settings.autoGrab = false;
    downloads.searchReleases.mockResolvedValue({ releases: [] });
    await service.tick(true);
    expect(attempts.get('2')).toMatchObject({ outcome: 'none-found' });
    downloads.searchReleases.mockResolvedValue({ releases: [release()] });
    await service.tick(true);
    expect(attempts.get('1')).toMatchObject({ outcome: 'found' });
    const before = (await service.status()).due;

    const status = await service.recheckAll();
    // Scene 2 is due again; the match listed for scene 1 stays listed.
    expect(status.due).toBe(before + 1);
    expect(attempts.get('1')).toMatchObject({ outcome: 'found' });
    expect((attempts.get('1')!.retryAfter as Date).getTime()).toBeGreaterThan(
      now,
    );
  });

  it('looks again from a failed try only while that failure is the scene’s latest', async () => {
    downloads.grabRelease.mockRejectedValueOnce(new Error('indexer said no'));
    await service.tick(true);
    const failed = [...attempts.values()].find(
      (row) => row.outcome === 'failed',
    )!;
    const id = failed.stashSceneId as string;
    await service.recheck(id, true);
    expect((failed.retryAfter as Date).getTime()).toBe(now);

    // A later try kept both copies: the old failed row mustn't undo that.
    failed.outcome = 'kept-both';
    const later = new Date(now + 86_400_000);
    failed.retryAfter = later;
    await expect(service.recheck(id, true)).rejects.toThrow(
      'latest try didn’t fail (kept-both)',
    );
    expect(failed.retryAfter).toBe(later);
  });

  it('looks again at only the scenes whose last try failed, when asked', async () => {
    // The first scene searched has its grab fail; the next finds nothing.
    downloads.grabRelease.mockRejectedValueOnce(new Error('indexer said no'));
    await service.tick(true);
    downloads.searchReleases.mockResolvedValue({ releases: [] });
    await service.tick(true);
    const rows = [...attempts.values()];
    const failed = rows.find((row) => row.outcome === 'failed')!;
    const nothing = rows.find((row) => row.outcome === 'none-found')!;
    expect(failed).toBeDefined();
    expect(nothing).toBeDefined();
    expect((await service.status()).failed).toBe(1);
    const before = (await service.status()).due;

    const status = await service.recheckFailed();

    // Only the failed one is due again; the other keeps its wait.
    expect(status.due).toBe(before + 1);
    expect((failed.retryAfter as Date).getTime()).toBe(now);
    expect((nothing.retryAfter as Date).getTime()).toBeGreaterThan(now);
  });

  it('searches a failed scene before a bigger one not tried yet', async () => {
    // Scene 2 (9 GB) would go first; scene 1 (8 GB) failed, so it goes first.
    attempts.set('1', {
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'failed',
      searchedAt: new Date(now - 86_400_000),
      retryAfter: new Date(now),
    });
    downloads.searchReleases.mockResolvedValue({ releases: [] });
    await service.tick(true);
    expect(downloads.searchReleases.mock.calls[0]?.[0]).toBe('cat-1');
    expect(attempts.get('1')?.outcome).toBe('none-found');
    // Then the usual order: the bigger one.
    await service.tick(true);
    expect(downloads.searchReleases.mock.calls[1]?.[0]).toBe('cat-2');
  });

  it('leaves a match found in the meantime as it is', async () => {
    tries.push({
      id: 'f3',
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'failed',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    attempts.set('1', {
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'found',
      searchedAt: new Date(now),
      retryAfter: new Date(now + 86_400_000),
    });
    await service.recheckFailed();
    expect(attempts.get('1')?.outcome).toBe('found');
  });

  it('checks again a scene on the Failed list even after a search since found nothing', async () => {
    // Its download failed (the latest try), then a search found nothing.
    tries.push({
      id: 'f1',
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'failed',
      detail: 'The download failed.',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    attempts.set('1', {
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'none-found',
      searchedAt: new Date(now),
      retryAfter: new Date(now + 7 * 86_400_000),
    });
    expect((await service.status()).failed).toBe(1);

    await service.recheckFailed();

    const row = attempts.get('1')!;
    expect(row.outcome).toBe('failed');
    expect((row.retryAfter as Date).getTime()).toBe(now);
  });

  it('leaves a scene whose copy is on its way off the failed count', async () => {
    tries.push({
      id: 'f2',
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'failed',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    attempts.set('1', {
      stashSceneId: '1',
      title: 'Scene 1',
      outcome: 'grabbed',
      searchedAt: new Date(now),
      retryAfter: new Date(now + 86_400_000),
    });
    expect((await service.status()).failed).toBe(0);
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

  describe('the new copy kept beside the old one', () => {
    let scenes: Record<string, { files: Array<{ path: string }> } | null>;
    let deleteScene: jest.Mock;

    beforeEach(() => {
      tries.push({
        id: 'k1',
        stashSceneId: '7',
        title: 'Scene 7',
        outcome: 'kept-both',
        detail: 'The new file runs 14 min and the old one 20 min.',
        handoffId: 'h5',
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      handoffRows.push({
        id: 'h5',
        status: 'imported',
        error: null,
        stashSceneId: '50',
      });
      scenes = {
        '7': { files: [{ path: '/old.mp4' }] },
        '50': { files: [{ path: '/new.mp4' }] },
      };
      deleteScene = jest.fn().mockResolvedValue(undefined);
      Object.assign(stash, {
        getOrganizerScene: jest.fn((_config: unknown, id: string) =>
          Promise.resolve(scenes[id] ?? null),
        ),
        deleteScene,
      });
      Object.assign(prisma.librarySceneIndex, {
        findMany: jest.fn(
          ({ where }: { where: { stashSceneId: { in: string[] } } }) =>
            Promise.resolve(
              where.stashSceneId.in
                .filter((id) => scenes[id])
                .map((stashSceneId) => ({ stashSceneId })),
            ),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      });
      Object.assign(prisma.smallerCopyTry, {
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(tries.find((row) => row.id === where.id) ?? null),
        ),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => {
            const row = tries.find((entry) => entry.id === where.id)!;
            Object.assign(row, data);
            return Promise.resolve(row);
          },
        ),
      });
    });

    it('says which scene the download landed on', async () => {
      const status = await service.status();
      const row = status.tries.find((entry) => entry.id === 'k1');
      expect(row?.newSceneId).toBe('50');
      expect(row?.canRemoveNew).toBe(true);
    });

    it('links a new scene holding other files, but offers no removal', async () => {
      scenes['50'] = { files: [{ path: '/new.mp4' }, { path: '/b.mp4' }] };
      const row = (await service.status()).tries.find(
        (entry) => entry.id === 'k1',
      );
      expect(row?.newSceneId).toBe('50');
      expect(row?.canRemoveNew).toBe(false);
    });

    it('offers no removal when Stash can’t say how many files the new scene holds', async () => {
      (
        stash as unknown as { getOrganizerScene: jest.Mock }
      ).getOrganizerScene.mockRejectedValue(new Error('stash down'));
      const row = (await service.status()).tries.find(
        (entry) => entry.id === 'k1',
      );
      expect(row?.newSceneId).toBe('50');
      expect(row?.canRemoveNew).toBe(false);
      // Gone from Stash: no files, nothing to remove.
      (
        stash as unknown as { getOrganizerScene: jest.Mock }
      ).getOrganizerScene.mockResolvedValue(null);
      now += 2 * 60 * 1000;
      const gone = (await service.status()).tries.find(
        (entry) => entry.id === 'k1',
      );
      expect(gone?.canRemoveNew).toBe(false);
    });

    it('deletes that scene and its file, keeping the old one', async () => {
      const status = await service.removeNewCopy('k1');
      expect(deleteScene).toHaveBeenCalledWith(
        { baseUrl: 'http://stash:9999' },
        '50',
        true,
      );
      const row = status.tries.find((entry) => entry.id === 'k1');
      expect(row?.outcome).toBe('removed');
      expect(row?.detail).toMatch(/removed the new copy \(\/new\.mp4\)/);
      expect(row?.newSceneId).toBeNull();
    });

    it('never deletes the only copy, or a scene holding other files', async () => {
      scenes['50'] = { files: [{ path: '/new.mp4' }, { path: '/b.mp4' }] };
      await expect(service.removeNewCopy('k1')).rejects.toThrow(/2 files/);
      scenes['50'] = { files: [{ path: '/new.mp4' }] };
      scenes['7'] = null;
      await expect(service.removeNewCopy('k1')).rejects.toThrow(
        /no separate new copy/,
      );
      expect(deleteScene).not.toHaveBeenCalled();
    });

    it('offers nothing when the new file joined the old scene', async () => {
      handoffRows[0].stashSceneId = '7';
      const status = await service.status();
      expect(status.tries.find((row) => row.id === 'k1')?.newSceneId).toBe(
        null,
      );
      await expect(service.removeNewCopy('k1')).rejects.toThrow(
        /no separate new copy/,
      );
    });
  });

  describe('choosing a release yourself', () => {
    it('lists every release found, each saying why the rules would pass it by', async () => {
      downloads.searchReleases.mockResolvedValue({
        queries: ['studio scene'],
        releases: [
          release({ guid: 'ok', title: 'Studio.Scene.1080p.x265', size: 2e9 }),
          release({
            guid: 'big',
            title: 'Studio.Scene.1080p',
            size: 8.5e9,
          }),
          release({
            guid: '4k',
            title: 'Studio.Scene.2160p',
            size: 2e9,
            protocol: 'torrent',
          }),
          release({
            guid: 'failed',
            title: 'Studio.Scene.1080p.Failed',
            size: 2e9,
            failedBefore: 'Missing articles',
          }),
        ],
      });

      const result = await service.releasesFor('2');

      expect(downloads.searchReleases).toHaveBeenCalledWith(
        'cat-2',
        'STASHDB',
        undefined,
      );
      expect(result).toMatchObject({ stashSceneId: '2', oldSize: 9e9 });
      const byGuid = new Map(
        result.releases.map((entry) => [entry.guid, entry.problems]),
      );
      expect(byGuid.get('ok')).toEqual([]);
      expect(byGuid.get('big')).toEqual(['Saves less than 10%']);
      expect(byGuid.get('4k')).toEqual([
        'Not from usenet, so Finished downloads can’t bring it in',
        '2160p, not 1080p',
      ]);
      expect(byGuid.get('failed')?.[0]).toBe(
        'SABnzbd couldn’t download it before: Missing articles',
      );
    });

    it('says a scene not linked to the catalog has nothing to search for', async () => {
      await expect(service.releasesFor('3')).rejects.toThrow(/Match it first/);
    });

    it('grabs the one you chose to replace the file, and keeps track of it', async () => {
      const status = await service.grabChosen('2', {
        guid: 'big',
        indexerId: 3,
        title: 'Studio.Scene.1080p',
        size: 7.9e9,
      });

      expect(downloads.grabRelease).toHaveBeenCalledWith(
        'cat-2',
        { guid: 'big', indexerId: 3, title: 'Studio.Scene.1080p' },
        'STASHDB',
        { replacesStashSceneId: '2', expectedTitle: 'Studio.Scene.1080p' },
      );
      expect(status.tries[0]).toMatchObject({
        stashSceneId: '2',
        releaseTitle: 'Studio.Scene.1080p',
        outcome: 'grabbed',
        newSize: 7.9e9,
        oldSize: 9e9,
      });
    });

    it('won’t send one SABnzbd couldn’t download before, or a second one on the way', async () => {
      handoff.failedReleases.mockResolvedValueOnce(
        new Map([['studio.scene.1080p', 'Missing articles']]),
      );
      await expect(
        service.grabChosen('2', {
          guid: 'x',
          indexerId: 3,
          title: 'Studio.Scene.1080p',
        }),
      ).rejects.toThrow(/couldn’t download that release before/);

      prisma.downloadHandoff.count.mockResolvedValueOnce(1);
      await expect(
        service.grabChosen('2', { guid: 'y', indexerId: 3, title: 'Other' }),
      ).rejects.toThrow(/already on its way/);
      expect(downloads.grabRelease).not.toHaveBeenCalled();
    });

    it('checks the release that would be sent, not the name that came with it', async () => {
      handoff.failedReleases.mockResolvedValueOnce(
        new Map([['studio.scene.1080p', 'Missing articles']]),
      );
      await expect(
        service.grabChosen('2', { guid: 'x', indexerId: 3, title: 'Renamed' }),
      ).rejects.toThrow(/couldn’t download that release before/);
      expect(downloads.grabRelease).not.toHaveBeenCalled();
    });

    it('won’t send one whose search result has expired', async () => {
      await expect(
        service.grabChosen('2', { guid: 'gone', indexerId: 3, title: 'Any' }),
      ).rejects.toThrow(/expired/);
      expect(downloads.grabRelease).not.toHaveBeenCalled();
    });

    it('sends only one of two replacements chosen at once', async () => {
      let finish: () => void = () => undefined;
      downloads.grabRelease.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({ accepted: true, sentTo: 'sabnzbd', handoffId: 'h9' });
          }),
      );
      const first = service.grabChosen('2', {
        guid: 'big',
        indexerId: 3,
        title: 'Studio.Scene.1080p',
      });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        service.grabChosen('2', { guid: 'y', indexerId: 3, title: 'Other' }),
      ).rejects.toThrow(/already being sent/);
      finish();
      await first;
      expect(downloads.grabRelease).toHaveBeenCalledTimes(1);
    });
  });
});
