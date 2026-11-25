import { Logger } from '@nestjs/common';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import type { DownloadHandoffService } from './download-handoff.service';
import { DownloadRematchService } from './download-rematch.service';

type Row = Record<string, unknown> & {
  id: string;
  placePending: boolean;
  rematchTriedAt: Date | null;
};

/** A table in memory: findMany honours placePending and take; update writes. */
function table(rows: Row[]) {
  return {
    rows,
    findMany: jest.fn(
      ({ where, take }: { where: { placePending?: boolean }; take?: number }) =>
        Promise.resolve(
          rows
            .filter(
              (row) =>
                where.placePending === undefined ||
                row.placePending === where.placePending,
            )
            .slice(0, take ?? rows.length)
            .map((row) => ({ ...row })),
        ),
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: { in: string[] }; matchedBy: { in: string[] } };
        data: Partial<Row>;
      }) => {
        const hit = rows.filter(
          (row) =>
            where.id.in.includes(row.id) &&
            where.matchedBy.in.includes(row['matchedBy'] as string),
        );
        hit.forEach((row) => Object.assign(row, data));
        return Promise.resolve({ count: hit.length });
      },
    ),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((entry) => entry.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
    ),
  };
}

describe('DownloadRematchService', () => {
  const day = 24 * 3600_000;
  let now: number;
  let dropIns: ReturnType<typeof table>;
  let downloads: ReturnType<typeof table>;
  let index: { findMany: jest.Mock };
  let organizer: { identifyNewScenes: jest.Mock };
  let handoff: { stashConfig: jest.Mock; placeInFolder: jest.Mock };
  let stash: { getOrganizerScene: jest.Mock };
  let activity: { record: jest.Mock };
  let service: DownloadRematchService;

  const dropIn = (id: string, sceneId: string, at: number): Row => ({
    id,
    sourcePath: `/drop/${id}.mp4`,
    stashSceneId: sceneId,
    finalPath: `/lib/in/${id}.mp4`,
    finishedAt: new Date(at),
    rematchTriedAt: null,
    placePending: false,
    matchedBy: 'none',
  });
  const linkedScene = (path: string) => ({
    files: [{ path }],
    stashIds: [{ endpoint: 'https://stashdb.org/graphql', stashId: 'x' }],
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    now = Date.UTC(2026, 10, 20);
    dropIns = table([
      {
        ...dropIn('d1', '11', now - 2 * day),
        sourcePath: '/drop/Studio.24.03.15.Jane.Doe.mp4',
        finalPath: '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
      },
      dropIn('d2', '12', now - day),
    ]);
    downloads = table([
      {
        id: 'h1',
        releaseTitle: 'My.Own.Download',
        stashSceneId: '13',
        finalPath: '/lib/in/own.mp4',
        finishedAt: new Date(now - 3 * day),
        rematchTriedAt: null,
        placePending: false,
      },
    ]);
    // Scene 12 is linked already.
    index = { findMany: jest.fn().mockResolvedValue([{ stashSceneId: '12' }]) };
    organizer = {
      identifyNewScenes: jest.fn().mockResolvedValue({
        linked: [],
        matched: ['11'],
        proposed: ['13'],
        byName: ['11'],
        left: ['13'],
      }),
    };
    handoff = {
      stashConfig: jest.fn().mockResolvedValue({ baseUrl: 'http://stash' }),
      placeInFolder: jest.fn().mockResolvedValue({
        to: '/lib/Studio/2024-03-15 - Title.mp4',
        reason: null,
      }),
    };
    stash = {
      getOrganizerScene: jest
        .fn()
        .mockResolvedValue(linkedScene('/lib/in/Studio.24.03.15.Jane.Doe.mp4')),
    };
    activity = { record: jest.fn().mockResolvedValue(undefined) };
    service = new DownloadRematchService(
      {
        downloadDropIn: dropIns,
        downloadHandoff: downloads,
        librarySceneIndex: index,
      } as unknown as PrismaService,
      organizer as unknown as OrganizerService,
      handoff as unknown as DownloadHandoffService,
      stash as unknown as StashAdapter,
    );
    Object.assign(service, { activity });
    service.now = () => now;
  });

  it('looks up unmatched drop-ins and your own downloads again, newest first', async () => {
    expect(await service.run()).toBe(1);

    // Only the last two weeks' imports, and not the linked one.
    expect(dropIns.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'imported',
          finishedAt: { gte: new Date(now - 14 * day) },
        }) as unknown,
      }),
    );
    expect(organizer.identifyNewScenes).toHaveBeenCalledWith(['11', '13'], {
      trustNames: true,
    });
  });

  it('puts a scene matched now in its folder, named by your pattern, and says so', async () => {
    await service.run();

    expect(handoff.placeInFolder).toHaveBeenCalledWith(
      '11',
      '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
    );
    expect(handoff.placeInFolder).toHaveBeenCalledTimes(1);
    expect(dropIns.rows[0]).toMatchObject({
      placePending: false,
      rematchTriedAt: new Date(now),
      finalPath: '/lib/Studio/2024-03-15 - Title.mp4',
      matchedBy: 'later',
    });
    // Not matched: noted as tried, not to place; a likely match to check.
    expect(downloads.rows[0]).toMatchObject({
      placePending: false,
      rematchTriedAt: new Date(now),
      matchedBy: 'proposed',
    });
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Matched “Studio.24.03.15.Jane.Doe.mp4” on a later look',
      }),
    );
  });

  it('marks each one before looking it up, so a run stopped part way loses nothing', async () => {
    const marked: boolean[] = [];
    organizer.identifyNewScenes.mockImplementation(() => {
      marked.push(dropIns.rows[0].placePending, downloads.rows[0].placePending);
      return Promise.reject(new Error('stopped'));
    });
    await expect(service.run()).rejects.toThrow('stopped');
    expect(marked).toEqual([true, true]);

    // The next run checks both: the linked one is placed, the other unmarked.
    stash.getOrganizerScene.mockImplementation((_config, id: string) =>
      Promise.resolve(
        id === '11'
          ? linkedScene('/lib/in/Studio.24.03.15.Jane.Doe.mp4')
          : { files: [{ path: '/lib/in/own.mp4' }], stashIds: [] },
      ),
    );
    organizer.identifyNewScenes.mockClear();
    await service.run();
    expect(organizer.identifyNewScenes).not.toHaveBeenCalled();
    expect(handoff.placeInFolder).toHaveBeenCalledTimes(1);
    expect(dropIns.rows[0].placePending).toBe(false);
    expect(downloads.rows[0].placePending).toBe(false);
  });

  it('places one linked meanwhile some other way, which the look-up skips', async () => {
    // Scene 11 was linked by another path; the look-up skips it entirely.
    organizer.identifyNewScenes.mockResolvedValue({
      linked: [],
      matched: [],
      proposed: [],
      byName: [],
      left: ['13'],
    });
    await service.run();
    expect(handoff.placeInFolder).toHaveBeenCalledWith(
      '11',
      '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
    );
    expect(dropIns.rows[0].placePending).toBe(false);
    // 13 is still unmatched: unmarked, not placed.
    expect(downloads.rows[0].placePending).toBe(false);
    expect(handoff.placeInFolder).toHaveBeenCalledTimes(1);
  });

  it('looks up only the ones it could mark first', async () => {
    downloads.update.mockRejectedValueOnce(new Error('database busy'));
    await service.run();
    // h1 couldn't be marked: left for another day, not looked up.
    expect(organizer.identifyNewScenes).toHaveBeenCalledWith(['11'], {
      trustNames: true,
    });
    expect(downloads.rows[0].rematchTriedAt).toBeNull();
  });

  it('places a matched file on a later run when it couldn’t be placed', async () => {
    stash.getOrganizerScene.mockRejectedValueOnce(new Error('Stash is down'));
    await service.run();
    expect(handoff.placeInFolder).not.toHaveBeenCalled();
    expect(dropIns.rows[0].placePending).toBe(true);

    // Next day: it's linked now, so not looked up, but still placed.
    index.findMany.mockResolvedValue([
      { stashSceneId: '11' },
      { stashSceneId: '12' },
      { stashSceneId: '13' },
    ]);
    organizer.identifyNewScenes.mockClear();
    await service.run();
    expect(organizer.identifyNewScenes).not.toHaveBeenCalled();
    expect(handoff.placeInFolder).toHaveBeenCalledWith(
      '11',
      '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
    );
    expect(dropIns.rows[0]).toMatchObject({
      placePending: false,
      finalPath: '/lib/Studio/2024-03-15 - Title.mp4',
    });
  });

  it('says one linked since some other way is matched, keeping how one was matched', async () => {
    dropIns.rows[1].matchedBy = 'proposed';
    downloads.rows[0].matchedBy = 'name';
    index.findMany.mockResolvedValue([
      { stashSceneId: '11' },
      { stashSceneId: '12' },
      { stashSceneId: '13' },
    ]);
    await service.run();
    expect(dropIns.rows[0].matchedBy).toBe('stash');
    expect(dropIns.rows[1].matchedBy).toBe('stash');
    expect(downloads.rows[0].matchedBy).toBe('name');
  });

  it('says one is matched when a look-up linked it but stopped before saying so', async () => {
    // Linked, then stopped: the next run only places it.
    dropIns.rows[0].placePending = true;
    await service.run();
    expect(dropIns.rows[0]).toMatchObject({
      placePending: false,
      matchedBy: 'stash',
    });
  });

  it('notes a link even when something is in the way of its folder', async () => {
    dropIns.rows[0].placePending = true;
    handoff.placeInFolder.mockResolvedValue({
      to: '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
      reason: 'Something is already at /lib/Studio/x.mp4.',
    });
    await service.run();
    expect(dropIns.rows[0]).toMatchObject({
      placePending: true,
      matchedBy: 'stash',
    });
  });

  it('saves how it was matched when the look-up couldn’t, once it’s placed', async () => {
    // The look-up's own note fails to save; placing saves it.
    const update = dropIns.update.getMockImplementation()!;
    dropIns.update.mockImplementation((args) =>
      'rematchTriedAt' in args.data
        ? Promise.reject(new Error('busy'))
        : update(args),
    );
    await service.run();
    expect(dropIns.rows[0]).toMatchObject({
      placePending: false,
      matchedBy: 'later',
    });
  });

  it('saves how it was matched with the placing, when every note before it failed', async () => {
    // Only the save that places it gets through.
    const update = dropIns.update.getMockImplementation()!;
    dropIns.update.mockImplementation((args) =>
      'finalPath' in args.data ||
      ('placePending' in args.data && !('rematchTriedAt' in args.data))
        ? update(args)
        : Promise.reject(new Error('busy')),
    );
    await service.run();
    expect(dropIns.rows[0]).toMatchObject({
      placePending: false,
      finalPath: '/lib/Studio/2024-03-15 - Title.mp4',
      matchedBy: 'later',
    });
  });

  it('keeps it marked when something is in the way of its folder', async () => {
    handoff.placeInFolder.mockResolvedValue({
      to: '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
      reason: 'Something is already at /lib/Studio/x.mp4.',
    });
    await service.run();
    expect(dropIns.rows[0].placePending).toBe(true);
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('places one waiting however many newer files came in since', async () => {
    const rows: Row[] = Array.from({ length: 300 }, (_, position) =>
      dropIn(`n${position}`, `n${position}`, now - day + position),
    );
    rows.push({
      ...dropIn('old', '99', now - 10 * day),
      placePending: true,
    });
    dropIns = table(rows);
    Object.assign(service, {
      prisma: {
        downloadDropIn: dropIns,
        downloadHandoff: table([]),
        librarySceneIndex: index,
      },
    });
    index.findMany.mockResolvedValue(
      rows.map((row) => ({ stashSceneId: row.stashSceneId })),
    );
    stash.getOrganizerScene.mockResolvedValue(linkedScene('/lib/in/old.mp4'));

    await service.run();

    expect(handoff.placeInFolder).toHaveBeenCalledWith('99', '/lib/in/old.mp4');
    expect(rows.at(-1)?.placePending).toBe(false);
  });

  it('runs once a day, not on every tick', async () => {
    await service.tick();
    await service.tick();
    expect(organizer.identifyNewScenes).toHaveBeenCalledTimes(1);

    now += day + 1;
    await service.tick();
    expect(organizer.identifyNewScenes).toHaveBeenCalledTimes(2);
  });

  it('asks nothing when everything is matched', async () => {
    index.findMany.mockResolvedValue([
      { stashSceneId: '11' },
      { stashSceneId: '12' },
      { stashSceneId: '13' },
    ]);
    expect(await service.run()).toBe(0);
    expect(organizer.identifyNewScenes).not.toHaveBeenCalled();
  });

  it('takes the ones waiting longest each day, so none is left out', async () => {
    // 41 unmatched drop-ins; only 40 are looked up a day.
    const rows = Array.from({ length: 41 }, (_, position) =>
      dropIn(`d${position}`, `s${position}`, now - day - position * 60_000),
    );
    Object.assign(service, {
      prisma: {
        downloadDropIn: table(rows),
        downloadHandoff: table([]),
        librarySceneIndex: { findMany: jest.fn().mockResolvedValue([]) },
      },
    });
    organizer.identifyNewScenes.mockResolvedValue({
      linked: [],
      matched: [],
      proposed: [],
      byName: [],
      left: [],
    });

    await service.run();
    const first = organizer.identifyNewScenes.mock.calls[0][0] as string[];
    expect(first).toHaveLength(40);
    // Newest first when none has been tried: the oldest waits.
    expect(first).not.toContain('s40');

    now += day;
    await service.run();
    const second = organizer.identifyNewScenes.mock.calls[1][0] as string[];
    expect(second[0]).toBe('s40');
  });
});
