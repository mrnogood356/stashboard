import type { PrismaService } from '../prisma/prisma.service';
import type { LocalLibraryService } from './local-library.service';
import { WatchLaterService } from './watch-later.service';

describe('WatchLaterService', () => {
  let rows: Array<{ stashSceneId: string; position: number; addedAt: Date }>;
  let cards: jest.Mock;
  let service: WatchLaterService;

  beforeEach(() => {
    rows = [];
    const sorted = () => [...rows].sort((a, b) => a.position - b.position);
    const prisma = {
      watchLaterItem: {
        findMany: jest.fn(() => Promise.resolve(sorted())),
        findFirst: jest.fn(() => Promise.resolve(sorted().at(-1) ?? null)),
        count: jest.fn(() => Promise.resolve(rows.length)),
        upsert: jest.fn(
          ({
            create,
          }: {
            create: { stashSceneId: string; position: number };
          }) => {
            if (!rows.some((row) => row.stashSceneId === create.stashSceneId)) {
              rows.push({ ...create, addedAt: new Date() });
            }
            return Promise.resolve();
          },
        ),
        deleteMany: jest.fn(
          ({
            where,
          }: {
            where: { stashSceneId?: string | { in: string[] } };
          }) => {
            const match = where.stashSceneId;
            rows = rows.filter((row) =>
              match === undefined
                ? false
                : typeof match === 'string'
                  ? row.stashSceneId !== match
                  : !match.in.includes(row.stashSceneId),
            );
            return Promise.resolve();
          },
        ),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { stashSceneId: string };
            data: { position: number };
          }) => {
            rows.find(
              (row) => row.stashSceneId === where.stashSceneId,
            )!.position = data.position;
            return Promise.resolve();
          },
        ),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    cards = jest.fn((ids: string[]) =>
      Promise.resolve(ids.filter((id) => id !== '404').map((id) => ({ id }))),
    );
    service = new WatchLaterService(
      prisma as unknown as PrismaService,
      { cardsFor: cards } as unknown as LocalLibraryService,
    );
  });

  it('adds scenes at the end, once each, and removes them', async () => {
    await service.add('3');
    await service.add('1');
    expect(await service.add('3')).toEqual(['3', '1']);
    expect(await service.remove('3')).toEqual(['1']);
  });

  it('refuses something that isn’t a scene id', async () => {
    await expect(service.add('../x')).rejects.toThrow('scene id');
  });

  it('reorders, keeping scenes left out at the end and ignoring ones not on the list', async () => {
    for (const id of ['1', '2', '3']) {
      await service.add(id);
    }
    expect(await service.reorder(['3', '9', '1'])).toEqual(['3', '1', '2']);
    expect(await service.ids()).toEqual(['3', '1', '2']);
  });

  it('lists cards in order, dropping scenes gone from Stash', async () => {
    for (const id of ['1', '404', '2']) {
      await service.add(id);
    }
    expect((await service.list()).items.map((item) => item.id)).toEqual([
      '1',
      '2',
    ]);
    expect(await service.ids()).toEqual(['1', '2']);
  });
});
