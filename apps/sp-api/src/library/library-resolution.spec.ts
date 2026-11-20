import 'reflect-metadata';
import type { Prisma } from '@prisma/client';
import { resolutionOf } from '../playback/library-stats.util';
import { LIBRARY_RESOLUTIONS } from './dto/library-scenes-query.dto';
import { resolutionWhere } from './library-scene-query.service';

type Size = { width: number | null; height: number | null };
type Where = Prisma.LibrarySceneIndexWhereInput;

/** Just enough of Prisma's where to test these filters. */
function matches(where: Where, size: Size): boolean {
  const field = (value: number | null, test: unknown): boolean => {
    if (test === null) {
      return value === null;
    }
    const range = test as { gte?: number; lt?: number; lte?: number };
    if (value === null) {
      return false;
    }
    return (
      (range.gte === undefined || value >= range.gte) &&
      (range.lt === undefined || value < range.lt) &&
      (range.lte === undefined || value <= range.lte)
    );
  };
  return Object.entries(where).every(([key, test]) => {
    if (key === 'OR') {
      return (test as Where[]).some((part) => matches(part, size));
    }
    return field(size[key as keyof Size], test);
  });
}

describe('resolutionWhere', () => {
  it('puts every scene in the same group as the Stats page does', () => {
    const sizes: Size[] = [
      { width: 3840, height: 2160 },
      { width: 2160, height: 3840 },
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 2560, height: 1440 },
      { width: 1280, height: 720 },
      { width: 720, height: 1280 },
      { width: 1000, height: 999 },
      { width: 854, height: 480 },
      { width: 640, height: 360 },
      { width: null, height: 1080 },
      { width: 0, height: 0 },
    ];
    for (const size of sizes) {
      const groups = LIBRARY_RESOLUTIONS.filter((resolution) =>
        matches(resolutionWhere(resolution), size),
      );
      expect([size, groups]).toEqual([
        size,
        [resolutionOf(size.width, size.height)],
      ]);
    }
  });
});
