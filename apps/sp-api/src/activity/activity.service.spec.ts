import { ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { ActivityService, shorten } from './activity.service';

describe('ActivityService', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1',
    createdAt: new Date('2026-10-19T10:00:00Z'),
    kind: 'rename',
    title: 'Renamed 3 files',
    detail: null,
    status: 'done',
    count: 3,
    undo: { type: 'rename-batch', batchId: 'b1' },
    undoneAt: null,
    ...overrides,
  });

  let prisma: {
    activityEntry: Record<string, jest.Mock>;
  };
  let service: ActivityService;

  beforeEach(() => {
    prisma = {
      activityEntry: {
        create: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(row()),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(row(data)),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new ActivityService(prisma as unknown as PrismaService);
  });

  it('records an entry', async () => {
    await service.record({
      kind: 'rename',
      title: 'Renamed 3 files',
      count: 3,
      undo: { type: 'rename-batch', batchId: 'b1' },
    });
    expect(prisma.activityEntry.create).toHaveBeenCalledWith({
      data: {
        kind: 'rename',
        title: 'Renamed 3 files',
        detail: null,
        status: 'done',
        count: 3,
        undo: { type: 'rename-batch', batchId: 'b1' },
      },
    });
  });

  it('never throws when saving fails', async () => {
    prisma.activityEntry.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.record({ kind: 'delete', title: 'Deleted a.mp4' }),
    ).resolves.toBeUndefined();
  });

  it('skips an empty title', async () => {
    await service.record({ kind: 'match', title: '   ' });
    expect(prisma.activityEntry.create).not.toHaveBeenCalled();
  });

  it('keeps only the newest entries', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    prisma.activityEntry.findFirst.mockResolvedValue({ createdAt: cutoff });
    await service.prune();
    expect(prisma.activityEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1999 }),
    );
    expect(prisma.activityEntry.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: cutoff } },
    });
  });

  it('trims now and then while recording', async () => {
    for (let i = 0; i < 50; i += 1) {
      await service.record({ kind: 'scan', title: `Run ${i}` });
    }
    expect(prisma.activityEntry.findFirst).toHaveBeenCalledTimes(1);
  });

  it('lists newest first with filters, and says when there is more', async () => {
    prisma.activityEntry.findMany.mockResolvedValue(
      Array.from({ length: 31 }, (_, i) => row({ id: `a${i}` })),
    );
    const page = await service.list({ page: 2, kind: 'rename', q: 'studio' });
    expect(prisma.activityEntry.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'rename',
        OR: [
          { title: { contains: 'studio', mode: 'insensitive' } },
          { detail: { contains: 'studio', mode: 'insensitive' } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 30,
      take: 31,
    });
    expect(page.items).toHaveLength(30);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toEqual({
      id: 'a0',
      at: '2026-10-19T10:00:00.000Z',
      kind: 'rename',
      title: 'Renamed 3 files',
      detail: null,
      status: 'done',
      count: 3,
      canUndo: false,
      undoneAt: null,
    });
  });

  it('finds the newest entries mentioning a scene’s title or files', async () => {
    prisma.activityEntry.findMany.mockResolvedValue([row()]);
    const items = await service.mentioning([
      ' Summer Afternoon ',
      '/data/a.mp4',
      'Summer Afternoon',
      'ab',
    ]);
    expect(prisma.activityEntry.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { title: { contains: 'Summer Afternoon', mode: 'insensitive' } },
          { detail: { contains: 'Summer Afternoon', mode: 'insensitive' } },
          { title: { contains: '/data/a.mp4', mode: 'insensitive' } },
          { detail: { contains: '/data/a.mp4', mode: 'insensitive' } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    expect(items.map((item) => item.id)).toEqual(['a1']);
  });

  it('looks nothing up when there’s nothing to look for', async () => {
    await expect(service.mentioning(['', 'ab'])).resolves.toEqual([]);
    expect(prisma.activityEntry.findMany).not.toHaveBeenCalled();
  });

  it('offers Undo only where a handler exists and it isn’t undone yet', async () => {
    service.registerUndo('rename-batch', jest.fn());
    prisma.activityEntry.findMany.mockResolvedValue([
      row(),
      row({ id: 'a2', undoneAt: new Date() }),
      row({ id: 'a3', undo: null }),
    ]);
    const page = await service.list();
    expect(page.items.map((item) => item.canUndo)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('runs the undo and marks the entry undone', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    service.registerUndo('rename-batch', handler);
    const result = await service.undo('a1');
    expect(handler).toHaveBeenCalledWith({
      type: 'rename-batch',
      batchId: 'b1',
    });
    expect(prisma.activityEntry.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { undoneAt: expect.any(Date) as Date },
    });
    expect(result.undoneAt).not.toBeNull();
    expect(result.canUndo).toBe(false);
  });

  it('refuses entries that can’t be undone', async () => {
    prisma.activityEntry.findUnique.mockResolvedValueOnce(null);
    await expect(service.undo('x')).rejects.toBeInstanceOf(NotFoundException);

    prisma.activityEntry.findUnique.mockResolvedValueOnce(row({ undo: null }));
    await expect(service.undo('a1')).rejects.toBeInstanceOf(ConflictException);

    service.registerUndo('rename-batch', jest.fn());
    prisma.activityEntry.findUnique.mockResolvedValueOnce(
      row({ undoneAt: new Date() }),
    );
    await expect(service.undo('a1')).rejects.toThrow(/already undone/);
  });

  it('refuses a second undo of the same entry while the first is running', async () => {
    let finish: () => void = () => undefined;
    const handler = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    service.registerUndo('rename-batch', handler);

    const first = service.undo('a1');
    await expect(service.undo('a1')).rejects.toThrow(/already being undone/);
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await first;
    expect(handler).toHaveBeenCalledTimes(1);

    // Once it's done, the entry is free again (here: it reports undone).
    prisma.activityEntry.findUnique.mockResolvedValueOnce(
      row({ undoneAt: new Date() }),
    );
    await expect(service.undo('a1')).rejects.toThrow(/already undone/);
  });

  it('leaves the entry as it was when the undo fails', async () => {
    service.registerUndo(
      'rename-batch',
      jest.fn().mockRejectedValue(new ConflictException('busy')),
    );
    await expect(service.undo('a1')).rejects.toThrow('busy');
    expect(prisma.activityEntry.update).not.toHaveBeenCalled();
  });

  it('marks entries undone by their undo key', async () => {
    await service.markUndone('rename-batch', 'batchId', 'b1');
    expect(prisma.activityEntry.updateMany).toHaveBeenCalledWith({
      where: {
        undoneAt: null,
        AND: [
          { undo: { path: ['type'], equals: 'rename-batch' } },
          { undo: { path: ['batchId'], equals: 'b1' } },
        ],
      },
      data: { undoneAt: expect.any(Date) as Date },
    });
  });
});

describe('shorten', () => {
  it('keeps a short title as it is', () => {
    expect(shorten('Renamed 3 files.', 'More')).toEqual({
      title: 'Renamed 3 files.',
      detail: 'More',
    });
  });

  it('moves a long message into the detail', () => {
    const long = `Renamed 3 files (e.g. /data/${'x'.repeat(200)}.mp4).`;
    const result = shorten(long);
    expect(result.title.length).toBeLessThanOrEqual(160);
    expect(result.title.endsWith('…')).toBe(true);
    expect(result.detail).toBe(long);
  });

  it('uses the first sentence when it fits', () => {
    const long = `Matched 4 of 9. ${'Some need you to pick. '.repeat(10)}`;
    expect(shorten(long).title).toBe('Matched 4 of 9.');
  });
});
