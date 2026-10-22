import { SceneLifecycle } from '@prisma/client';
import type { ActivityService } from '../activity/activity.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StashOrganizerScene } from '../providers/stash/stash.adapter';
import type { EvidenceSection } from './scene-evidence.model';
import { SceneEvidenceService } from './scene-evidence.service';

const STASHDB = 'https://stashdb.org/graphql';

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
    stashIds: [{ endpoint: STASHDB, stashId: 'sdb-1' }],
    files: [
      {
        id: 'f1',
        path: '/data/Bright/Summer Afternoon.mp4',
        basename: 'Summer Afternoon.mp4',
        duration: 1800,
        size: 1_610_612_736,
        width: 1920,
        height: 1080,
        fingerprints: [{ type: 'phash', value: 'abc' }],
      },
    ],
    ...overrides,
  };
}

function indexRow(overrides: Record<string, unknown> = {}) {
  return {
    stashId: 'sdb-1',
    title: 'Summer Afternoon',
    requestStatus: null,
    whisparrMovieId: 7,
    whisparrHasFile: true,
    whisparrQueuePosition: null,
    whisparrQueueStatus: null,
    whisparrQueueState: null,
    whisparrErrorMessage: null,
    stashAvailable: false,
    computedLifecycle: SceneLifecycle.IMPORT_PENDING,
    whisparrLastSyncedAt: new Date('2026-10-21T10:00:00Z'),
    stashLastSyncedAt: null,
    lastSyncedAt: new Date('2026-10-21T10:00:00Z'),
    ...overrides,
  };
}

/** A section's facts as "label: value" lines, for short assertions. */
function lines(section: EvidenceSection | undefined): string[] {
  return (section?.groups ?? []).flatMap((group) =>
    group.facts.map((fact) => `${fact.label}: ${fact.value}`),
  );
}

