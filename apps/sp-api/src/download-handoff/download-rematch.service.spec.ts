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
    expect(prisma.downloadDropIn.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { finalPath: '/lib/Studio/2024-03-15 - Title.mp4' },
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
});
