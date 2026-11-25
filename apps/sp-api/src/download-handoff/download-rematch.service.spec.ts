import { Logger } from '@nestjs/common';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import type { DownloadHandoffService } from './download-handoff.service';
import { DownloadRematchService } from './download-rematch.service';

describe('DownloadRematchService', () => {
  const day = 24 * 3600_000;
  let now: number;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let organizer: { identifyNewScenes: jest.Mock };
  let handoff: { stashConfig: jest.Mock; placeInFolder: jest.Mock };
  let stash: { getOrganizerScene: jest.Mock };
  let activity: { record: jest.Mock };
  let service: DownloadRematchService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    now = Date.UTC(2026, 10, 20);
    prisma = {
      downloadDropIn: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'd1',
            sourcePath: '/drop/Studio.24.03.15.Jane.Doe.mp4',
            stashSceneId: '11',
            finalPath: '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
            finishedAt: new Date(now - 2 * day),
          },
          {
            id: 'd2',
            sourcePath: '/drop/linked.mp4',
            stashSceneId: '12',
            finalPath: '/lib/in/linked.mp4',
            finishedAt: new Date(now - day),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      downloadHandoff: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'h1',
            releaseTitle: 'My.Own.Download',
            stashSceneId: '13',
            finalPath: '/lib/in/own.mp4',
            finishedAt: new Date(now - 3 * day),
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      librarySceneIndex: {
        // Scene 12 is linked already.
        findMany: jest.fn().mockResolvedValue([{ stashSceneId: '12' }]),
      },
    };
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
      getOrganizerScene: jest.fn().mockResolvedValue({
        files: [{ path: '/lib/in/Studio.24.03.15.Jane.Doe.mp4' }],
      }),
    };
    activity = { record: jest.fn().mockResolvedValue(undefined) };
    service = new DownloadRematchService(
      prisma as unknown as PrismaService,
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
    expect(prisma.downloadDropIn.findMany).toHaveBeenCalledWith(
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
    // Marked as tried, and to place, before placing; then placed.
    expect(prisma.downloadDropIn.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { rematchTriedAt: new Date(now), placePending: true },
    });
    expect(prisma.downloadDropIn.update).toHaveBeenLastCalledWith({
      where: { id: 'd1' },
      data: {
        placePending: false,
        finalPath: '/lib/Studio/2024-03-15 - Title.mp4',
      },
    });
    // Not matched: only noted as tried.
    expect(prisma.downloadHandoff.update).toHaveBeenCalledWith({
      where: { id: 'h1' },
      data: { rematchTriedAt: new Date(now) },
    });
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Matched “Studio.24.03.15.Jane.Doe.mp4” on a later look',
      }),
    );
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
    prisma.librarySceneIndex.findMany.mockResolvedValue([
      { stashSceneId: '11' },
      { stashSceneId: '12' },
      { stashSceneId: '13' },
    ]);
    expect(await service.run()).toBe(0);
    expect(organizer.identifyNewScenes).not.toHaveBeenCalled();
  });

  it('places a matched file on a later run when it couldn’t be placed', async () => {
    stash.getOrganizerScene.mockRejectedValueOnce(new Error('Stash is down'));
    await service.run();
    expect(handoff.placeInFolder).not.toHaveBeenCalled();
    expect(prisma.downloadDropIn.update).toHaveBeenCalledTimes(1);

    // Next day: it's linked now, so not looked up, but still placed.
    prisma.downloadDropIn.findMany.mockResolvedValue([
      {
        id: 'd1',
        sourcePath: '/drop/Studio.24.03.15.Jane.Doe.mp4',
        stashSceneId: '11',
        finalPath: '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
        finishedAt: new Date(now - 2 * day),
        rematchTriedAt: new Date(now),
        placePending: true,
      },
    ]);
    prisma.downloadHandoff.findMany.mockResolvedValue([]);
    organizer.identifyNewScenes.mockClear();
    await service.run();
    expect(organizer.identifyNewScenes).not.toHaveBeenCalled();
    expect(handoff.placeInFolder).toHaveBeenCalledWith(
      '11',
      '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
    );
    expect(prisma.downloadDropIn.update).toHaveBeenLastCalledWith({
      where: { id: 'd1' },
      data: {
        placePending: false,
        finalPath: '/lib/Studio/2024-03-15 - Title.mp4',
      },
    });
  });

  it('keeps it marked when something is in the way of its folder', async () => {
    handoff.placeInFolder.mockResolvedValue({
      to: '/lib/in/Studio.24.03.15.Jane.Doe.mp4',
      reason: 'Something is already at /lib/Studio/x.mp4.',
    });
    await service.run();
    expect(prisma.downloadDropIn.update).toHaveBeenLastCalledWith({
      where: { id: 'd1' },
      data: { rematchTriedAt: new Date(now), placePending: true },
    });
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('takes the ones waiting longest each day, so none is left out', async () => {
    // 41 unmatched drop-ins; only 40 are looked up a day.
    const rows = Array.from({ length: 41 }, (_, index) => ({
      id: `d${index}`,
      sourcePath: `/drop/${index}.mp4`,
      stashSceneId: `s${index}`,
      finalPath: `/lib/in/${index}.mp4`,
      finishedAt: new Date(now - day - index * 60_000),
      rematchTriedAt: null as Date | null,
      placePending: false,
    }));
    prisma.downloadDropIn.findMany.mockImplementation(() =>
      Promise.resolve(rows.map((row) => ({ ...row }))),
    );
    prisma.downloadDropIn.update.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string };
        data: { rematchTriedAt?: Date };
      }) => {
        const row = rows.find((entry) => entry.id === where.id)!;
        if (data.rematchTriedAt) {
          row.rematchTriedAt = data.rematchTriedAt;
        }
        return Promise.resolve(row);
      },
    );
    prisma.downloadHandoff.findMany.mockResolvedValue([]);
    prisma.librarySceneIndex.findMany.mockResolvedValue([]);
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
