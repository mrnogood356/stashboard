import type { DownloadDropIn, DownloadHandoff } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import type { DownloadDropInService } from './download-drop-in.service';
import type { DownloadHandoffService } from './download-handoff.service';
import type { DropInWatchStatusDto } from './download-handoff.model';
import {
  DownloadProcessingService,
  handoffItem,
} from './download-processing.service';

const at = new Date('2026-10-22T10:00:00Z');

function handoff(overrides: Partial<DownloadHandoff> = {}): DownloadHandoff {
  return {
    id: 'h1',
    nzoId: 'SABnzbd_nzo_1',
    sceneId: 'scene-1',
    provider: 'STASHDB',
    releaseTitle: 'Release.1080p',
    status: 'sent',
    sabPath: null,
    finalPath: null,
    stashSceneId: null,
    error: null,
    attempts: 0,
    finishedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function dropIn(overrides: Partial<DownloadDropIn> = {}): DownloadDropIn {
  return {
    id: 'd1',
    sourcePath: '/sab/complete/stashboard-downloads/Clip.mp4',
    size: BigInt(10),
    status: 'placed',
    finalPath: '/library/Clip.mp4',
    stashSceneId: null,
    error: null,
    attempts: 0,
    finishedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const watching: DropInWatchStatusDto = {
  state: 'watching',
  reason: null,
  message: null,
  hint: null,
  category: 'stashboard',
  folder: '/sab/complete/stashboard-downloads',
  sabFolder: '/downloads/complete/stashboard-downloads',
  checking: false,
  lastCheckAt: at.toISOString(),
  lastResult: 'No new videos.',
  nextCheckAt: at.toISOString(),
  settleSeconds: 45,
  settling: [
    {
      path: '/sab/complete/stashboard-downloads/New.mp4',
      name: 'New.mp4',
      size: 5,
      firstSeenAt: at.toISOString(),
      unchangedSince: at.toISOString(),
    },
  ],
  skipped: [],
  lastError: null,
};

describe('handoffItem', () => {
  const live = {
    queue: new Map([
      [
        'q1',
        {
          nzoId: 'q1',
          name: 'A',
          category: 'stashboard',
          status: 'Downloading',
          percentage: 42.4,
          timeLeft: '0:05:00',
        },
      ],
      [
        'q2',
        {
          nzoId: 'q2',
          name: 'B',
          category: 'stashboard',
          status: 'Paused',
          percentage: 0,
          timeLeft: null,
        },
      ],
    ]),
    history: new Map([
      [
        'h-done',
        {
          nzoId: 'h-done',
          name: 'C',
          category: 'stashboard',
          status: 'Completed',
          storage: '/downloads/C',
          failMessage: null,
        },
      ],
      [
        'h-unpack',
        {
          nzoId: 'h-unpack',
          name: 'D',
          category: 'stashboard',
          status: 'Extracting',
          storage: null,
          failMessage: null,
        },
      ],
      [
        'h-failed',
        {
          nzoId: 'h-failed',
          name: 'E',
          category: 'stashboard',
          status: 'Failed',
          storage: null,
          failMessage: 'Out of retention',
        },
      ],
    ]),
  };

  it('follows a download from SABnzbd’s queue to the library', () => {
    expect(handoffItem(handoff({ nzoId: 'q1' }), live)).toMatchObject({
      stage: 'downloading',
      progress: 42,
      timeLeft: '0:05:00',
      canIgnore: true,
      canRetry: false,
    });
    expect(handoffItem(handoff({ nzoId: 'q2' }), live)).toMatchObject({
      stage: 'queued',
      detail: 'Paused in SABnzbd.',
    });
    expect(
      handoffItem(handoff({ nzoId: 'h-unpack', status: 'downloading' }), live),
    ).toMatchObject({ stage: 'unpacking', detail: 'Extracting in SABnzbd.' });
    expect(handoffItem(handoff({ nzoId: 'h-done' }), live)).toMatchObject({
      stage: 'moving',
    });
    expect(handoffItem(handoff({ nzoId: 'h-failed' }), live)).toMatchObject({
      stage: 'failed',
      detail: expect.stringContaining('Out of retention'),
    });
    expect(
      handoffItem(
        handoff({ status: 'completed', finalPath: '/library/A.mp4' }),
        live,
      ),
    ).toMatchObject({
      stage: 'linking',
      detail: expect.stringContaining('/library/A.mp4'),
    });
    expect(
      handoffItem(handoff({ status: 'imported', finalPath: '/x' }), null),
    ).toMatchObject({ stage: 'done', canIgnore: false });
    expect(
      handoffItem(handoff({ status: 'failed', error: 'Nope' }), null),
    ).toMatchObject({ stage: 'failed', detail: 'Nope', canRetry: true });
  });

  it('still shows a download when SABnzbd can’t be asked', () => {
    expect(handoffItem(handoff(), null)).toMatchObject({
      stage: 'queued',
      progress: null,
    });
  });
});

describe('DownloadProcessingService', () => {
  function setup(rows: {
    open?: DownloadHandoff[];
    done?: DownloadHandoff[];
    placed?: DownloadDropIn[];
    recent?: DownloadDropIn[];
    watch?: DropInWatchStatusDto;
  }) {
    const prisma = {
      downloadHandoff: {
        findMany: jest.fn(({ where }: { where: { status: object } }) =>
          Promise.resolve('in' in where.status ? rows.open : rows.done),
        ),
      },
      downloadDropIn: {
        findMany: jest.fn(({ where }: { where: { status: unknown } }) =>
          Promise.resolve(
            where.status === 'placed' ? rows.placed : rows.recent,
          ),
        ),
      },
    };
    const handoffService = {
      getSettings: jest
        .fn()
        .mockResolvedValue({ enabled: true, category: 'stashboard' }),
      sabConfig: jest
        .fn()
        .mockResolvedValue({ baseUrl: 'http://sab', apiKey: 'k' }),
    };
    const sabnzbd = {
      queue: jest.fn().mockResolvedValue([
        {
          nzoId: 'SABnzbd_nzo_1',
          name: 'Release.1080p',
          category: 'stashboard',
          status: 'Downloading',
          percentage: 10,
          timeLeft: '0:10:00',
        },
      ]),
      history: jest.fn().mockResolvedValue([]),
    };
    const dropIns = {
      status: jest.fn().mockReturnValue(rows.watch ?? watching),
    };
    const service = new DownloadProcessingService(
      prisma as unknown as PrismaService,
      handoffService as unknown as DownloadHandoffService,
      dropIns as unknown as DownloadDropInService,
      sabnzbd as unknown as SabnzbdAdapter,
    );
    return { service, sabnzbd };
  }

  it('puts downloads and drop-ins in one place, with counts for Home', async () => {
    const { service } = setup({
      open: [handoff()],
      done: [
        handoff({
          id: 'h2',
          status: 'failed',
          error: 'Broken',
          updatedAt: new Date(at.getTime() - 3600_000),
        }),
      ],
      placed: [dropIn()],
      recent: [
        dropIn({ id: 'd2', status: 'imported', sourcePath: '/x/Done.mp4' }),
      ],
    });

    const snapshot = await service.snapshot(at.getTime());

    expect(snapshot.handoff).toEqual({
      enabled: true,
      sabnzbdReady: true,
      category: 'stashboard',
      sabnzbdUnreachable: false,
    });
    expect(snapshot.handoffs[0]).toMatchObject({
      stage: 'downloading',
      progress: 10,
    });
    expect(snapshot.recentHandoffs[0]).toMatchObject({
      stage: 'failed',
      canRetry: true,
    });
    expect(snapshot.dropIns.active[0]).toMatchObject({
      name: 'Clip.mp4',
      canRetry: false,
    });
    expect(snapshot.dropIns.recent[0]).toMatchObject({ name: 'Done.mp4' });
    // One download, one file settling, one waiting for Stash.
    expect(snapshot.activeCount).toBe(3);
    expect(snapshot.problemCount).toBe(1);
  });

  it('asks SABnzbd at most every few seconds, and only with downloads in flight', async () => {
    const { service, sabnzbd } = setup({
      open: [handoff()],
      done: [],
      placed: [],
      recent: [],
    });
    await service.snapshot(at.getTime());
    await service.snapshot(at.getTime() + 1_000);
    expect(sabnzbd.queue).toHaveBeenCalledTimes(1);
    await service.snapshot(at.getTime() + 10_000);
    expect(sabnzbd.queue).toHaveBeenCalledTimes(2);

    const idle = setup({ open: [], done: [], placed: [], recent: [] });
    await idle.service.snapshot();
    expect(idle.sabnzbd.queue).not.toHaveBeenCalled();
  });

  it('says when SABnzbd can’t be reached, and counts a watcher problem', async () => {
    const { service, sabnzbd } = setup({
      open: [handoff()],
      done: [],
      placed: [],
      recent: [],
      watch: {
        ...watching,
        state: 'problem',
        reason: 'folder-unreadable',
        settling: [],
      },
    });
    sabnzbd.queue.mockRejectedValue(new Error('down'));
    const snapshot = await service.snapshot(at.getTime());
    expect(snapshot.handoff.sabnzbdUnreachable).toBe(true);
    expect(snapshot.handoffs[0].stage).toBe('queued');
    expect(snapshot.problemCount).toBe(1);
  });
});
