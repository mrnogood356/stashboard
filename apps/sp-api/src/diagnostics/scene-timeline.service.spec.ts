import { SceneLifecycle } from '@prisma/client';
import type { ActivityService } from '../activity/activity.service';
import type { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import type { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { SceneTimelineService } from './scene-timeline.service';

function indexRow(overrides: Record<string, unknown> = {}) {
  return {
    stashId: 'sdb-1',
    title: 'Summer Afternoon',
    requestStatus: 'REQUESTED',
    requestUpdatedAt: new Date('2026-10-20T09:00:00Z'),
    whisparrMovieId: 7,
    whisparrHasFile: false,
    whisparrQueuePosition: null,
    whisparrQueueStatus: 'downloading',
    whisparrQueueState: 'downloading',
    whisparrErrorMessage: null,
    stashAvailable: false,
    computedLifecycle: SceneLifecycle.DOWNLOADING,
    ...overrides,
  };
}

describe('SceneTimelineService', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let organizer: Record<string, jest.Mock>;
  let activity: Record<string, jest.Mock>;
  let whisparr: Record<string, jest.Mock>;
  let sabnzbd: Record<string, jest.Mock>;
  let handoff: Record<string, jest.Mock>;
  let service: SceneTimelineService;

  beforeEach(() => {
    prisma = {
      sceneIndex: {
        findUnique: jest.fn().mockResolvedValue(indexRow()),
        findMany: jest.fn().mockResolvedValue([indexRow()]),
      },
      sceneStashAlias: { findMany: jest.fn().mockResolvedValue([]) },
      request: {
        findFirst: jest.fn().mockResolvedValue({
          stashId: 'sdb-1',
          createdAt: new Date('2026-10-20T09:00:00Z'),
        }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { stashId: 'sdb-1', createdAt: new Date('2026-10-20T09:00:00Z') },
          ]),
      },
      downloadHandoff: { findMany: jest.fn().mockResolvedValue([]) },
      organizerRename: { findMany: jest.fn().mockResolvedValue([]) },
      integrationConfig: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          status: 'CONFIGURED',
          baseUrl: 'http://whisparr',
          apiKey: 'k',
        }),
      },
    };
    organizer = {
      stashScenesLinkedTo: jest.fn().mockResolvedValue([]),
      explainWaitingScene: jest.fn().mockResolvedValue(null),
    };
    activity = { mentioning: jest.fn().mockResolvedValue([]) };
    whisparr = {
      findMovieByStashId: jest.fn(),
      getQueueDetails: jest.fn().mockResolvedValue([
        {
          movieId: 7,
          title: 'Bright.Summer.Afternoon.1080p',
          indexer: 'NZBgeek',
          size: 100,
          sizeLeft: 25,
          timeLeft: null,
          estimatedCompletionTime: null,
          added: '2026-10-21T11:00:00Z',
          status: 'downloading',
          trackedDownloadState: 'downloading',
          trackedDownloadStatus: 'ok',
          errorMessage: null,
          messages: [],
        },
        { movieId: 99, title: 'Someone else', messages: [] },
      ]),
      getMovieHistory: jest.fn().mockResolvedValue([]),
    };
    sabnzbd = { queue: jest.fn().mockResolvedValue([]) };
    handoff = {
      stashConfig: jest.fn().mockResolvedValue({ baseUrl: 'http://stash' }),
      sabConfig: jest.fn().mockResolvedValue(null),
      getSettings: jest.fn().mockResolvedValue({ category: 'stashboard' }),
    };
    service = new SceneTimelineService(
      prisma as unknown as PrismaService,
      organizer as unknown as OrganizerService,
      activity as unknown as ActivityService,
      whisparr as unknown as WhisparrAdapter,
      sabnzbd as unknown as SabnzbdAdapter,
      handoff as unknown as DownloadHandoffService,
    );
  });

  it('merges Stashboard’s records, Whisparr’s queue and history into one story', async () => {
    const timeline = await service.forScene(' sdb-1 ');

    expect(whisparr.getQueueDetails).toHaveBeenCalledWith(
      { baseUrl: 'http://whisparr', apiKey: 'k' },
      7,
    );
    expect(whisparr.getMovieHistory).toHaveBeenCalledWith(
      { baseUrl: 'http://whisparr', apiKey: 'k' },
      7,
    );
    expect(organizer.stashScenesLinkedTo).toHaveBeenCalledWith(['sdb-1']);
    expect(activity.mentioning).toHaveBeenCalledWith(['Summer Afternoon']);
    expect(timeline.stashId).toBe('sdb-1');
    expect(timeline.steps.map((step) => step.step)).toEqual([
      'requested',
      'searching',
      'grabbed',
      'downloading',
    ]);
    expect(timeline.now).toBe('Downloading · 75%');
  });

  it('finds the scene in Whisparr when the index doesn’t know its movie yet', async () => {
    prisma.sceneIndex.findUnique.mockResolvedValue(null);
    whisparr.findMovieByStashId.mockResolvedValue({
      movieId: 7,
      stashId: 'sdb-1',
      hasFile: false,
    });

    await service.forScene('sdb-1');

    expect(whisparr.getMovieHistory).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('never fails when a source is down: those steps say unknown', async () => {
    whisparr.getQueueDetails.mockRejectedValue(
      new Error('Whisparr is offline'),
    );
    whisparr.getMovieHistory.mockRejectedValue(
      new Error('Whisparr is offline'),
    );
    organizer.stashScenesLinkedTo.mockRejectedValue(new Error('Stash is down'));
    activity.mentioning.mockRejectedValue(new Error('db'));

    const timeline = await service.forScene('sdb-1');

    expect(timeline.unknown).toEqual(['Whisparr', 'Stash', 'the activity log']);
    expect(timeline.steps[0]).toMatchObject({
      step: 'requested',
      status: 'done',
    });
  });

  it('only asks about waiting for import while the scene waits for it', async () => {
    await service.forScene('sdb-1');
    expect(organizer.explainWaitingScene).not.toHaveBeenCalled();

    prisma.sceneIndex.findUnique.mockResolvedValue(
      indexRow({ computedLifecycle: SceneLifecycle.IMPORT_PENDING }),
    );
    await service.forScene('sdb-1');
    expect(organizer.explainWaitingScene).toHaveBeenCalled();
  });

  it('tells many scenes from one look at the queue, without Stash or history', async () => {
    prisma.sceneIndex.findMany.mockResolvedValue([
      indexRow(),
      indexRow({
        stashId: 'sdb-2',
        whisparrMovieId: 8,
        whisparrQueueStatus: null,
        whisparrQueueState: null,
        computedLifecycle: SceneLifecycle.REQUESTED,
      }),
    ]);

    const items = await service.forScenes(['sdb-1', 'sdb-2', 'sdb-1', ' ']);

    expect(whisparr.getQueueDetails).toHaveBeenCalledTimes(1);
    expect(whisparr.getQueueDetails).toHaveBeenCalledWith({
      baseUrl: 'http://whisparr',
      apiKey: 'k',
    });
    expect(whisparr.getMovieHistory).not.toHaveBeenCalled();
    expect(organizer.stashScenesLinkedTo).not.toHaveBeenCalled();
    expect(items.map((item) => [item.stashId, item.now])).toEqual([
      ['sdb-1', 'Downloading · 75%'],
      ['sdb-2', 'Searching for a release'],
    ]);
  });

  it('reads SABnzbd’s queue only while a download is in it', async () => {
    prisma.sceneIndex.findMany.mockResolvedValue([]);
    prisma.request.findMany.mockResolvedValue([]);
    prisma.downloadHandoff.findMany.mockResolvedValue([
      {
        nzoId: 'nzo-1',
        sceneId: 'fdb-1',
        releaseTitle: 'Release',
        status: 'downloading',
        finalPath: null,
        stashSceneId: null,
        error: null,
        createdAt: new Date('2026-10-21T11:00:00Z'),
      },
    ]);
    handoff.sabConfig.mockResolvedValue({ baseUrl: 'http://sab' });
    sabnzbd.queue.mockResolvedValue([
      {
        nzoId: 'nzo-1',
        name: 'Release',
        category: 'stashboard',
        status: 'Downloading',
        percentage: 30,
      },
    ]);

    const [item] = await service.forScenes(['fdb-1']);

    expect(sabnzbd.queue).toHaveBeenCalledWith(
      { baseUrl: 'http://sab' },
      'stashboard',
    );
    expect(item.route).toBe('sabnzbd');
    expect(item.now).toBe('Downloading · 30%');
  });
});
