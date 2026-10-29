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
    const pages = Array.from({ length: 12 }, () => [scene('x', '2026-11-02')]);
    const { service, feed } = serviceWith(pages);

    const result = await service.getCalendar('2026-11-01', '2026-11-30');

    expect(result.items).toHaveLength(10);
    expect(result.complete).toBe(false);
    expect(feed).toHaveBeenCalledTimes(10);
  });
});

describe('ScenesController.getCalendar', () => {
  const getCalendar = jest.fn().mockResolvedValue({ items: [] });
  const controller = new ScenesController({
    getCalendar,
  } as unknown as ScenesService);

  it('takes up to 62 days, counting both ends', async () => {
    await controller.getCalendar({ from: '2026-11-01', to: '2027-01-01' });
    expect(getCalendar).toHaveBeenCalledWith('2026-11-01', '2027-01-01', 'ALL');
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
