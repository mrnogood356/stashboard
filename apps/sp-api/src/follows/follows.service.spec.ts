import { BadRequestException } from '@nestjs/common';
import type { Follow, FollowedScene } from '@prisma/client';
import type { ActivityService } from '../activity/activity.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PerformersService } from '../performers/performers.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type { RequestsService } from '../requests/requests.service';
import type { SceneStatusService } from '../scene-status/scene-status.service';
import type { ScenesService } from '../scenes/scenes.service';
import { FollowsService } from './follows.service';

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
        };
        if (c.in) return c.in.includes(value);
        if (c.notIn) return !c.notIn.includes(value);
        if ('not' in c) return value !== c.not;
        if (c.gte) return (value as Date) >= c.gte;
      }
      return value === condition;
    });

  const prisma = {
    follow: {
      findMany: jest.fn(({ where }: { where?: Where } = {}) =>
        Promise.resolve(follows.filter((row) => matches(row as never, where))),
      ),
      findUnique: jest.fn(({ where }: { where: Where }) => {
        const key = where.provider_kind_entityId as Where | undefined;
        return Promise.resolve(
          follows.find((row) => matches(row as never, key ?? where)) ?? null,
        );
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
        }: { where?: Where; include?: { follow: boolean } } = {}) =>
          Promise.resolve(
            scenes
              .filter((row) => matches(row as never, where))
              .map((row) =>
                include?.follow
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

  const service = new FollowsService(
    prisma as unknown as PrismaService,
    catalog as unknown as CatalogProviderService,
    performers as unknown as PerformersService,
    scenesService as unknown as ScenesService,
    sceneStatus as unknown as SceneStatusService,
    requests as unknown as RequestsService,
    notifications as unknown as NotificationsService,
    activity as unknown as ActivityService,
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
    expect(follows.map((f) => [f.entityId, f.since, f.autoRequest])).toEqual([
      ['s1', '2025-11-11', true],
    ]);
  });
});
