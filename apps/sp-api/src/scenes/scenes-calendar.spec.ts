import { BadRequestException } from '@nestjs/common';
import type { ScenesFeedItemDto } from './dto/scenes-feed.dto';
import { ScenesController } from './scenes.controller';
import { ScenesService } from './scenes.service';

const scene = (id: string, releaseDate: string | null) =>
  ({ id, releaseDate }) as unknown as ScenesFeedItemDto;

describe('ScenesService.getCalendar', () => {
  function serviceWith(pages: ScenesFeedItemDto[][]) {
    const service = Object.create(ScenesService.prototype) as ScenesService;
    const feed = jest
      .spyOn(service, 'getScenesFeed')
      .mockImplementation((page = 1) =>
        Promise.resolve({
          total: 1000,
          page,
          perPage: 100,
          hasMore: page < pages.length,
          hidden: 0,
          items: pages[page - 1] ?? [],
        }),
      );
    return { service, feed };
  }

  it('asks for releases from the first day on, oldest first, and stops once past the last', async () => {
    const { service, feed } = serviceWith([
      [scene('c', '2026-11-01'), scene('a', '2026-11-03')],
      [scene('b', '2026-11-20'), scene('future', '2026-12-01')],
      [scene('never-read', '2026-12-09')],
    ]);

    const result = await service.getCalendar(
      '2026-11-01',
      '2026-11-30',
      'STUDIO',
    );

    expect(result.items.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(result.complete).toBe(true);
    expect(feed).toHaveBeenCalledTimes(2);
    expect(feed).toHaveBeenCalledWith(
      1,
      100,
      'DATE',
      'ASC',
      [],
      'OR',
      'STUDIO',
      [],
      undefined,
      [],
      [],
      false,
      '2026-10-31',
    );
  });

  it('says when it stopped reading before reaching the last day', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => [
      scene(`x${i}`, '2026-11-02'),
    ]);
    const { service, feed } = serviceWith(pages);

    const result = await service.getCalendar('2026-11-01', '2026-11-30');

    expect(result.items).toHaveLength(10);
    expect(result.complete).toBe(false);
    expect(feed).toHaveBeenCalledTimes(10);
  });
});