describe('SceneEvidenceService', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let organizer: Record<string, jest.Mock>;
  let activity: Record<string, jest.Mock>;
  let service: SceneEvidenceService;

  const section = (
    result: { sections: EvidenceSection[] },
    id: EvidenceSection['id'],
  ) => result.sections.find((entry) => entry.id === id);

  beforeEach(() => {
    prisma = {
      sceneIndex: { findUnique: jest.fn().mockResolvedValue(indexRow()) },
      sceneStashAlias: { findMany: jest.fn().mockResolvedValue([]) },
      librarySceneIndex: { findUnique: jest.fn().mockResolvedValue(null) },
      downloadHandoff: { findMany: jest.fn().mockResolvedValue([]) },
    };
    organizer = {
      primaryCatalog: jest
        .fn()
        .mockResolvedValue({ name: 'StashDB', endpoint: STASHDB }),
      stashScenesLinkedTo: jest.fn().mockResolvedValue([stashScene()]),
      stashScene: jest.fn().mockResolvedValue(stashScene()),
      whisparrFileFor: jest.fn().mockResolvedValue({
        stashId: 'sdb-1',
        filePath: '/data/Bright/Summer Afternoon.mp4',
        folder: '/data/Bright',
        movieId: 7,
      }),
      explainWaitingScene: jest.fn().mockResolvedValue({
        stashId: 'sdb-1',
        kind: 'not-linked',
        reason: 'Stash has the file, but it isn’t linked yet.',
      }),
      renamePlansFor: jest.fn().mockResolvedValue({
        pattern: '{studio}/{title}',
        plans: [
          {
            sceneId: '12',
            fileId: 'f1',
            title: 'Summer Afternoon',
            from: '/data/Bright/Summer Afternoon.mp4',
            to: '/data/Bright Studio/Summer Afternoon.mp4',
            state: 'taken',
            taken: {
              otherSceneId: '40',
              sameSize: true,
              fix: 'merge',
              note: 'Same size, so almost surely the same video.',
            },
          },
        ],
      }),
    };
    activity = {
      mentioning: jest.fn().mockResolvedValue([
        {
          id: 'a1',
          at: '2026-10-20T08:30:00.000Z',
          kind: 'rename',
          title: 'Renamed 1 file',
          detail: '→ /data/Bright Studio/Summer Afternoon.mp4',
          status: 'done',
          count: 1,
          canUndo: false,
          undoneAt: null,
        },
      ]),
    };
    service = new SceneEvidenceService(
      prisma as unknown as PrismaService,
      organizer as unknown as OrganizerService,
      activity as unknown as ActivityService,
    );
  });

  it('gathers every section for a catalog scene', async () => {
    const result = await service.forCatalogScene(' sdb-1 ');

    expect(result).toMatchObject({
      kind: 'catalog',
      id: 'sdb-1',
      title: 'Summer Afternoon',
    });
    expect(result.sections.map((entry) => entry.id)).toEqual([
      'status',
      'whisparr',
      'stash',
      'rename',
      'activity',
    ]);
    // The organizer's own reason for "waiting for import", without nudging Whisparr.
    expect(section(result, 'status')?.summary).toBe(
      'Stash has the file, but it isn’t linked yet.',
    );
    expect(organizer.explainWaitingScene).toHaveBeenCalledWith(
      expect.objectContaining({ stashId: 'sdb-1' }),
    );
    expect(lines(section(result, 'status'))).toEqual(
      expect.arrayContaining([
        'Status: Awaiting import',
        'In your Stash library: No',
        'Whisparr has a file: Yes',
        'Whisparr queue: Not in the queue',
        'Checked with Whisparr: 2026-10-21 10:00 UTC',
        'Checked with Stash: Never',
      ]),
    );
    expect(lines(section(result, 'whisparr'))).toEqual(
      expect.arrayContaining([
        'In Whisparr: Yes',
        'Movie id: 7',
        'Has a file: Yes',
        'File (as Stash sees it): /data/Bright/Summer Afternoon.mp4',
      ]),
    );
    expect(section(result, 'stash')?.summary).toBe(
      'One Stash scene is linked to it.',
    );
    expect(section(result, 'stash')?.groups[0].heading).toBe(
      'Stash scene 12 · Summer Afternoon',
    );
    expect(lines(section(result, 'stash'))).toEqual([
      'Organized: Yes',
      'Linked to StashDB: sdb-1',
      'File: /data/Bright/Summer Afternoon.mp4',
      'Size: 1.5 GB',
      'Fingerprint (phash): Yes',
    ]);
    expect(organizer.renamePlansFor).toHaveBeenCalledWith(['12']);
    expect(section(result, 'rename')?.summary).toBe(
      'Another file already has the new name.',
    );
    expect(lines(section(result, 'rename'))).toEqual(
      expect.arrayContaining([
        'Plan: New name already taken',
        'From: /data/Bright/Summer Afternoon.mp4',
        'To: /data/Bright Studio/Summer Afternoon.mp4',
        'Other file’s scene: 40',
        'Same size: Yes',
        'Safe fix: Merge the other scene into this one',
      ]),
    );
    expect(lines(section(result, 'activity'))).toEqual([
      '2026-10-20 08:30 UTC: Renamed 1 file',
    ]);
    expect(activity.mentioning).toHaveBeenCalledWith(
      expect.arrayContaining([
        'Summer Afternoon',
        '/data/Bright/Summer Afternoon.mp4',
        'Summer Afternoon.mp4',
      ]),
    );
  });

  it('shows downloads sent to SABnzbd for the scene, when there are any', async () => {
    prisma.downloadHandoff.findMany.mockResolvedValue([
      {
        releaseTitle: 'Bright.24.03.15.Summer.Afternoon',
        status: 'failed',
        error: 'SABnzbd couldn’t download it: out of retention.',
        finalPath: null,
        createdAt: new Date('2026-10-21T09:00:00Z'),
      },
    ]);

    const result = await service.forCatalogScene('sdb-1');

    expect(result.sections.map((entry) => entry.id)).toContain('downloads');
    expect(section(result, 'downloads')?.summary).toBe(
      'Failed: SABnzbd couldn’t download it: out of retention.',
    );
    expect(section(result, 'downloads')?.groups[0].heading).toBe(
      'Bright.24.03.15.Summer.Afternoon',
    );
    expect(lines(section(result, 'downloads'))).toEqual([
      'Status: Failed',
      'Sent: 2026-10-21 09:00 UTC',
      'Reason: SABnzbd couldn’t download it: out of retention.',
    ]);
    expect(prisma.downloadHandoff.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sceneId: { in: ['sdb-1'] } } }),
    );
  });

  it('looks for scenes StashDB merged under another id too', async () => {
    prisma.sceneStashAlias.findMany.mockResolvedValue([
      { stashId: 'sdb-old', aliasOf: 'sdb-1' },
    ]);

    await service.forCatalogScene('sdb-1');

    expect(organizer.stashScenesLinkedTo).toHaveBeenCalledWith([
      'sdb-1',
      'sdb-old',
    ]);
    expect(organizer.whisparrFileFor).toHaveBeenCalledWith([
      'sdb-1',
      'sdb-old',
    ]);
  });

  it('keeps the other sections when Whisparr and Stash can’t be asked', async () => {
    organizer.whisparrFileFor.mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );
    organizer.stashScenesLinkedTo.mockRejectedValue(
      new Error('Set up Stash in Settings → Integrations first.'),
    );

    const result = await service.forCatalogScene('sdb-1');

    expect(section(result, 'whisparr')?.error).toBe(
      'Couldn’t ask Whisparr: connect ECONNREFUSED',
    );
    // What the index last saw still shows.
    expect(lines(section(result, 'whisparr'))).toEqual(
      expect.arrayContaining(['Has a file: Yes (as of the last sync)']),
    );
    expect(section(result, 'stash')?.error).toBe(
      'Couldn’t ask Stash: Set up Stash in Settings → Integrations first.',
    );
    expect(section(result, 'rename')?.error).toContain(
      'Couldn’t work out the rename',
    );
    expect(organizer.renamePlansFor).not.toHaveBeenCalled();
    expect(section(result, 'status')?.error).toBeNull();
    expect(section(result, 'activity')?.error).toBeNull();
  });

  it('says plainly when nothing is known about a catalog scene', async () => {
    prisma.sceneIndex.findUnique.mockResolvedValue(null);
    organizer.stashScenesLinkedTo.mockResolvedValue([]);
    organizer.whisparrFileFor.mockResolvedValue(null);
    activity.mentioning.mockResolvedValue([]);

    const result = await service.forCatalogScene('sdb-1');

    expect(section(result, 'status')?.summary).toContain(
      'hasn’t indexed this scene yet',
    );
    expect(section(result, 'whisparr')?.summary).toBe(
      'Whisparr doesn’t have this scene.',
    );
    expect(section(result, 'stash')?.summary).toBe(
      'No Stash scene is linked to this StashDB scene.',
    );
    expect(section(result, 'rename')?.summary).toBe(
      'Nothing to rename: Stash has no scene for it.',
    );
    expect(section(result, 'activity')?.summary).toBe(
      'Nothing in the activity log mentions this scene.',
    );
  });

  it('gives a plain reason for states other than waiting for import', async () => {
    prisma.sceneIndex.findUnique.mockResolvedValue(
      indexRow({
        computedLifecycle: SceneLifecycle.FAILED,
        whisparrErrorMessage: 'Sample file',
      }),
    );

    const result = await service.forCatalogScene('sdb-1');

    expect(section(result, 'status')?.summary).toBe(
      'Whisparr’s download failed or got stuck: Sample file',
    );
    expect(organizer.explainWaitingScene).not.toHaveBeenCalled();
  });

  it('follows a library scene to its catalog scene', async () => {
    const result = await service.forLocalScene('12');

    expect(result).toMatchObject({ kind: 'local', id: '12' });
    expect(organizer.whisparrFileFor).toHaveBeenCalledWith(
      ['sdb-1'],
      ['/data/Bright/Summer Afternoon.mp4'],
    );
    expect(prisma.sceneIndex.findUnique).toHaveBeenCalledWith({
      where: { stashId: 'sdb-1' },
    });
    expect(section(result, 'stash')?.summary).toBe(
      'Linked to StashDB scene sdb-1.',
    );
    expect(organizer.renamePlansFor).toHaveBeenCalledWith(['12']);
  });

  it('finds an unlinked library scene’s catalog scene by Whisparr’s file', async () => {
    organizer.stashScene.mockResolvedValue(stashScene({ stashIds: [] }));
    organizer.whisparrFileFor.mockResolvedValue({
      stashId: 'sdb-9',
      filePath: '/data/Bright/Summer Afternoon.mp4',
      folder: null,
      movieId: 9,
    });

    const result = await service.forLocalScene('12');

    expect(organizer.whisparrFileFor).toHaveBeenCalledWith(
      [],
      ['/data/Bright/Summer Afternoon.mp4'],
    );
    expect(prisma.sceneIndex.findUnique).toHaveBeenCalledWith({
      where: { stashId: 'sdb-9' },
    });
    expect(section(result, 'stash')?.summary).toBe('Not linked to StashDB.');
    expect(lines(section(result, 'stash'))).toContain('Stash-box links: None');
  });

  it('says a library scene not linked anywhere has no status', async () => {
    organizer.stashScene.mockResolvedValue(stashScene({ stashIds: [] }));
    organizer.whisparrFileFor.mockResolvedValue(null);

    const result = await service.forLocalScene('12');

    expect(section(result, 'status')?.summary).toContain(
      'Not linked to StashDB, so Stashboard tracks no status for it',
    );
    expect(prisma.sceneIndex.findUnique).not.toHaveBeenCalled();
  });

  it('still answers for a library scene when Stash can’t be asked', async () => {
    organizer.stashScene.mockRejectedValue(new Error('Stash is down'));
    organizer.primaryCatalog.mockRejectedValue(new Error('Stash is down'));
    organizer.renamePlansFor.mockRejectedValue(new Error('Stash is down'));
    prisma.librarySceneIndex.findUnique.mockResolvedValue({
      linkedStashId: 'sdb-1',
    });

    const result = await service.forLocalScene('12');

    expect(section(result, 'stash')?.error).toBe(
      'Couldn’t ask Stash: Stash is down',
    );
    expect(section(result, 'rename')?.error).toBe(
      'Couldn’t work out the rename: Stash is down',
    );
    // The library index still knows the link, so the status shows.
    expect(section(result, 'status')?.summary).toBe(
      'Stash has the file, but it isn’t linked yet.',
    );
  });
});
