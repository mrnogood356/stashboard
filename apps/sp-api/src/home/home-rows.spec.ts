import {
  HomeRailContentType,
  HomeRailKey,
  HomeRailKind,
  HomeRailSource,
} from '@prisma/client';
import type { AcquisitionService } from '../acquisition/acquisition.service';
import type { HybridScenesService } from '../hybrid-scenes/hybrid-scenes.service';
import type { LibraryService } from '../library/library.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import type { SceneStatusService } from '../scene-status/scene-status.service';
import type { ScenesService } from '../scenes/scenes.service';
import { HomeService, readRowDisplay } from './home.service';

const now = new Date('2026-10-30T00:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    key: null,
    kind: HomeRailKind.CUSTOM,
    source: HomeRailSource.STASH,
    contentType: HomeRailContentType.SCENES,
    title: 'My Row',
    subtitle: null,
    enabled: true,
    sortOrder: 0,
    config: null,
    display: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup() {
  const homeRail = {
    upsert: jest.fn((args: { create: Record<string, unknown> }) =>
      Promise.resolve(row({ id: 'stock', ...args.create })),
    ),
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(row({ sortOrder: 4 })),
    findUnique: jest.fn(),
    update: jest.fn(
      (args: {
        where: { id?: string; key?: string };
        data: Record<string, unknown>;
      }) =>
        Promise.resolve(
          row({
            id: args.where.id ?? 'x',
            key: args.where.key ?? null,
            ...args.data,
          }),
        ),
    ),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ id: 'created', ...args.data })),
    ),
    delete: jest.fn(),
  };
  const prisma = {
    homeRail,
    integrationConfig: {
      findUnique: jest.fn().mockResolvedValue({
        type: 'STASH',
        enabled: true,
        status: 'CONFIGURED',
        baseUrl: 'http://stash.local',
        apiKey: 'k',
      }),
    },
    $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  const stash = {
    getLocalScenesMatching: jest.fn().mockResolvedValue([]),
  };
  const scenes = { getCalendar: jest.fn() };
  const service = new HomeService(
    prisma as unknown as PrismaService,
    {} as LibraryService,
    {} as CatalogProviderService,
    {} as SceneStatusService,
    {} as HybridScenesService,
    {} as AcquisitionService,
    stash as unknown as StashAdapter,
    undefined,
    scenes as unknown as ScenesService,
  );
  return { service, homeRail, stash, scenes };
}