describe('ScenesService.getCalendar with Whisparr', () => {
  const whisparrScene = (stashId: string, date: string, extra = {}) => ({
    movieId: Number(stashId.replace(/\D/g, '')) || 1,
    stashId,
    title: `Title ${stashId}`,
    studio: 'Coastline',
    date,
    hasFile: false,
    monitored: true,
    imageUrl: 'https://cdn.example/x.jpg',
    ...extra,
  });

  function serviceWith(
    starred: ScenesFeedItemDto[],
    whisparr: ReturnType<typeof whisparrScene>[] | Error,
    configured = true,
  ) {
    const service = Object.create(ScenesService.prototype) as ScenesService;
    jest.spyOn(service, 'getScenesFeed').mockResolvedValue({
      total: starred.length,
      page: 1,
      perPage: 100,
      hasMore: false,
      hidden: 0,
      items: starred,
    });
    const getCalendar = jest.fn(() =>
      whisparr instanceof Error
        ? Promise.reject(whisparr)
        : Promise.resolve(whisparr),
    );
    const resolveForScenesWithEvidence = jest.fn(
      (
        ids: string[],
        evidence: { movieByStashId?: Map<string, { hasFile: boolean }> },
      ) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id,
              {
                state: evidence.movieByStashId?.get(id)?.hasFile
                  ? 'AVAILABLE'
                  : 'REQUESTED',
              },
            ]),
          ),
        ),
    );
    Object.assign(service, {
      logger: { warn: jest.fn() },
      integrationsService: {
        findOne: jest.fn().mockResolvedValue(
          configured
            ? {
                enabled: true,
                status: 'CONFIGURED',
                baseUrl: 'http://whisparr:6969',
                apiKey: 'k',
              }
            : {
                enabled: false,
                status: 'NOT_CONFIGURED',
                baseUrl: null,
                apiKey: null,
              },
        ),
      },
      whisparrAdapter: { getCalendar },
      sceneStatusService: {
        resolveForScenesWithEvidence,
        resolveLocalSceneIds: jest
          .fn()
          .mockResolvedValue(new Map([['w2', 'local-2']])),
      },
      catalogProviderService: {
        // Browsing ThePornDB doesn't change where Whisparr's scenes are from.
        getConfiguredCatalogProvider: jest
          .fn()
          .mockResolvedValue({ integrationType: 'THEPORNDB' }),
        getInstanceCatalogProvider: jest
          .fn()
          .mockResolvedValue({ integrationType: 'STASHDB' }),
      },
    });
    return { service, getCalendar, resolveForScenesWithEvidence };
  }

  it('adds the scenes Whisparr has dated then, once each, with their status', async () => {
    const { service, getCalendar } = serviceWith(
      [
        {
          ...scene('shared', '2026-11-04'),
          requestable: true,
          status: { state: 'NOT_REQUESTED' },
        },
        scene('starred', '2026-11-02'),
      ],
      [
        whisparrScene('shared', '2026-11-04'),
        whisparrScene('w1', '2026-11-10'),
        whisparrScene('w2', '2026-11-12', { hasFile: true }),
        whisparrScene('unwanted', '2026-11-13', { monitored: false }),
      ],
    );

    const result = await service.getCalendar('2026-11-01', '2026-11-30');

    expect(getCalendar).toHaveBeenCalledWith(
      { baseUrl: 'http://whisparr:6969', apiKey: 'k' },
      '2026-11-01',
      '2026-11-30',
    );
    expect(result.whisparr).toBe('ok');
    expect(
      result.items
        .filter((item) => item.id.startsWith('w'))
        .every((item) => item.source === 'STASHDB'),
    ).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual([
      'starred',
      'shared',
      'w1',
      'w2',
    ]);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('shared')).toMatchObject({
      inWhisparr: true,
      requestable: false,
      status: { state: 'REQUESTED' },
    });
    expect(byId.get('starred')?.inWhisparr).toBeUndefined();
    expect(byId.get('w1')).toMatchObject({
      title: 'Title w1',
      studio: 'Coastline',
      releaseDate: '2026-11-10',
      status: { state: 'REQUESTED' },
      requestable: false,
      inWhisparr: true,
    });
    expect(byId.get('w2')).toMatchObject({
      status: { state: 'AVAILABLE' },
      localSceneId: 'local-2',
    });
  });

  it('shows only one half when asked, and says when Whisparr is off or failing', async () => {
    const both = serviceWith(
      [scene('starred', '2026-11-02')],
      [whisparrScene('w1', '2026-11-10')],
    );
    expect(
      (
        await both.service.getCalendar(
          '2026-11-01',
          '2026-11-30',
          'ALL',
          'WHISPARR',
        )
      ).items.map((item) => item.id),
    ).toEqual(['w1']);
    const catalogOnly = await both.service.getCalendar(
      '2026-11-01',
      '2026-11-30',
      'ALL',
      'CATALOG',
    );
    expect(catalogOnly.items.map((item) => item.id)).toEqual(['starred']);
    expect(catalogOnly.whisparr).toBe('off');

    const off = serviceWith([scene('starred', '2026-11-02')], [], false);
    expect(
      (await off.service.getCalendar('2026-11-01', '2026-11-30')).whisparr,
    ).toBe('off');
    expect(off.getCalendar).not.toHaveBeenCalled();

    const failing = serviceWith(
      [scene('starred', '2026-11-02')],
      new Error('ECONNREFUSED'),
    );
    const result = await failing.service.getCalendar(
      '2026-11-01',
      '2026-11-30',
    );
    expect(result.whisparr).toBe('failed');
    expect(result.items.map((item) => item.id)).toEqual(['starred']);
  });
});

describe('ScenesController.getCalendar', () => {
  const getCalendar = jest.fn().mockResolvedValue({ items: [] });
  const controller = new ScenesController({
    getCalendar,
  } as unknown as ScenesService);

  it('takes up to 62 days, counting both ends', async () => {
    await controller.getCalendar({ from: '2026-11-01', to: '2027-01-01' });
    expect(getCalendar).toHaveBeenCalledWith(
      '2026-11-01',
      '2027-01-01',
      'ALL',
      'ALL',
    );
    expect(() =>
      controller.getCalendar({ from: '2026-11-01', to: '2027-01-02' }),
    ).toThrow(BadRequestException);
  });

  it('turns down days that do not exist and reversed ranges', () => {
    expect(() =>
      controller.getCalendar({ from: '2026-02-30', to: '2026-03-10' }),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.getCalendar({ from: '2026-03-10', to: '2026-03-01' }),
    ).toThrow(BadRequestException);
  });
});
