import { SceneLifecycle } from '@prisma/client';
import type { StashOrganizerScene } from '../providers/stash/stash.adapter';
import type { WhisparrQueueDetail } from '../providers/whisparr/whisparr.adapter';
import type { TimelineStep } from './scene-timeline.model';
import { buildTimeline, eta, TimelineFacts } from './scene-timeline.util';

const NOW = new Date('2026-10-21T12:00:00Z');

function row(overrides: Partial<NonNullable<TimelineFacts['row']>> = {}) {
  return {
    title: 'Summer Afternoon',
    requestUpdatedAt: new Date('2026-10-20T09:00:00Z'),
    whisparrMovieId: 7,
    whisparrHasFile: false,
    whisparrQueueStatus: null,
    whisparrQueueState: null,
    whisparrErrorMessage: null,
    stashAvailable: false,
    computedLifecycle: SceneLifecycle.REQUESTED,
    ...overrides,
  };
}

function queueItem(
  overrides: Partial<WhisparrQueueDetail> = {},
): WhisparrQueueDetail {
  return {
    movieId: 7,
    title: 'Bright.Summer.Afternoon.1080p',
    indexer: 'NZBgeek',
    size: 1000,
    sizeLeft: 580,
    timeLeft: '00:12:30',
    estimatedCompletionTime: null,
    added: '2026-10-21T11:00:00Z',
    status: 'downloading',
    trackedDownloadState: 'downloading',
    trackedDownloadStatus: 'ok',
    errorMessage: null,
    messages: [],
    ...overrides,
  };
}

