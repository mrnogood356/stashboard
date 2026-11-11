import { BadRequestException } from '@nestjs/common';
import type { Follow, FollowedScene } from '@prisma/client';
import type { ActivityService } from '../activity/activity.service';
import type { HiddenContentService } from '../hidden-content/hidden-content.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PerformersService } from '../performers/performers.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type { RequestsService } from '../requests/requests.service';
import type { SceneStatusService } from '../scene-status/scene-status.service';
import type { ScenesService } from '../scenes/scenes.service';
import { FollowsService, MAX_FOLLOWS } from './follows.service';

type Where = Record<string, unknown>;

/** Just enough of Prisma's follow tables, kept in memory. */
function fakePrisma() {
  const follows: Follow[] = [];
  const scenes: FollowedScene[] = [];
  let nextId = 1;

  const matches = (row: Record<string, unknown>, where: Where = {}) =>
    Object.entries(where).every(([key, condition]) => {
      const value = row[key];
      if (
        condition &&
        typeof condition === 'object' &&
        !(condition instanceof Date)
      ) {
        const c = condition as {
          in?: unknown[];
          notIn?: unknown[];
          not?: unknown;
          gte?: Date;
          lt?: string;
        };
        if (c.in) return c.in.includes(value);
        if (c.notIn) return !c.notIn.includes(value);
        if ('not' in c) return value !== c.not;
        if (c.gte) return (value as Date) >= c.gte;
        if (c.lt !== undefined) return value !== null && String(value) < c.lt;
      }
      return value === condition;
    });

  // Newest release first, then newest found, as the service asks.
  const newestFirst = (a: FollowedScene, b: FollowedScene) =>
    (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') ||
    b.foundAt.getTime() - a.foundAt.getTime();

  const prisma = {
    follow: {
      count: jest.fn(() => Promise.resolve(follows.length)),
      create: jest.fn(({ data }: { data: Partial<Follow> }) => {
        const row = {
          id: `f${nextId++}`,
          imageUrl: null,
          autoRequest: false,
          tags: [],
          lastCheckedAt: null,
          fullyCheckedAt: null,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Follow;
        follows.push(row);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(
        ({ where, data }: { where: Where; data: Partial<Follow> }) => {
          for (const row of follows.filter((f) => matches(f as never, where))) {
            Object.assign(row, data);
          }
          return Promise.resolve();
        },
      ),
      // Copies, as the database returns: a later update doesn't change them.
      findMany: jest.fn(({ where }: { where?: Where } = {}) =>
        Promise.resolve(
          follows
            .filter((row) => matches(row as never, where))
            .map((row) => ({ ...row })),
        ),
      ),
      findUnique: jest.fn(({ where }: { where: Where }) => {
        const key = where.provider_kind_entityId as Where | undefined;
        const row = follows.find((f) => matches(f as never, key ?? where));
        return Promise.resolve(row ? { ...row } : null);
      }),
      upsert: jest.fn(
        ({
          where,
          create,
          update,
        }: {
          where: { provider_kind_entityId: Where };
          create: Partial<Follow>;
          update: Partial<Follow>;
        }) => {
          const existing = follows.find((row) =>
            matches(row as never, where.provider_kind_entityId),
          );
          if (existing) {
            Object.assign(existing, update);
            return Promise.resolve(existing);
          }
          const row = {
            id: `f${nextId++}`,
            imageUrl: null,
            autoRequest: false,
            lastCheckedAt: null,
            fullyCheckedAt: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          } as Follow;
          follows.push(row);
          return Promise.resolve(row);
        },
      ),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Partial<Follow> }) => {
          const row = follows.find((f) => f.id === where.id)!;
          Object.assign(row, data);
          return Promise.resolve(row);
        },
      ),
      delete: jest.fn(({ where }: { where: { id: string } }) => {
        follows.splice(
          follows.findIndex((f) => f.id === where.id),
          1,
        );
        return Promise.resolve();
      }),
      deleteMany: jest.fn(({ where }: { where: Where }) => {
        for (const row of follows.filter((f) => matches(f as never, where))) {
          follows.splice(follows.indexOf(row), 1);
        }
        return Promise.resolve();
      }),
    },
    followedScene: {
      findMany: jest.fn(
        ({
          where,
          include,
          select,
          orderBy,
        }: {
          where?: Where;
          include?: { follow: boolean };
          select?: { follow?: unknown };
          orderBy?: unknown;
        } = {}) =>
          Promise.resolve(
            scenes
              .filter((row) => matches(row as never, where))
              .sort(orderBy ? newestFirst : () => 0)
              .map((row) =>
                include?.follow || select?.follow
                  ? {
                      ...row,
                      follow: follows.find((f) => f.id === row.followId),
                    }
                  : row,
              ),
          ),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        Promise.resolve(
          scenes.find((row) => matches(row as never, where)) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Partial<FollowedScene> }) => {
        const row = {
          state: 'NEW',
          detail: null,
          foundAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as FollowedScene;
        scenes.push(row);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(
        ({ where, data }: { where: Where; data: Partial<FollowedScene> }) => {
          for (const row of scenes.filter((s) => matches(s as never, where))) {
            Object.assign(row, data);
          }
          return Promise.resolve();
        },
      ),
      deleteMany: jest.fn(({ where }: { where: Where }) => {
        for (const row of scenes.filter((s) => matches(s as never, where))) {
          scenes.splice(scenes.indexOf(row), 1);
        }
        return Promise.resolve();
      }),
      groupBy: jest.fn(({ where }: { where: Where }) => {
        const counts = new Map<string, number>();
        for (const row of scenes.filter((s) => matches(s as never, where))) {
          counts.set(row.followId, (counts.get(row.followId) ?? 0) + 1);
        }
        return Promise.resolve(
          [...counts].map(([followId, count]) => ({
            followId,
            _count: { _all: count },
          })),
        );
      }),
    },
  };
  return { prisma, follows, scenes };
}

function feedScene(id: string, releaseDate: string, state = 'NOT_REQUESTED') {
  return {
    id,
    title: `Scene ${id}`,
    imageUrl: `https://img/${id}`,
    cardImageUrl: null,
    studioId: 's1',
    studio: 'Studio',
    releaseDate,
    duration: 1800,
    status: { state },
  };
}

function setup() {
  const { prisma, follows, scenes } = fakePrisma();
  const catalog = {
    isBrowseOnlyRequest: jest.fn().mockResolvedValue(false),
    getInstanceCatalogProviderType: jest.fn().mockResolvedValue('STASHDB'),
  };
  const performers = {
    getPerformerScenes: jest.fn().mockResolvedValue({
      hasMore: false,
      items: [
        feedScene('new-1', '2026-11-10'),
        feedScene('owned', '2026-11-09', 'AVAILABLE'),
        feedScene('old', '2026-10-01'),
      ],
    }),
  };
  const scenesService = {
    searchSceneTags: jest
      .fn()
      .mockResolvedValue([
        { id: 't-anal', name: 'Anal', description: null, aliases: [] },
      ]),
    getScenesFeed: jest.fn().mockResolvedValue({
      hasMore: false,
      items: [
        feedScene('new-1', '2026-11-10'),
        feedScene('new-2', '2026-11-08'),
      ],
    }),
  };
  const statuses = new Map<string, { state: string }>();
  const sceneStatus = {
    resolveForScenes: jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [id, statuses.get(id) ?? { state: 'NOT_REQUESTED' }]),
        ),
      ),
    ),
  };
  const requests = {
    getDefaultRequest: jest.fn().mockResolvedValue({
      monitored: true,
      searchForMovie: true,
      rootFolderPath: '/data',
      qualityProfileId: 1,
      tags: [],
    }),
    submitSceneRequest: jest.fn().mockResolvedValue({ accepted: true }),
  };
  const notifications = { notifyFollowedReleases: jest.fn() };
  const activity = { record: jest.fn() };
  const hiddenRules = {
    matchers: [] as RegExp[],
    tagIds: new Set<string>(),
    studioIds: new Set<string>(),
    performerIds: new Set<string>(),
    tagNames: new Set<string>(),
    studioNames: new Set<string>(),
  };
  const hiddenContent = {
    getRules: jest.fn(() => Promise.resolve(hiddenRules)),
  };

  const service = new FollowsService(
    prisma as unknown as PrismaService,
    catalog as unknown as CatalogProviderService,
    performers as unknown as PerformersService,
    scenesService as unknown as ScenesService,
    sceneStatus as unknown as SceneStatusService,
    requests as unknown as RequestsService,
    notifications as unknown as NotificationsService,
    activity as unknown as ActivityService,
    hiddenContent as unknown as HiddenContentService,
  );
  service.now = () => new Date('2026-11-11T12:00:00Z');
  return {
    service,
    follows,
    scenes,
    catalog,
    performers,
    scenesService,
    statuses,
    requests,
    notifications,
    hiddenRules,
  };
}