describe('Home rows', () => {
  it('fills in the default look for anything missing or unknown', () => {
    expect(readRowDisplay(null)).toEqual({
      title: null,
      size: 'regular',
      style: 'wide',
      showStudio: true,
      showDate: true,
      showDuration: false,
      showActions: true,
      devices: 'all',
      seeAll: true,
      limit: null,
    });
    expect(
      readRowDisplay({
        size: 'huge',
        style: 'poster',
        limit: 500,
        showDate: false,
      }),
    ).toEqual(
      expect.objectContaining({
        size: 'regular',
        style: 'poster',
        limit: null,
        showDate: false,
      }),
    );
  });

  it('changes only what was sent, and its own name stays its own', async () => {
    const { service, homeRail } = setup();
    homeRail.findUnique.mockResolvedValue(
      row({
        title: 'Recently Added',
        display: { size: 'large', showDate: false },
      }),
    );

    await service.updateRowDisplay('row-1', {
      style: 'poster',
      title: 'Recently Added',
    });

    expect(homeRail.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: {
        display: expect.objectContaining({
          size: 'large',
          style: 'poster',
          showDate: false,
          title: null,
        }),
      },
    });
  });

  it('shows a renamed row by its new name, and uses its own count', async () => {
    const { service, homeRail, stash } = setup();
    homeRail.findUnique.mockResolvedValue(
      row({
        key: HomeRailKey.TOP_RATED,
        kind: HomeRailKind.BUILTIN,
        title: 'Top Rated',
        display: { title: 'Best Of', limit: 8 },
      }),
    );

    await service.getRailContent('row-1');

    expect(stash.getLocalScenesMatching).toHaveBeenCalledWith(
      expect.anything(),
      {
        sort: 'rating',
        filter: { rating100: { value: 0, modifier: 'GREATER_THAN' } },
      },
      8,
    );
  });

  it('picks library scenes for each stock row', async () => {
    const { service, homeRail, stash } = setup();
    for (const key of [
      HomeRailKey.REDISCOVER,
      HomeRailKey.QUICK_PICKS,
      HomeRailKey.LIBRARY_4K,
    ]) {
      homeRail.findUnique.mockResolvedValue(
        row({ key, kind: HomeRailKind.BUILTIN }),
      );
      await service.getRailContent('row-1');
    }
    const picks = stash.getLocalScenesMatching.mock.calls.map(
      (call) => call[1],
    );
    expect(picks[0]).toEqual({
      sort: 'random',
      filter: expect.objectContaining({
        play_count: { value: 0, modifier: 'GREATER_THAN' },
        last_played_at: expect.objectContaining({ modifier: 'LESS_THAN' }),
      }),
    });
    expect(picks[1].filter).toEqual({
      duration: { value: 1200, modifier: 'LESS_THAN' },
    });
    expect(picks[2].filter).toEqual({
      resolution: { value: 'VR_HD', modifier: 'GREATER_THAN' },
    });
  });

  it('lists upcoming Whisparr scenes soonest first for Coming Soon', async () => {
    const { service, homeRail, scenes } = setup();
    homeRail.findUnique.mockResolvedValue(
      row({ key: HomeRailKey.COMING_SOON, kind: HomeRailKind.BUILTIN }),
    );
    const scene = (id: string, releaseDate: string) => ({
      id,
      title: id,
      description: null,
      imageUrl: null,
      cardImageUrl: null,
      studioId: null,
      studio: null,
      studioImageUrl: null,
      releaseDate,
      duration: null,
      source: 'STASHDB',
      status: { state: 'REQUESTED' },
    });
    scenes.getCalendar.mockResolvedValue({
      whisparr: 'ok',
      items: [
        scene('later', '2099-02-01'),
        scene('past', '2000-01-01'),
        scene('soon', '2099-01-01'),
      ],
    });

    const content = await service.getRailContent('row-1');

    expect(scenes.getCalendar).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'ALL',
      'WHISPARR',
    );
    expect(content.items.map((item) => item.id)).toEqual(['soon', 'later']);
  });

  it('marks shown one-of-a-kind rows as added, and presets as always addable', async () => {
    const { service, homeRail } = setup();
    homeRail.findMany.mockResolvedValue([
      row({
        id: 'a',
        key: HomeRailKey.CONTINUE_WATCHING,
        kind: HomeRailKind.BUILTIN,
      }),
      row({ id: 'b', key: HomeRailKey.TOP_RATED, kind: HomeRailKind.BUILTIN }),
      row({
        id: 'c',
        key: HomeRailKey.MOST_PLAYED_LIBRARY,
        kind: HomeRailKind.BUILTIN,
        enabled: false,
      }),
    ]);

    const gallery = await service.getRowGallery();
    const byId = Object.fromEntries(gallery.map((item) => [item.id, item]));

    expect(byId.CONTINUE_WATCHING.added).toBe(true);
    expect(byId.TOP_RATED.added).toBe(true);
    expect(byId.MOST_PLAYED_LIBRARY.added).toBe(false);
    expect(byId.TRENDING).toEqual(
      expect.objectContaining({
        repeatable: true,
        added: false,
        from: 'catalog',
      }),
    );
    expect(byId.COMING_SOON.from).toBe('whisparr');
  });

  it('adds ready-made rows at the end: turns one back on, adds stock ones, starts presets', async () => {
    const { service, homeRail } = setup();

    await service.addGalleryRow('MOST_PLAYED_LIBRARY');
    expect(homeRail.update).toHaveBeenCalledWith({
      where: { key: HomeRailKey.MOST_PLAYED_LIBRARY },
      data: { enabled: true, sortOrder: 5 },
    });

    const stock = await service.addGalleryRow('QUICK_PICKS');
    expect(homeRail.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: HomeRailKey.QUICK_PICKS },
        create: expect.objectContaining({
          kind: HomeRailKind.BUILTIN,
          title: 'Quick Picks',
        }),
      }),
    );
    expect(stock.deletable).toBe(true);

    await service.addGalleryRow('TRENDING');
    expect(homeRail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: HomeRailKind.CUSTOM,
        source: 'STASHDB',
        title: 'Trending',
        config: expect.objectContaining({ sort: 'TRENDING' }),
      }),
    });
  });

  it('removes stock rows but only turns built-in ones off', async () => {
    const { service, homeRail } = setup();
    homeRail.findUnique.mockResolvedValue(
      row({ key: HomeRailKey.QUICK_PICKS, kind: HomeRailKind.BUILTIN }),
    );
    await service.deleteRail('row-1');
    expect(homeRail.delete).toHaveBeenCalledWith({ where: { id: 'row-1' } });

    homeRail.findUnique.mockResolvedValue(
      row({ key: HomeRailKey.CONTINUE_WATCHING, kind: HomeRailKind.BUILTIN }),
    );
    await expect(service.deleteRail('row-1')).rejects.toThrow(
      'turned off, not removed',
    );
  });
});