function stashScene(
  overrides: Partial<StashOrganizerScene> = {},
): StashOrganizerScene {
  return {
    id: '12',
    title: 'Summer Afternoon',
    code: null,
    date: null,
    organized: true,
    screenshotVersion: null,
    studio: null,
    performers: [],
    tagIds: [],
    stashIds: [{ endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-1' }],
    createdAt: '2026-10-21T11:40:00Z',
    files: [
      {
        id: 'f1',
        path: '/data/Bright/Summer Afternoon.mp4',
        basename: 'Summer Afternoon.mp4',
        duration: 1800,
        size: 1000,
        width: 1920,
        height: 1080,
        fingerprints: [{ type: 'phash', value: 'abc' }],
      },
    ],
    ...overrides,
  };
}

function facts(overrides: Partial<TimelineFacts> = {}): TimelineFacts {
  return {
    stashId: 'sdb-1',
    request: {
      createdAt: new Date('2026-10-20T09:00:00Z'),
      updatedAt: new Date('2026-10-20T09:00:00Z'),
    },
    row: row(),
    handoffs: [],
    queue: { value: [], error: null },
    history: { value: [], error: null },
    ...overrides,
  };
}

/** "step:status" for each step, for short assertions. */
function shape(steps: TimelineStep[]): string[] {
  return steps.map((step) => `${step.step}:${step.status}`);
}

describe('buildTimeline', () => {
  it('shows a fresh Whisparr request as searching, with picking a release as the way on', () => {
    const timeline = buildTimeline(facts(), NOW);

    expect(timeline.route).toBe('whisparr');
    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'searching:current',
    ]);
    expect(timeline.steps[0].at).toBe('2026-10-20T09:00:00.000Z');
    expect(timeline.steps[1].action).toEqual({
      kind: 'pick-release',
      label: 'Pick a release',
    });
    expect(timeline.now).toBe('Searching for a release');
  });

  it('tells the grab and download progress from Whisparr’s history and queue', () => {
    const timeline = buildTimeline(
      facts({
        queue: { value: [queueItem()], error: null },
        history: {
          value: [
            {
              eventType: 'grabbed',
              date: '2026-10-21T11:00:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              indexer: 'NZBgeek',
              downloadClient: 'SABnzbd',
              message: null,
              importedPath: null,
            },
          ],
          error: null,
        },
      }),
      NOW,
    );

    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'searching:done',
      'grabbed:done',
      'downloading:current',
    ]);
    const [, , grabbed, downloading] = timeline.steps;
    expect(grabbed).toMatchObject({
      at: '2026-10-21T11:00:00Z',
      detail: 'Bright.Summer.Afternoon.1080p · NZBgeek',
    });
    expect(downloading).toMatchObject({
      progress: 42,
      detail: '42% · about 13 min left',
    });
    expect(timeline.now).toBe('Downloading · 42%');
  });

  it('marks a failed download with Whisparr’s reason and suggests another release', () => {
    const timeline = buildTimeline(
      facts({
        history: {
          value: [
            {
              eventType: 'downloadFailed',
              date: '2026-10-21T11:30:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              indexer: null,
              downloadClient: null,
              message: 'Unpacking failed',
              importedPath: null,
            },
            {
              eventType: 'grabbed',
              date: '2026-10-21T11:00:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              indexer: 'NZBgeek',
              downloadClient: null,
              message: null,
              importedPath: null,
            },
          ],
          error: null,
        },
      }),
      NOW,
    );

    const failed = timeline.steps[timeline.steps.length - 1];
    expect(failed).toMatchObject({
      step: 'downloading',
      status: 'failed',
      at: '2026-10-21T11:30:00Z',
      detail: 'Whisparr says: Unpacking failed',
      action: { kind: 'pick-release', label: 'Pick another release' },
    });
    expect(timeline.now).toBe('Download failed');
  });

  it('follows an import into Stash: matched, renamed and previews', () => {
    const timeline = buildTimeline(
      facts({
        row: row({
          whisparrHasFile: true,
          stashAvailable: true,
          computedLifecycle: SceneLifecycle.AVAILABLE,
        }),
        history: {
          value: [
            {
              eventType: 'downloadFolderImported',
              date: '2026-10-21T11:35:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              indexer: null,
              downloadClient: null,
              message: null,
              importedPath: '/media/Bright/Summer Afternoon.mp4',
            },
            {
              eventType: 'grabbed',
              date: '2026-10-21T11:00:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              indexer: 'NZBgeek',
              downloadClient: null,
              message: null,
              importedPath: null,
            },
          ],
          error: null,
        },
        stash: { value: [stashScene()], error: null },
        renames: [
          {
            toPath: '/data/Bright Studio/Summer Afternoon.mp4',
            createdAt: new Date('2026-10-21T11:45:00Z'),
          },
        ],
      }),
      NOW,
    );

    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'searching:done',
      'grabbed:done',
      'downloading:done',
      'downloaded:done',
      'importing:done',
      'in-stash:done',
      'matched:done',
      'renamed:done',
      'previews:done',
    ]);
    expect(timeline.steps[5].detail).toBe(
      'To /media/Bright/Summer Afternoon.mp4',
    );
    expect(timeline.steps[6].at).toBe('2026-10-21T11:40:00Z');
    expect(timeline.steps[8].detail).toBe(
      'To /data/Bright Studio/Summer Afternoon.mp4',
    );
    expect(timeline.now).toBe('In your library');
  });

  it('says when Stash has the file but it isn’t linked, and points at the matches', () => {
    const timeline = buildTimeline(
      facts({
        row: row({
          whisparrHasFile: true,
          computedLifecycle: SceneLifecycle.IMPORT_PENDING,
        }),
        stash: { value: [], error: null },
        waiting: {
          stashId: 'sdb-1',
          title: 'Summer Afternoon',
          path: '/data/Bright/Summer Afternoon.mp4',
          linkedTo: null,
          kind: 'not-linked',
          reason: 'Stash has the file, but it isn’t linked yet.',
        },
      }),
      NOW,
    );

    expect(shape(timeline.steps).slice(-2)).toEqual([
      'in-stash:done',
      'matched:failed',
    ]);
    expect(timeline.steps[timeline.steps.length - 1]).toMatchObject({
      detail: 'Stash has the file, but it isn’t linked yet.',
      action: { kind: 'check-matches', label: 'Check these matches' },
    });
  });

  it('marks Whisparr’s steps unknown when it can’t be asked, and still tells the rest', () => {
    const down = { value: null, error: 'Whisparr is offline' };
    const timeline = buildTimeline(facts({ queue: down, history: down }), NOW);

    expect(timeline.unknown).toEqual(['Whisparr']);
    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'searching:unknown',
    ]);
    expect(timeline.steps[1].detail).toBe('Couldn’t ask Whisparr.');
  });

  it('marks Stash’s steps unknown when it can’t be asked', () => {
    const timeline = buildTimeline(
      facts({
        row: row({ whisparrHasFile: true }),
        stash: { value: null, error: 'Stash is offline' },
      }),
      NOW,
    );

    expect(timeline.unknown).toEqual(['Stash']);
    expect(timeline.steps[timeline.steps.length - 1]).toMatchObject({
      step: 'in-stash',
      status: 'unknown',
    });
  });

  it('tells a SABnzbd handoff: progress while downloading', () => {
    const timeline = buildTimeline(
      facts({
        request: null,
        row: null,
        queue: null,
        history: null,
        handoffs: [
          {
            nzoId: 'nzo-1',
            releaseTitle: 'Bright.Summer.Afternoon.1080p',
            status: 'downloading',
            finalPath: null,
            stashSceneId: null,
            error: null,
            createdAt: new Date('2026-10-21T11:00:00Z'),
          },
        ],
        sabQueue: {
          value: [
            {
              nzoId: 'nzo-1',
              name: 'Bright.Summer.Afternoon.1080p',
              category: 'stashboard',
              status: 'Downloading',
              percentage: 64,
              timeLeft: '0:05:00',
            },
          ],
          error: null,
        },
      }),
      NOW,
    );

    expect(timeline.route).toBe('sabnzbd');
    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'grabbed:done',
      'downloading:current',
    ]);
    expect(timeline.steps[2]).toMatchObject({
      progress: 64,
      detail: '64% · about 5 min left',
    });
  });

  it('tells a SABnzbd handoff that was moved but not picked up by Stash', () => {
    const timeline = buildTimeline(
      facts({
        request: null,
        row: null,
        queue: null,
        history: null,
        handoffs: [
          {
            nzoId: 'nzo-1',
            releaseTitle: 'Bright.Summer.Afternoon.1080p',
            status: 'completed',
            finalPath: '/data/new/Summer Afternoon.mp4',
            stashSceneId: null,
            error: 'Moved, but Stash hasn’t picked it up.',
            createdAt: new Date('2026-10-21T11:00:00Z'),
          },
        ],
      }),
      NOW,
    );

    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'grabbed:done',
      'downloading:done',
      'downloaded:done',
      'moved:done',
      'in-stash:current',
    ]);
    expect(timeline.steps[4].detail).toBe('To /data/new/Summer Afternoon.mp4');
    expect(timeline.steps[5].action?.kind).toBe('scan');
  });

  it('tells a release sent through Prowlarr from the activity log', () => {
    const timeline = buildTimeline(
      facts({
        request: null,
        row: null,
        queue: null,
        history: null,
        activity: {
          value: [
            {
              id: 'a1',
              at: '2026-10-21T10:00:00Z',
              kind: 'request',
              title:
                'Sent a release of “Summer Afternoon” to download through Prowlarr',
              detail:
                'Summer.Afternoon.XXX, from Indexer, for “Summer Afternoon” (FansDB).',
              status: 'done',
              count: null,
              canUndo: false,
              undoneAt: null,
            },
          ],
          error: null,
        },
      }),
      NOW,
    );

    expect(timeline.route).toBe('prowlarr');
    expect(shape(timeline.steps)).toEqual([
      'requested:done',
      'downloading:unknown',
    ]);
    expect(timeline.steps[0].at).toBe('2026-10-21T10:00:00Z');
  });

  it('doesn’t take another scene’s Prowlarr download for this one', () => {
    const timeline = buildTimeline(
      facts({
        request: null,
        row: null,
        queue: null,
        history: null,
        titles: ['Summer Afternoon'],
        activity: {
          value: [
            {
              id: 'a1',
              at: '2026-10-21T10:00:00Z',
              kind: 'request',
              title:
                'Sent a release of “Summer Afternoon 2” to download through Prowlarr',
              detail: null,
              status: 'done',
              count: null,
              canUndo: false,
              undoneAt: null,
            },
          ],
          error: null,
        },
      }),
      NOW,
    );

    expect(timeline.route).toBeNull();
  });

  it('follows a Whisparr re-request made after an older SABnzbd download', () => {
    const timeline = buildTimeline(
      facts({
        request: {
          createdAt: new Date('2026-01-10T09:00:00Z'),
          updatedAt: new Date('2026-03-10T09:00:00Z'),
        },
        handoffs: [
          {
            nzoId: 'nzo-1',
            releaseTitle: 'Bright.Summer.Afternoon.1080p',
            status: 'failed',
            finalPath: null,
            stashSceneId: null,
            error: 'Aborted',
            createdAt: new Date('2026-02-10T09:00:00Z'),
          },
        ],
      }),
      NOW,
    );

    expect(timeline.route).toBe('whisparr');
    expect(timeline.steps[0].at).toBe('2026-03-10T09:00:00.000Z');
  });

  it('tells a scene that’s only in the library, with previews still to make', () => {
    const timeline = buildTimeline(
      facts({
        request: null,
        row: row({
          whisparrMovieId: null,
          stashAvailable: true,
          computedLifecycle: SceneLifecycle.AVAILABLE,
        }),
        queue: null,
        history: null,
        stash: {
          value: [
            stashScene({
              files: [{ ...stashScene().files[0], fingerprints: [] }],
            }),
          ],
          error: null,
        },
      }),
      NOW,
    );

    expect(timeline.route).toBe('library');
    expect(shape(timeline.steps)).toEqual([
      'in-stash:done',
      'matched:done',
      'renamed:skipped',
      'previews:next',
    ]);
    expect(timeline.steps[3].action?.kind).toBe('generate');
    expect(timeline.now).toBe('In your library');
  });

  it('has no story for a scene that was never requested and isn’t in Stash', () => {
    const timeline = buildTimeline(
      facts({
        request: null,
        row: row({
          whisparrMovieId: null,
          computedLifecycle: SceneLifecycle.NOT_REQUESTED,
        }),
        queue: null,
        history: null,
      }),
      NOW,
    );

    expect(timeline.route).toBeNull();
    expect(timeline.steps).toEqual([]);
  });

  it('falls back to Stashboard’s index without Whisparr’s history (the batch)', () => {
    const timeline = buildTimeline(
      facts({
        history: undefined,
        queue: null,
        row: row({
          computedLifecycle: SceneLifecycle.FAILED,
          whisparrQueueState: 'failed',
          whisparrErrorMessage: 'Not enough disk space',
        }),
      }),
      NOW,
    );

    expect(timeline.steps[timeline.steps.length - 1]).toMatchObject({
      step: 'downloading',
      status: 'failed',
      detail: 'Whisparr says: Not enough disk space',
    });
  });
});

describe('eta', () => {
  it('reads Whisparr’s and SABnzbd’s time left, or the finish time', () => {
    expect(eta('00:00:20', null, NOW)).toBe('under a minute left');
    expect(eta('1.02:00:00', null, NOW)).toBe('about 26 h left');
    expect(eta('3.00:00:00', null, NOW)).toBe('about 3 days left');
    expect(eta(null, '2026-10-21T14:00:00Z', NOW)).toBe('about 2 h left');
    expect(eta(null, null, NOW)).toBeNull();
  });
});