describe('FollowsService', () => {
  it('follows on the main catalog, from today unless asked', async () => {
    const { service, follows } = setup();
    const follow = await service.follow({
      kind: 'PERFORMER',
      entityId: ' p1 ',
      name: 'Kaitlyn',
    });
    expect(follow).toEqual(
      expect.objectContaining({
        provider: 'STASHDB',
        entityId: 'p1',
        since: '2026-11-11',
        autoRequest: false,
        newCount: 0,
      }),
    );
    expect(follows).toHaveLength(1);
  });

  it('won’t follow from a secondary catalog’s page', async () => {
    const { service, catalog } = setup();
    catalog.isBrowseOnlyRequest.mockResolvedValue(true);
    await expect(
      service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.lookup('STUDIO', 's1')).resolves.toEqual({
      follow: null,
      followable: false,
    });
  });

  it('lists new scenes for review, skipping old, owned and already seen ones', async () => {
    const { service, follows, performers, requests, notifications } = setup();
    await service.follow({
      kind: 'PERFORMER',
      entityId: 'p1',
      name: 'Kaitlyn',
    });
    follows[0].since = '2026-11-01';
    await service.checkAll();

    const summary = await service.checkAll();
    expect(summary).toEqual({
      checked: 1,
      found: 0,
      requested: 0,
      failed: 0,
      errors: 0,
    });
    expect(performers.getPerformerScenes).toHaveBeenCalledWith('p1', 1, 40, {
      sort: 'DATE',
      direction: 'DESC',
    });
    expect(requests.submitSceneRequest).not.toHaveBeenCalled();
    // Only the first check found something to tell you about.
    expect(notifications.notifyFollowedReleases).toHaveBeenCalledTimes(1);
    expect(notifications.notifyFollowedReleases).toHaveBeenCalledWith([
      { title: 'Scene new-1', followName: 'Kaitlyn', requested: false },
    ]);

    const review = await service.releases('review');
    expect(review.reviewCount).toBe(1);
    expect(review.items.map((item) => item.id)).toEqual(['new-1']);
    expect(review.items[0].followed.follows[0].name).toBe('Kaitlyn');
  });

  it('requests on its own for follows set to, once per scene across follows', async () => {
    const { service, follows, requests, scenes } = setup();
    await service.follow({
      kind: 'STUDIO',
      entityId: 's1',
      name: 'Studio',
      autoRequest: true,
    });
    await service.follow({
      kind: 'PERFORMER',
      entityId: 'p1',
      name: 'Kaitlyn',
    });
    for (const follow of follows) {
      follow.since = '2026-11-01';
    }
    // Both find new-1; the studio (followed first) requests it.
    const summary = await service.checkAll();

    expect(requests.getDefaultRequest).toHaveBeenCalledTimes(1);
    expect(
      requests.submitSceneRequest.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(['new-1', 'new-2']);
    expect(summary.requested).toBe(2);
    expect(
      scenes.filter((row) => row.sceneId === 'new-1').map((row) => row.state),
    ).toEqual(['REQUESTED', 'REQUESTED']);
    expect((await service.releases('review')).items).toEqual([]);
  });

  it('keeps a failed automatic request for review, with why', async () => {
    const { service, follows, requests } = setup();
    requests.submitSceneRequest.mockRejectedValue(
      new Error('Whisparr is down'),
    );
    await service.follow({
      kind: 'STUDIO',
      entityId: 's1',
      name: 'Studio',
      autoRequest: true,
    });
    follows[0].since = '2026-11-01';
    const summary = await service.checkAll();
    expect(summary.failed).toBe(2);
    const review = await service.releases('review');
    expect(review.items[0].followed).toEqual(
      expect.objectContaining({ state: 'FAILED', detail: 'Whisparr is down' }),
    );
  });

  it('drops a scene from review once it’s requested some other way, or dismissed', async () => {
    const { service, follows, statuses } = setup();
    await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
    follows[0].since = '2026-11-01';
    await service.checkAll();
    statuses.set('new-1', { state: 'REQUESTED' });
    expect((await service.releases('review')).items.map((i) => i.id)).toEqual([
      'new-2',
    ]);

    await service.dismiss('new-2');
    expect((await service.releases('review')).items).toEqual([]);
    // Still among recent finds, except the dismissed one.
    expect((await service.releases('all')).items.map((i) => i.id)).toEqual([
      'new-1',
    ]);
  });

  it('says why a follow from another catalog isn’t checked', async () => {
    const { service, catalog, follows, performers } = setup();
    await service.follow({
      kind: 'PERFORMER',
      entityId: 'p1',
      name: 'Kaitlyn',
    });
    catalog.getInstanceCatalogProviderType.mockResolvedValue('FANSDB');
    const summary = await service.checkAll();
    expect(summary.errors).toBe(1);
    expect(performers.getPerformerScenes).not.toHaveBeenCalled();
    expect(follows[0].lastError).toContain('isn’t your main catalog');
  });

  it('restores follows from a backup, removing the rest', async () => {
    const { service, follows } = setup();
    await service.follow({ kind: 'PERFORMER', entityId: 'gone', name: 'Gone' });
    await service.restoreFromBackup({
      follows: [
        {
          kind: 'STUDIO',
          provider: 'STASHDB',
          entityId: 's1',
          name: 'Studio',
          since: '2001-01-01',
          autoRequest: true,
        },
      ],
    });
    // Added by the restore: from today, since what you passed on isn't in
    // the backup.
    expect(follows.map((f) => [f.entityId, f.since, f.autoRequest])).toEqual([
      ['s1', '2026-11-11', true],
    ]);
    // A backup from before tags follows every scene.
    expect(follows[0].tags).toEqual([]);
  });

  it('asks the catalog only for scenes with the follow’s tags', async () => {
    const { service, follows, performers, scenesService } = setup();
    const anal = { id: 't-anal', name: 'Anal' };
    await service.follow({
      kind: 'PERFORMER',
      entityId: 'p1',
      name: 'Kaitlyn',
      tags: [anal, anal, { id: ' ', name: 'blank' }],
    });
    await service.follow({
      kind: 'STUDIO',
      entityId: 's1',
      name: 'Studio',
      tags: [anal],
    });
    expect(follows[0].tags).toEqual([anal]);
    await service.checkAll();

    expect(performers.getPerformerScenes).toHaveBeenCalledWith('p1', 1, 40, {
      sort: 'DATE',
      direction: 'DESC',
      tagIds: ['t-anal'],
    });
    expect(scenesService.getScenesFeed).toHaveBeenCalledWith(
      1,
      40,
      'DATE',
      'DESC',
      ['t-anal'],
      'OR',
      undefined,
      ['s1'],
    );
    expect((await service.list()).follows[0].tags).toEqual([anal]);
  });

  it('looks again, quietly, when a follow’s tags change', async () => {
    const { service, follows, scenes, performers, notifications } = setup();
    await service.follow({
      kind: 'PERFORMER',
      entityId: 'p1',
      name: 'Kaitlyn',
    });
    follows[0].since = '2026-11-01';
    await service.checkAll();
    expect(scenes.map((row) => row.sceneId)).toEqual(['new-1']);
    notifications.notifyFollowedReleases.mockClear();

    // Under the new tag the catalog has a different scene.
    performers.getPerformerScenes.mockResolvedValue({
      hasMore: false,
      items: [feedScene('tagged', '2026-11-09')],
    });
    const saved = await service.update(follows[0].id, {
      tags: [{ id: 't-anal', name: 'Anal' }],
    });
    expect(saved.tags).toEqual([{ id: 't-anal', name: 'Anal' }]);
    await service.checkAll(); // waits for the re-check the change started

    // What was waiting without the tag is gone; the tagged scene is there.
    expect(scenes.map((row) => row.sceneId)).toEqual(['tagged']);
    expect(notifications.notifyFollowedReleases).not.toHaveBeenCalled();
  });

  it('finds tags on the main catalog', async () => {
    const { service } = setup();
    await expect(service.searchTags('  ')).resolves.toEqual([]);
    await expect(service.searchTags('an')).resolves.toEqual([
      { id: 't-anal', name: 'Anal' },
    ]);
  });

  describe('after review', () => {
    it('stops at the number of follows a backup can hold', async () => {
      const { service, follows } = setup();
      for (let i = 0; i < MAX_FOLLOWS; i += 1) {
        await service.follow({ kind: 'STUDIO', entityId: `x${i}`, name: 'S' });
      }
      expect(follows).toHaveLength(MAX_FOLLOWS);
      await expect(
        service.follow({ kind: 'PERFORMER', entityId: 'p1', name: 'Kaitlyn' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Changing one already followed still works.
      await expect(
        service.follow({ kind: 'STUDIO', entityId: 'x0', name: 'Again' }),
      ).resolves.toEqual(expect.objectContaining({ name: 'Again' }));
    });

    it('reads past the first pages until it reaches the start, then only lately', async () => {
      const { service, follows, performers } = setup();
      // 130 scenes, a day apart, newest first: four pages.
      const all = Array.from({ length: 130 }, (_, i) =>
        feedScene(
          `s${i}`,
          new Date(Date.UTC(2026, 10, 10) - i * 86_400_000)
            .toISOString()
            .slice(0, 10),
        ),
      );
      performers.getPerformerScenes.mockImplementation(
        (_id: string, page: number, perPage: number) =>
          Promise.resolve({
            hasMore: page * perPage < all.length,
            items: all.slice((page - 1) * perPage, page * perPage),
          }),
      );
      await service.follow({ kind: 'PERFORMER', entityId: 'p1', name: 'K' });
      follows[0].since = '2025-11-11';
      const first = await service.checkAll();
      expect(first.found).toBe(130);
      expect(performers.getPerformerScenes).toHaveBeenCalledTimes(4);
      expect(follows[0].fullyCheckedAt).toEqual(service.now());

      // Next time it reads back only to a month before that check.
      performers.getPerformerScenes.mockClear();
      await service.checkAll();
      expect(performers.getPerformerScenes).toHaveBeenCalledTimes(1);
    });

    it('doesn’t act on a follow changed while its check ran', async () => {
      const { service, follows, performers, requests, scenes } = setup();
      await service.follow({
        kind: 'PERFORMER',
        entityId: 'p1',
        name: 'Kaitlyn',
        autoRequest: true,
      });
      follows[0].since = '2026-11-01';
      performers.getPerformerScenes.mockImplementation(() => {
        // Tags change mid-check (a new saved row, as the database would).
        follows[0] = {
          ...follows[0],
          tags: [{ id: 't-anal', name: 'Anal' }],
          updatedAt: new Date(),
        };
        return Promise.resolve({
          hasMore: false,
          items: [feedScene('untagged', '2026-11-10')],
        });
      });
      await service.checkAll();
      expect(requests.submitSceneRequest).not.toHaveBeenCalled();
      expect(scenes).toEqual([]);
      expect(follows[0].fullyCheckedAt).toBeNull();
    });

    it('requests a scene another follow left waiting, once, for a follow set to', async () => {
      const { service, follows, requests, scenes } = setup();
      await service.follow({ kind: 'PERFORMER', entityId: 'p1', name: 'K' });
      await service.follow({
        kind: 'STUDIO',
        entityId: 's1',
        name: 'Studio',
        autoRequest: true,
      });
      for (const follow of follows) {
        follow.since = '2026-11-01';
      }
      const summary = await service.checkAll();
      // new-1: the performer found it first, the studio requested it.
      expect(
        requests.submitSceneRequest.mock.calls.map((call) => call[0]).sort(),
      ).toEqual(['new-1', 'new-2']);
      expect(
        scenes.filter((row) => row.sceneId === 'new-1').map((row) => row.state),
      ).toEqual(['REQUESTED', 'REQUESTED']);
      expect(summary.requested).toBe(2);
    });

    it('leaves out what Settings → Hidden hides', async () => {
      const { service, follows, performers, scenesService, hiddenRules } =
        setup();
      await service.follow({ kind: 'PERFORMER', entityId: 'p1', name: 'K' });
      await service.follow({
        kind: 'STUDIO',
        entityId: 's9',
        name: 'Tagged',
        tags: [{ id: 't-hidden', name: 'Hidden' }],
      });
      await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
      for (const follow of follows) {
        follow.since = '2026-11-01';
      }
      hiddenRules.performerIds.add('p1');
      hiddenRules.tagIds.add('t-hidden');
      await service.checkAll();
      expect(performers.getPerformerScenes).not.toHaveBeenCalled();
      expect(follows[0].lastError).toContain('Hidden');
      expect(follows[1].lastError).toContain('tags are hidden');
      expect(scenesService.getScenesFeed).toHaveBeenCalledTimes(1);
      expect((await service.releases('review')).reviewCount).toBe(2);

      // Hiding the studio afterwards takes its scenes out of the lists.
      hiddenRules.studioIds.add('s1');
      const review = await service.releases('review');
      expect(review.items).toEqual([]);
      expect(review.reviewCount).toBe(0);
    });

    it('lists the newest of many scenes and counts them all', async () => {
      const { service, follows, scenes } = setup();
      await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
      for (let i = 0; i < 1200; i += 1) {
        scenes.push({
          followId: follows[0].id,
          sceneId: `m${i}`,
          title: `Scene ${i}`,
          imageUrl: null,
          studioId: 's1',
          studioName: 'Studio',
          releaseDate: new Date(Date.UTC(2026, 10, 10) - i * 3_600_000)
            .toISOString()
            .slice(0, 13),
          duration: null,
          state: 'NEW',
          detail: null,
          foundAt: new Date(),
          updatedAt: new Date(),
        } as never);
      }
      const review = await service.releases('review', 5);
      expect(review.items.map((item) => item.id)).toEqual([
        'm0',
        'm1',
        'm2',
        'm3',
        'm4',
      ]);
      expect(review.reviewCount).toBe(1200);
    });

    it('drops what’s waiting from before a later start', async () => {
      const { service, follows, scenes } = setup();
      await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
      follows[0].since = '2026-11-01';
      await service.checkAll(); // new-1 (11-10) and new-2 (11-08)
      await service.update(follows[0].id, { since: '2026-11-09' });
      expect(scenes.map((row) => row.sceneId)).toEqual(['new-1']);
    });

    it('checks every follow on schedule even while one is being checked', async () => {
      const { service, follows, scenesService, performers } = setup();
      await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
      await service.follow({ kind: 'PERFORMER', entityId: 'p1', name: 'K' });
      // An earlier start reads one follow again, in the background.
      await service.update(follows[0].id, { since: '2026-11-01' });
      const status = await service.runScheduled();
      expect(status).not.toBe('Already checking.');
      expect(performers.getPerformerScenes).toHaveBeenCalled();
      expect(scenesService.getScenesFeed).toHaveBeenCalledTimes(2);
    });

    it('shows a scene from a catalog that’s no longer the main one as not requestable', async () => {
      const { service, follows, catalog } = setup();
      await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
      follows[0].since = '2026-11-01';
      await service.checkAll();
      catalog.getInstanceCatalogProviderType.mockResolvedValue('FANSDB');
      const { items } = await service.releases('review');
      expect(items[0]).toEqual(
        expect.objectContaining({ source: 'STASHDB', requestable: false }),
      );
    });

    it('reads a restored follow again when the backup changes its tags', async () => {
      const { service, follows, scenes } = setup();
      await service.follow({ kind: 'STUDIO', entityId: 's1', name: 'Studio' });
      follows[0].since = '2026-11-01';
      await service.checkAll();
      expect(scenes).toHaveLength(2);
      await service.restoreFromBackup({
        follows: [
          {
            kind: 'STUDIO',
            provider: 'STASHDB',
            entityId: 's1',
            name: 'Studio',
            since: '2026-11-01',
            autoRequest: false,
            tags: [{ id: 't-anal', name: 'Anal' }],
          },
        ],
      });
      expect(scenes).toEqual([]);
      expect(follows[0].fullyCheckedAt).toBeNull();
      expect(follows[0].since).toBe('2026-11-01');
    });
  });
});
