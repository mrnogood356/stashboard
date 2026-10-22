import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IndexingService } from '../indexing/indexing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type {
  StashAdapter,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import type {
  StashdbAdapter,
  StashdbMatchScene,
} from '../providers/stashdb/stashdb.adapter';
import {
  MatchCandidateDto,
  OrganizerService,
  dedupeTargets,
  pickSure,
  pickTargetRoot,
  planRename,
  planUnmatchedMove,
  staticPrefix,
  withoutRepeatedPrefix,
} from './organizer.service';
import type { WhisparrHandoffService } from './whisparr-handoff.service';

/** Background runs finish on their own; wait for that rather than a fixed time. */
async function waitUntilIdle(service: OrganizerService): Promise<void> {
  for (
    let attempt = 0;
    attempt < 500 && service.status().running;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function localScene(
  overrides: Partial<StashOrganizerScene> = {},
): StashOrganizerScene {
  return {
    id: '7',
    title: null,
    code: null,
    date: null,
    organized: false,
    screenshotVersion: '1',
    studio: null,
    performers: [],
    tagIds: ['t-old'],
    stashIds: [],
    files: [
      {
        id: 'f7',
        path: '/data/inbox/BrightStudio.23.08.14.Summer.Afternoon.mp4',
        basename: 'BrightStudio.23.08.14.Summer.Afternoon.mp4',
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

const remote: StashdbMatchScene = {
  id: 'remote-1',
  title: 'Summer Afternoon',
  code: null,
  details: 'About',
  director: null,
  date: '2023-08-14',
  duration: 1801,
  imageUrl: 'https://cdn.example/cover.jpg',
  studio: {
    id: 'rs',
    name: 'Bright Studio',
    imageUrl: 'https://cdn.example/studio.png',
  },
  performers: [
    {
      id: 'rp',
      name: 'Jane Doe',
      as: null,
      disambiguation: null,
      gender: 'FEMALE',
      imageUrl: 'https://cdn.example/jane.jpg',
    },
    {
      id: 'rm',
      name: 'John Roe',
      as: null,
      disambiguation: null,
      gender: 'MALE',
      imageUrl: null,
    },
  ],
  tags: [{ id: 'rt', name: 'Outdoors' }],
  urls: ['https://example.com/scene'],
};

describe('OrganizerService', () => {
  let settings: Record<string, unknown>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let stash: Record<string, jest.Mock>;
  let stashdb: Record<string, jest.Mock>;
  let service: OrganizerService;
  let handoff: Record<string, jest.Mock>;
  let indexing: Record<string, jest.Mock>;
  let catalog: Record<string, jest.Mock>;
  /** The match_proposal table, kept between service instances in a test. */
  let proposalRows: Map<string, unknown>;
  let makeService: () => OrganizerService;

  beforeEach(() => {
    proposalRows = new Map();
    settings = {
      key: 'GLOBAL',
      renamePattern: '{studio}/{date} - {title}',
      renameRoot: null,
      renameAfterMatch: false,
      moveUnmatched: false,
      cleanEmptyFolders: false,
      skipWhisparrFiles: true,
      autoMatchNightly: false,
      useStashScrapers: false,
      tpdbApiKey: null,
      sendToWhisparr: false,
      addToWhisparr: false,
      whisparrImportMode: 'move',
      whisparrPathFrom: null,
      whisparrPathTo: null,
      lastRunKind: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
    };
    prisma = {
      organizerSettings: {
        findUnique: jest.fn(() => Promise.resolve(settings)),
        create: jest.fn(),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          settings = { ...settings, ...data };
          return Promise.resolve(settings);
        }),
      },
      organizerRename: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
      },
      sceneIndex: { findMany: jest.fn().mockResolvedValue([]) },
      sceneStashAlias: { upsert: jest.fn().mockResolvedValue({}) },
      matchProposal: {
        findMany: jest.fn(() =>
          Promise.resolve(
            [...proposalRows].map(([sceneId, data]) => ({
              sceneId,
              data: JSON.parse(JSON.stringify(data)) as unknown,
            })),
          ),
        ),
        upsert: jest.fn(
          ({
            where,
            update,
          }: {
            where: { sceneId: string };
            update: { data: unknown };
          }) => {
            proposalRows.set(
              where.sceneId,
              JSON.parse(JSON.stringify(update.data)),
            );
            return Promise.resolve({});
          },
        ),
        deleteMany: jest.fn(
          ({ where }: { where: { sceneId: { in: string[] } } }) => {
            where.sceneId.in.forEach((id) => proposalRows.delete(id));
            return Promise.resolve({ count: 0 });
          },
        ),
      },
      integrationConfig: {
        findUnique: jest.fn().mockResolvedValue({
          type: 'STASH',
          enabled: true,
          status: 'CONFIGURED',
          baseUrl: 'http://stash.local',
          apiKey: null,
        }),
      },
    };
    stash = {
      getOrganizerScene: jest.fn().mockResolvedValue(localScene()),
      findOrganizerScenes: jest
        .fn()
        .mockResolvedValue({ total: 1, items: [localScene()] }),
      listStashBoxes: jest.fn().mockResolvedValue([
        {
          name: 'StashDB',
          endpoint: 'https://stashdb.org/graphql',
          apiKey: 'k',
        },
      ]),
      listFragmentSceneScrapers: jest.fn().mockResolvedValue([]),
      identifyWithScrapers: jest.fn().mockResolvedValue('job-1'),
      waitForJob: jest.fn().mockResolvedValue('FINISHED'),
      getIdentifyDefaults: jest.fn().mockResolvedValue({
        includeMalePerformers: null,
        createMissing: { performers: null, studio: null, tags: null },
      }),
      ensureStudio: jest.fn().mockResolvedValue('studio-1'),
      ensurePerformer: jest.fn().mockResolvedValue('performer-1'),
      ensureTag: jest.fn().mockResolvedValue('tag-1'),
      applySceneMatch: jest.fn().mockResolvedValue(undefined),
      getLibraryRoots: jest.fn().mockResolvedValue(['/data']),
      moveFile: jest.fn().mockResolvedValue(undefined),
      scanPaths: jest.fn().mockResolvedValue('scan-job'),
      removeExtraFile: jest.fn().mockResolvedValue(undefined),
      sceneIdsForPaths: jest.fn().mockResolvedValue([]),
      mergeScenes: jest.fn().mockResolvedValue(undefined),
      startLibraryTask: jest.fn().mockResolvedValue(null),
      listGalleryFolders: jest.fn().mockResolvedValue([]),
    };
    stashdb = {
      findScenesByFingerprints: jest.fn().mockResolvedValue([[remote]]),
      searchScenesByText: jest.fn().mockResolvedValue([]),
      getMatchScenesById: jest.fn().mockResolvedValue(new Map()),
    };
    catalog = {
      getInstanceCatalogProvider: jest
        .fn()
        .mockResolvedValue({ baseUrl: 'https://stashdb.org', apiKey: 'k' }),
    };
    indexing = {
      syncLibraryProjection: jest.fn().mockResolvedValue(null),
      requestImmediateRefresh: jest.fn().mockResolvedValue(undefined),
    };
    handoff = {
      send: jest.fn().mockResolvedValue({ sent: [], skipped: {}, failed: [] }),
      isAvailable: jest.fn().mockResolvedValue(true),
      missingInWhisparr: jest.fn().mockResolvedValue([]),
      catalogEndpoint: jest
        .fn()
        .mockResolvedValue('https://stashdb.org/graphql'),
      checkPath: jest.fn(),
      trackedStashIds: jest.fn().mockResolvedValue(new Set<string>()),
      trackedFolders: jest.fn().mockResolvedValue([]),
      filesAsStashSees: jest.fn().mockResolvedValue([]),
      refreshMovies: jest.fn().mockResolvedValue(undefined),
      rootFoldersAsStashSees: jest.fn().mockResolvedValue([]),
      repairPlan: jest.fn(),
      namingConfig: jest.fn().mockResolvedValue(null),
      resetPaths: jest.fn().mockResolvedValue(undefined),
      scanWhereWhisparrPut: jest.fn().mockResolvedValue(undefined),
    };
    makeService = () => {
      const made = new OrganizerService(
        prisma as unknown as PrismaService,
        stash as unknown as StashAdapter,
        stashdb as unknown as StashdbAdapter,
        catalog as unknown as CatalogProviderService,
        indexing as unknown as IndexingService,
        handoff as unknown as WhisparrHandoffService,
      );
      made.pause = () => Promise.resolve();
      return made;
    };
    service = makeService();
  });

  afterEach(() => service.onModuleDestroy());

  describe('linkDownloadedScene', () => {
    beforeEach(() => {
      prisma.integrationConfig.findUnique.mockImplementation(
        ({ where }: { where: { type: string } }) =>
          Promise.resolve(
            where.type === 'FANSDB'
              ? {
                  type: 'FANSDB',
                  enabled: true,
                  status: 'CONFIGURED',
                  baseUrl: 'https://fansdb.cc/graphql',
                  apiKey: 'mine',
                }
              : where.type === 'STASH'
                ? {
                    type: 'STASH',
                    enabled: true,
                    status: 'CONFIGURED',
                    baseUrl: 'http://stash.local',
                    apiKey: null,
                  }
                : null,
          ),
      );
      stash.listStashBoxes.mockResolvedValue([
        {
          name: 'StashDB',
          endpoint: 'https://stashdb.org/graphql',
          apiKey: 'k',
        },
        {
          name: 'FansDB',
          endpoint: 'https://fansdb.cc/graphql',
          apiKey: 'box',
        },
      ]);
      stashdb.getMatchScenesById.mockResolvedValue(
        new Map([['remote-1', remote]]),
      );
    });

    it('links the scene to the exact catalog scene it was downloaded for', async () => {
      await expect(
        service.linkDownloadedScene('7', {
          provider: 'FANSDB',
          sceneId: 'remote-1',
        }),
      ).resolves.toEqual({ title: 'Summer Afternoon' });

      // Stashboard's own FansDB key, and the endpoint Stash knows FansDB by.
      expect(stashdb.getMatchScenesById).toHaveBeenCalledWith(
        { baseUrl: 'https://fansdb.cc/graphql', apiKey: 'mine' },
        ['remote-1'],
      );
      expect(stashdb.findScenesByFingerprints).not.toHaveBeenCalled();
      expect(stash.applySceneMatch).toHaveBeenCalledWith(
        expect.anything(),
        '7',
        expect.objectContaining({
          title: 'Summer Afternoon',
          stashIds: [
            { endpoint: 'https://fansdb.cc/graphql', stashId: 'remote-1' },
          ],
        }),
      );
    });

    it('leaves the file where it is, even with “Rename after match” on', async () => {
      // Downloads go into their own folder in the destination instead
      // (placeInSceneFolder), never out into the library folder.
      settings.renameAfterMatch = true;
      await service.linkDownloadedScene('7', {
        provider: 'FANSDB',
        sceneId: 'remote-1',
      });
      expect(stash.moveFile).not.toHaveBeenCalled();
    });

    it('says plainly when the catalog isn’t set up or the scene is gone', async () => {
      await expect(
        service.linkDownloadedScene('7', {
          provider: 'STASHDB',
          sceneId: 'remote-1',
        }),
      ).rejects.toThrow('StashDB isn’t set up in Stashboard any more');

      stashdb.getMatchScenesById.mockResolvedValue(new Map());
      await expect(
        service.linkDownloadedScene('7', {
          provider: 'FANSDB',
          sceneId: 'remote-1',
        }),
      ).rejects.toThrow('FansDB has no scene remote-1 any more.');
      expect(stash.applySceneMatch).not.toHaveBeenCalled();
    });
  });

  describe('placeInSceneFolder', () => {
    let root: string;
    let destination: string;
    let current: string;
    let activity: { record: jest.Mock; registerUndo: jest.Mock };

    const matchedScene = (): StashOrganizerScene =>
      localScene({
        title: 'Summer Afternoon',
        date: '2023-08-14',
        studio: { id: 's1', name: 'Bright Studio' },
        stashIds: [
          { endpoint: 'https://fansdb.cc/graphql', stashId: 'remote-1' },
        ],
        files: [
          {
            ...localScene().files[0],
            path: current,
            basename: path.basename(current),
          },
        ],
      });

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'scene-folder-'));
      destination = path.join(root, 'stash content', 'fansdb');
      mkdirSync(destination, { recursive: true });
      current = path.join(destination, 'Bright.Studio.Summer.Afternoon.mkv');
      writeFileSync(current, 'video');
      stash.getLibraryRoots.mockResolvedValue([
        path.join(root, 'stash content'),
      ]);
      stash.getOrganizerScene.mockImplementation(() =>
        Promise.resolve(matchedScene()),
      );
      stash.moveFile.mockImplementation(
        (_config: unknown, _fileId: string, folder: string, name: string) => {
          current = path.join(folder, name);
          return Promise.resolve();
        },
      );
      activity = { record: jest.fn(), registerUndo: jest.fn() };
      Object.assign(service, { activity });
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('puts the file in a folder of its own, by the pattern, inside the destination', async () => {
      const from = current;
      const folder = path.join(
        destination,
        'Bright Studio',
        '2023-08-14 - Summer Afternoon',
      );
      await expect(
        service.placeInSceneFolder('7', from, destination),
      ).resolves.toEqual({
        to: path.join(folder, '2023-08-14 - Summer Afternoon.mkv'),
        reason: null,
      });
      // Through Stash, so it keeps the scene; inside the destination, not
      // the library folder.
      expect(stash.moveFile).toHaveBeenCalledWith(
        expect.anything(),
        'f7',
        folder,
        '2023-08-14 - Summer Afternoon.mkv',
      );
      // Recorded for Undo, like other renames.
      expect(prisma.organizerRename.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ fileId: 'f7', fromPath: from }),
      });
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'rename',
          undo: { type: 'rename-batch', batchId: expect.any(String) },
        }),
      );
    });

    it('doesn’t repeat a fixed folder the destination already ends in', async () => {
      settings.renamePattern = 'fansdb/{studio}/{date} - {title}';
      const { to } = await service.placeInSceneFolder(
        '7',
        current,
        destination,
      );
      expect(to).toBe(
        path.join(
          destination,
          'Bright Studio',
          '2023-08-14 - Summer Afternoon',
          '2023-08-14 - Summer Afternoon.mkv',
        ),
      );
    });

    it('keeps a pattern that already gives the scene its own folder', async () => {
      settings.renamePattern = '{studio}/{date} - {title}/{title}';
      const { to } = await service.placeInSceneFolder(
        '7',
        current,
        destination,
      );
      expect(to).toBe(
        path.join(
          destination,
          'Bright Studio',
          '2023-08-14 - Summer Afternoon',
          'Summer Afternoon.mkv',
        ),
      );
    });

    it('never replaces a file already at the target', async () => {
      const taken = path.join(
        destination,
        'Bright Studio',
        '2023-08-14 - Summer Afternoon',
        '2023-08-14 - Summer Afternoon.mkv',
      );
      mkdirSync(path.dirname(taken), { recursive: true });
      writeFileSync(taken, 'someone else');
      const from = current;

      const result = await service.placeInSceneFolder('7', from, destination);
      expect(result.to).toBe(from);
      expect(result.reason).toContain(`Something is already at ${taken}`);
      expect(result.reason).toContain(`It stayed at ${from}`);
      expect(stash.moveFile).not.toHaveBeenCalled();
      expect(prisma.organizerRename.create).not.toHaveBeenCalled();
    });

    it('leaves it when the pattern needs details the scene doesn’t have', async () => {
      stash.getOrganizerScene.mockImplementation(() =>
        Promise.resolve({ ...matchedScene(), title: null }),
      );
      const result = await service.placeInSceneFolder(
        '7',
        current,
        destination,
      );
      expect(result.reason).toContain('needs details the scene doesn’t have');
      expect(stash.moveFile).not.toHaveBeenCalled();
    });

    it('does nothing when it’s already in its folder', async () => {
      current = path.join(
        destination,
        'Bright Studio',
        '2023-08-14 - Summer Afternoon',
        '2023-08-14 - Summer Afternoon.mkv',
      );
      await expect(
        service.placeInSceneFolder('7', current, destination),
      ).resolves.toEqual({ to: current, reason: null });
      expect(stash.moveFile).not.toHaveBeenCalled();
    });

    it('says plainly when Stash doesn’t list the file any more', async () => {
      const result = await service.placeInSceneFolder(
        '7',
        path.join(destination, 'other.mkv'),
        destination,
      );
      expect(result.reason).toContain('Stash doesn’t list the file');
      expect(stash.moveFile).not.toHaveBeenCalled();
    });
  });

  it('finds a fingerprint match first', async () => {
    const [result] = await service.lookup(['7']);
    expect(stashdb.findScenesByFingerprints).toHaveBeenCalledWith(
      { baseUrl: 'https://stashdb.org', apiKey: 'k' },
      [[{ hash: 'abc', algorithm: 'PHASH' }]],
      true,
    );
    expect(stashdb.searchScenesByText).not.toHaveBeenCalled();
    expect(result.candidates[0]).toMatchObject({
      id: 's0-remote-1',
      source: 'StashDB',
      confidence: 'exact',
    });
  });

  it('searches by file name when no fingerprint matches', async () => {
    stashdb.findScenesByFingerprints.mockResolvedValue([[]]);
    stashdb.searchScenesByText.mockResolvedValue([remote]);
    const [result] = await service.lookup(['7']);
    expect(stashdb.searchScenesByText).toHaveBeenCalledWith(
      expect.anything(),
      'bright studio summer afternoon',
      8,
      true,
    );
    expect(result.searchedFor).toBe('bright studio summer afternoon');
    expect(result.candidates[0].confidence).toBe('strong');
  });

  it('searches your own words when given', async () => {
    stashdb.searchScenesByText.mockResolvedValue([remote]);
    const [result] = await service.lookup(
      ['7', '8'],
      'summer afternoon bright',
    );
    expect(stashdb.findScenesByFingerprints).not.toHaveBeenCalled();
    expect(stash.getOrganizerScene).toHaveBeenCalledTimes(1);
    expect(stashdb.searchScenesByText).toHaveBeenCalledWith(
      expect.anything(),
      'summer afternoon bright',
      8,
      true,
    );
    expect(result.candidates[0].id).toBe('s0-remote-1');
  });

  it('saves a match with studio, performers, tags, cover and StashDB id', async () => {
    await service.lookup(['7']);
    await service.apply('7', 's0-remote-1');
    expect(stash.ensureStudio).toHaveBeenCalledWith(expect.anything(), {
      name: 'Bright Studio',
      stashId: 'rs',
      endpoint: 'https://stashdb.org/graphql',
      imageUrl: 'https://cdn.example/studio.png',
      create: true,
    });
    expect(stash.ensurePerformer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'Jane Doe',
        imageUrl: 'https://cdn.example/jane.jpg',
        create: true,
      }),
    );
    expect(stash.ensurePerformer).toHaveBeenCalledTimes(2);
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({
        title: 'Summer Afternoon',
        studioId: 'studio-1',
        performerIds: ['performer-1'],
        tagIds: ['t-old', 'tag-1'],
        coverImageUrl: 'https://cdn.example/cover.jpg',
        stashIds: [
          { endpoint: 'https://stashdb.org/graphql', stashId: 'remote-1' },
        ],
      }),
    );
    expect(stash.moveFile).not.toHaveBeenCalled();
  });

  it('follows Stash’s Identify settings: no male performers, nothing new created', async () => {
    stash.getIdentifyDefaults.mockResolvedValue({
      includeMalePerformers: false,
      createMissing: { performers: false, studio: false, tags: false },
    });
    stash.ensureStudio.mockResolvedValue(null);
    stash.ensurePerformer.mockResolvedValue(null);
    stash.ensureTag.mockResolvedValue(null);
    await service.lookup(['7']);
    await service.apply('7', 's0-remote-1');
    expect(stash.ensurePerformer).toHaveBeenCalledTimes(1);
    expect(stash.ensurePerformer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'Jane Doe', create: false }),
    );
    expect(stash.ensureStudio).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ create: false }),
    );
    expect(stash.ensureTag).toHaveBeenCalledWith(
      expect.anything(),
      'Outdoors',
      false,
    );
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({
        studioId: null,
        performerIds: [],
        tagIds: ['t-old'],
      }),
    );
  });

  it('renames right after matching when that is on', async () => {
    settings.renameAfterMatch = true;
    await service.lookup(['7']);
    const matchedScene = localScene({
      title: 'Summer Afternoon',
      date: '2023-08-14',
      studio: { id: '1', name: 'Bright Studio' },
      stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
    });
    stash.getOrganizerScene
      .mockResolvedValueOnce(matchedScene)
      .mockResolvedValueOnce(matchedScene)
      .mockResolvedValue({
        ...matchedScene,
        files: [
          {
            ...matchedScene.files[0],
            path: '/data/Bright Studio/2023-08-14 - Summer Afternoon.mp4',
          },
        ],
      });
    const result = await service.apply('7', 's0-remote-1');
    expect(stash.moveFile).toHaveBeenCalledWith(
      expect.anything(),
      'f7',
      '/data/Bright Studio',
      '2023-08-14 - Summer Afternoon.mp4',
    );
    expect(prisma.organizerRename.create).toHaveBeenCalled();
    expect(result.renamedTo).toBe(
      '/data/Bright Studio/2023-08-14 - Summer Afternoon.mp4',
    );
  });

  it('also asks the other stash-boxes and ThePornDB, and saves with that site’s id', async () => {
    settings.tpdbApiKey = 'tpdb-key';
    stash.listStashBoxes.mockResolvedValue([
      { name: 'StashDB', endpoint: 'https://stashdb.org/graphql', apiKey: 'k' },
      { name: 'FansDB', endpoint: 'https://fansdb.cc/graphql', apiKey: 'f' },
    ]);
    stashdb.findScenesByFingerprints
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ ...remote, id: 'tp-9' }]]);
    const [result] = await service.lookup(['7']);
    expect(stashdb.findScenesByFingerprints).toHaveBeenCalledTimes(3);
    expect(stashdb.findScenesByFingerprints.mock.calls[1][0]).toEqual({
      baseUrl: 'https://fansdb.cc/graphql',
      apiKey: 'f',
    });
    expect(stashdb.findScenesByFingerprints.mock.calls[2][0]).toEqual({
      baseUrl: 'https://theporndb.net/graphql',
      apiKey: 'tpdb-key',
    });
    expect(stashdb.findScenesByFingerprints.mock.calls[2][2]).toBe(false);
    expect(result.candidates[0]).toMatchObject({
      id: 's2-tp-9',
      source: 'ThePornDB',
      confidence: 'exact',
    });

    await service.apply('7', 's2-tp-9');
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({
        stashIds: [
          { endpoint: 'https://theporndb.net/graphql', stashId: 'tp-9' },
        ],
      }),
    );
  });

  it('finds matches for you to check and saves only the ones you pick', async () => {
    settings.useStashScrapers = true;
    stash.listFragmentSceneScrapers.mockResolvedValue([
      { id: 'siteA', name: 'Site A' },
    ]);

    service.startAutoMatch();
    await waitUntilIdle(service);

    // Nothing is saved, and Stash's scrapers aren't run over the backlog.
    expect(stash.applySceneMatch).not.toHaveBeenCalled();
    expect(stash.identifyWithScrapers).not.toHaveBeenCalled();
    expect(service.status().message).toMatch(/found matches for 1 to check/);
    const [proposal] = await service.matchProposals();
    expect(proposal).toMatchObject({
      scene: { id: '7' },
      match: { id: 's0-remote-1', confidence: 'exact' },
    });
    await expect(service.proposalCount()).resolves.toBe(1);

    await service.startSaveProposals(['7']);
    await waitUntilIdle(service);
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({ title: remote.title }),
    );
    await expect(service.matchProposals()).resolves.toEqual([]);
    expect(proposalRows.size).toBe(0);
    expect(service.status().message).toMatch(/^Saved 1 match/);
  });

  it('shows the other matches with photos and tags, and saves the one you pick', async () => {
    const other: StashdbMatchScene = {
      ...remote,
      id: 'remote-2',
      title: 'Another Scene',
    };
    stashdb.findScenesByFingerprints.mockResolvedValue([[remote, other]]);

    service.startAutoMatch();
    await waitUntilIdle(service);
    const [proposal] = await service.matchProposals();
    expect(proposal.match).toMatchObject({
      cast: expect.any(Array),
      tags: remote.tags.map((tag) => tag.name),
    });
    expect(proposal.alternatives.map((entry) => entry.title)).toEqual([
      'Another Scene',
    ]);

    const chosen = await service.chooseProposal(
      '7',
      proposal.alternatives[0].id,
    );
    expect(chosen.match.title).toBe('Another Scene');
    expect(chosen.alternatives.map((entry) => entry.title)).toEqual([
      remote.title,
    ]);
    await service.startSaveProposals(['7']);
    await waitUntilIdle(service);
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({ title: 'Another Scene' }),
    );
  });

  it('forgets found matches you dismiss', async () => {
    service.startAutoMatch();
    await waitUntilIdle(service);
    await expect(service.dismissProposals(['7'])).resolves.toEqual({
      left: 0,
    });
    await expect(service.startSaveProposals(['7'])).rejects.toThrow(/gone/);
    expect(proposalRows.size).toBe(0);
  });

  it('keeps found matches through a restart, without any API key', async () => {
    const other: StashdbMatchScene = {
      ...remote,
      id: 'remote-2',
      title: 'Another Scene',
    };
    stashdb.findScenesByFingerprints.mockResolvedValue([[remote, other]]);
    service.startAutoMatch();
    await waitUntilIdle(service);
    const [proposal] = await service.matchProposals();
    await service.chooseProposal('7', proposal.alternatives[0].id);

    // Nothing secret is written down.
    expect(proposalRows.size).toBe(1);
    expect(JSON.stringify([...proposalRows.values()])).not.toMatch(
      /apiKey|"k"/,
    );

    // A fresh start reads the same list back, the picked match included.
    service.onModuleDestroy();
    service = makeService();
    const [restored] = await service.matchProposals();
    expect(restored).toEqual({ ...proposal, ...restored });
    expect(restored.match.title).toBe('Another Scene');
    await expect(service.proposalCount()).resolves.toBe(1);

    // Saving looks the source up again, API key and all.
    await service.startSaveProposals(['7']);
    await waitUntilIdle(service);
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({ title: 'Another Scene' }),
    );
    expect(proposalRows.size).toBe(0);
  });

  it('fails a kept match whose source is gone', async () => {
    service.startAutoMatch();
    await waitUntilIdle(service);
    service.onModuleDestroy();
    service = makeService();
    stash.listStashBoxes.mockResolvedValue([
      { name: 'Other box', endpoint: 'https://other.box/graphql', apiKey: 'x' },
    ]);
    catalog.getInstanceCatalogProvider.mockResolvedValue(null);

    await service.startSaveProposals(['7']);
    await waitUntilIdle(service);
    expect(stash.applySceneMatch).not.toHaveBeenCalled();
    expect(service.status().message).toMatch(/1 failed/);
    await expect(service.proposalCount()).resolves.toBe(1);
  });

  it('forgets a found match once the scene is matched by hand', async () => {
    service.startAutoMatch();
    await waitUntilIdle(service);
    await service.lookup(['7']);
    await service.apply('7', 's0-remote-1');
    expect(proposalRows.size).toBe(0);
    await expect(service.proposalCount()).resolves.toBe(0);
  });

  it('sends a StashDB match to Whisparr instead of renaming it', async () => {
    settings.sendToWhisparr = true;
    settings.renameAfterMatch = true;
    handoff.send.mockResolvedValue({
      sent: [{ sceneId: '7', title: 'Summer Afternoon' }],
      skipped: {},
      failed: [],
    });
    await service.lookup(['7']);
    const result = await service.apply('7', 's0-remote-1');
    expect(handoff.send).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ id: '7' })],
      expect.objectContaining({ sendToWhisparr: true }),
    );
    expect(result).toMatchObject({ sentToWhisparr: true, renamedTo: null });
    expect(stash.moveFile).not.toHaveBeenCalled();
  });

  it('sends every scene Whisparr is missing', async () => {
    handoff.missingInWhisparr.mockResolvedValue(['remote-1']);
    stash.findOrganizerScenes.mockResolvedValue({
      total: 1,
      items: [localScene()],
    });
    handoff.send.mockResolvedValue({
      sent: [{ sceneId: '7', title: 'x' }],
      skipped: {},
      failed: [],
    });
    service.startSendAll();
    await waitUntilIdle(service);
    expect(stash.findOrganizerScenes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sceneFilter: {
          stash_id_endpoint: {
            endpoint: 'https://stashdb.org/graphql',
            stash_id: 'remote-1',
            modifier: 'EQUALS',
          },
        },
      }),
    );
    expect(service.status()).toMatchObject({
      running: false,
      kind: 'whisparr',
    });
    expect(service.status().message).toBe('Sent 1 to Whisparr.');
  });

  it('moves unmatched files into the Unmatched folder through Stash, with undo', async () => {
    stash.getOrganizerScene.mockResolvedValue(
      localScene({
        id: '1',
        files: [
          {
            ...localScene().files[0],
            id: 'f1',
            path: '/data/Unmatched/junk one.mp4',
          },
        ],
      }),
    );
    stash.findOrganizerScenes.mockResolvedValue({
      total: 2,
      items: [
        localScene({
          id: '1',
          files: [
            {
              ...localScene().files[0],
              id: 'f1',
              path: '/data/inbox/junk one.mp4',
            },
          ],
        }),
        localScene({
          id: '2',
          files: [
            {
              ...localScene().files[0],
              id: 'f2',
              path: '/data/Unmatched/already.mp4',
            },
          ],
        }),
      ],
    });
    service.startMoveUnmatched();
    await waitUntilIdle(service);
    expect(stash.moveFile).toHaveBeenCalledTimes(1);
    expect(stash.moveFile).toHaveBeenCalledWith(
      expect.anything(),
      'f1',
      '/data/Unmatched',
      'junk one.mp4',
    );
    expect(prisma.organizerRename.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fileId: 'f1',
        fromPath: '/data/inbox/junk one.mp4',
        toPath: '/data/Unmatched/junk one.mp4',
      }),
    });
    expect(service.status()).toMatchObject({
      running: false,
      kind: 'unmatched',
      message: 'Moved 1 file to Unmatched.',
    });
  });

  it('tidies leftovers after Match all when that is on', async () => {
    settings.moveUnmatched = true;
    stashdb.findScenesByFingerprints.mockResolvedValue([[]]);
    stash.getOrganizerScene
      .mockResolvedValueOnce(localScene())
      .mockResolvedValue(
        localScene({
          files: [
            {
              ...localScene().files[0],
              path: '/data/Unmatched/BrightStudio.23.08.14.Summer.Afternoon.mp4',
            },
          ],
        }),
      );
    service.startAutoMatch();
    await waitUntilIdle(service);
    expect(stash.moveFile).toHaveBeenCalledWith(
      expect.anything(),
      'f7',
      '/data/Unmatched',
      'BrightStudio.23.08.14.Summer.Afternoon.mp4',
    );
    expect(service.status().message).toMatch(/moved 1 unmatched to Unmatched/);
  });

  it('reports where Stash really put a file when it isn’t where it was asked', async () => {
    const scene = localScene({
      title: 'T',
      date: '2020-01-02',
      studio: { id: 's', name: 'S' },
      stashIds: [{ endpoint: 'e', stashId: 'x' }],
    });
    stash.getOrganizerScene.mockResolvedValueOnce(scene).mockResolvedValue({
      ...scene,
      files: [{ ...scene.files[0], path: '/data/inbox/2020-01-02 - T.mp4' }],
    });
    settings.renamePattern = 'scenes/{studio}/{date} - {title}';
    const result = await service.renameScenes(['7'], 'b1');
    expect(stash.moveFile).toHaveBeenCalledWith(
      expect.anything(),
      'f7',
      '/data/scenes/S',
      '2020-01-02 - T.mp4',
    );
    expect(result.moved).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(
      /Stash put it at \/data\/inbox\/2020-01-02 - T\.mp4 instead of \/data\/scenes\/S\/2020-01-02 - T\.mp4/,
    );
    // Recorded, so Undo can put it back.
    expect(prisma.organizerRename.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        toPath: '/data/inbox/2020-01-02 - T.mp4',
      }),
    });
  });

  it('never renames a scene Whisparr tracks, even if Stashboard’s own index is out of date', async () => {
    handoff.trackedStashIds.mockResolvedValue(new Set(['x']));
    stash.findOrganizerScenes.mockResolvedValue({
      total: 1,
      items: [
        localScene({
          title: 'T',
          studio: { id: 's', name: 'S' },
          stashIds: [{ endpoint: 'e', stashId: 'x' }],
        }),
      ],
    });
    const preview = await service.renamePreview();
    expect(preview.counts.whisparr).toBe(1);
    expect(preview.counts.ready).toBe(0);
  });

  it('renames nothing when it can’t ask Whisparr which files are its own', async () => {
    handoff.trackedStashIds.mockRejectedValue(
      new Error('Failed to reach Whisparr provider endpoint.'),
    );
    stash.getOrganizerScene.mockResolvedValue(
      localScene({
        title: 'T',
        studio: { id: 's', name: 'S' },
        stashIds: [{ endpoint: 'e', stashId: 'x' }],
      }),
    );

    await expect(service.renamePreview()).rejects.toThrow(
      /Couldn’t ask Whisparr which files it manages/,
    );
    await expect(service.renameScenes(['7'], 'b')).rejects.toThrow(
      /nothing was renamed/,
    );
    expect(stash.moveFile).not.toHaveBeenCalled();
  });

  it('lists what a Whisparr repair would do to each scene, as Stash sees the folders', async () => {
    settings.whisparrPathFrom = '/data';
    settings.whisparrPathTo = '/mnt/media';
    handoff.repairPlan.mockResolvedValue({
      whisparrDestination: '/mnt/media/scenes',
      whisparrRoot: '/mnt/media',
      withFiles: [
        {
          id: 11,
          title: 'Moved',
          path: '/mnt/media/scenes/scenes/S',
          target: '/mnt/media/scenes/S/2020 - Moved',
        },
      ],
      missing: [
        {
          id: 13,
          title: 'Path only',
          path: '/mnt/media/S',
          target: '/mnt/media/scenes/S/2021 - Path only',
        },
      ],
      lost: [
        {
          movieId: 12,
          stashId: 'gone',
          title: 'Lost',
          path: '/mnt/media/scenes/L',
        },
      ],
      total: 3,
    });

    const repair = await service.whisparrRepairCount();

    expect(repair?.count).toBe(3);
    expect(repair?.scenes).toEqual([
      {
        title: 'Moved',
        action: 'move',
        from: '/data/scenes/scenes/S',
        to: '/data/scenes/S/2020 - Moved',
      },
      {
        title: 'Path only',
        action: 'path',
        from: '/data/S',
        to: '/data/scenes/S/2021 - Path only',
      },
      {
        title: 'Lost',
        action: 'reimport',
        from: '/data/scenes/L',
        to: null,
      },
    ]);
  });

  it('checks Whisparr’s folders against its own Scene Folder Format, not the file name pattern', async () => {
    settings.renamePattern = '{studioslug}.{title}.{date}';
    handoff.namingConfig.mockResolvedValue({
      folderFormat: 'scenes/{Studio Title}/{Release Date} - {Scene Title}',
      fileFormat:
        '{Studio CleanTitleSlug}.{Scene.CleanTitle}.{Release Date}{.Quality.Title}{-Release Group}',
    });
    handoff.repairPlan.mockResolvedValue({
      whisparrDestination: '/data/scenes',
      whisparrRoot: '/data',
      withFiles: [],
      missing: [],
      lost: [],
      total: 0,
    });

    const repair = await service.whisparrRepairCount();

    expect(repair?.folderFormat).toBe(
      'scenes/{Studio Title}/{Release Date} - {Scene Title}',
    );
    const [, , destination, , folderFor] = handoff.repairPlan.mock.calls[0] as [
      unknown,
      unknown,
      string,
      unknown,
      (movie: Record<string, unknown>) => string | null,
    ];
    expect(destination).toBe('/data/scenes');
    expect(
      folderFor({
        title: 'Summer Afternoon',
        studio: 'Bright Studio',
        date: '2023-08-14',
        stashId: 'x',
      }),
    ).toBe('/data/scenes/Bright Studio/2023-08-14 - Summer Afternoon');
  });

  it('turns Whisparr’s folder and file formats into one pattern', async () => {
    handoff.namingConfig.mockResolvedValue({
      folderFormat: 'scenes/{Studio Title}/{Release Date} - {Scene Title}',
      fileFormat:
        '{Studio CleanTitleSlug}.{Scene.CleanTitle}.{Release Date}{.Quality.Title}{-Release Group}',
    });

    await expect(service.whisparrNaming()).resolves.toMatchObject({
      pattern:
        'scenes/{Studio Title}/{Release Date} - {Scene Title}/{Studio CleanTitleSlug}.{Scene.CleanTitle}.{Release Date}{.Quality.Title}{-Release Group}',
      problem: null,
    });
  });

  it('skips a file Stash lists but that was moved away, and has Stash rescan its folder', async () => {
    const library = mkdtempSync(path.join(tmpdir(), 'stashboard-lib-'));
    mkdirSync(path.join(library, 'Studio'));
    writeFileSync(path.join(library, 'Studio', 'here.mp4'), 'x');
    stash.getLibraryRoots.mockResolvedValue([library]);
    const scene = (id: string, file: string) =>
      localScene({
        id,
        title: `Scene ${id}`,
        date: '2023-08-14',
        studio: { id: '1', name: 'Bright Studio' },
        stashIds: [{ endpoint: 'e', stashId: `remote-${id}` }],
        files: [
          {
            ...localScene().files[0],
            id: `f${id}`,
            path: path.join(library, 'Studio', file),
            basename: file,
          },
        ],
      });
    stash.findOrganizerScenes.mockResolvedValue({
      total: 2,
      items: [scene('1', 'here.mp4'), scene('2', 'moved-by-whisparr.mp4')],
    });

    const preview = await service.renamePreview();

    expect(preview.counts.ready).toBe(1);
    expect(preview.counts.gone).toBe(1);
    expect(preview.skipped[0]).toMatchObject({ sceneId: '2', state: 'gone' });
    expect(stash.scanPaths).toHaveBeenCalledWith(expect.anything(), [
      path.join(library, 'Studio'),
    ]);
    // Not asked again straight away when the preview reloads.
    await service.renamePreview();
    expect(stash.scanPaths).toHaveBeenCalledTimes(1);
  });

  it('skips a file whose new name another file already has (Whisparr’s copy, say)', async () => {
    const library = mkdtempSync(path.join(tmpdir(), 'stashboard-lib-'));
    mkdirSync(path.join(library, 'inbox'));
    mkdirSync(path.join(library, 'Bright Studio'));
    writeFileSync(path.join(library, 'inbox', 'download.mp4'), 'x');
    writeFileSync(
      path.join(library, 'Bright Studio', '2023-08-14 - Summer Afternoon.mp4'),
      'x',
    );
    stash.getLibraryRoots.mockResolvedValue([library]);
    stash.findOrganizerScenes.mockResolvedValue({
      total: 1,
      items: [
        localScene({
          title: 'Summer Afternoon',
          date: '2023-08-14',
          studio: { id: '1', name: 'Bright Studio' },
          stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
          files: [
            {
              ...localScene().files[0],
              path: path.join(library, 'inbox', 'download.mp4'),
              basename: 'download.mp4',
            },
          ],
        }),
      ],
    });

    const preview = await service.renamePreview();

    expect(preview.counts.ready).toBe(0);
    expect(preview.counts.taken).toBe(1);
    expect(preview.skipped[0]).toMatchObject({
      state: 'taken',
      to: path.join(
        library,
        'Bright Studio',
        '2023-08-14 - Summer Afternoon.mp4',
      ),
    });
    expect(stash.scanPaths).toHaveBeenCalledWith(expect.anything(), [
      path.join(library, 'Bright Studio'),
    ]);
    // Stash doesn't know the other file: the fix is a scan, not Duplicates.
    expect(preview.skipped[0].taken).toMatchObject({
      otherSceneId: null,
      sameSize: true,
      fix: 'scan',
    });
  });

  it('merges a taken name’s other scene into this one and deletes this copy', async () => {
    const library = mkdtempSync(path.join(tmpdir(), 'stashboard-lib-'));
    mkdirSync(path.join(library, 'Bright Studio'));
    const target = path.join(
      library,
      'Bright Studio',
      '2023-08-14 - Summer Afternoon.mp4',
    );
    const copy = path.join(
      library,
      'Bright Studio',
      '2023-08-14 - Summer Afternoon (2).mp4',
    );
    writeFileSync(target, 'same');
    writeFileSync(copy, 'same');
    stash.getLibraryRoots.mockResolvedValue([library]);
    const matched = localScene({
      title: 'Summer Afternoon',
      date: '2023-08-14',
      studio: { id: '1', name: 'Bright Studio' },
      stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
      files: [
        {
          ...localScene().files[0],
          path: copy,
          basename: path.basename(copy),
        },
      ],
    });
    const other = localScene({
      id: '9',
      files: [
        {
          ...localScene().files[0],
          id: 'f9',
          path: target,
          basename: path.basename(target),
        },
      ],
    });
    let mergedYet = false;
    stash.getOrganizerScene.mockImplementation((_config, id: string) =>
      Promise.resolve(
        id === '9'
          ? other
          : mergedYet
            ? { ...matched, files: [...matched.files, ...other.files] }
            : matched,
      ),
    );
    stash.sceneIdsForPaths.mockResolvedValue(['9']);
    stash.mergeScenes.mockImplementation(() => {
      mergedYet = true;
      return Promise.resolve();
    });

    const result = await service.fixTaken(['7']);

    expect(stash.mergeScenes).toHaveBeenCalledWith(
      expect.anything(),
      ['9'],
      '7',
    );
    expect(stash.removeExtraFile).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      'f9',
      'f7',
    );
    expect(result).toEqual({ scanned: 0, merged: 1, skipped: [] });
  });

  it('leaves a taken name alone when the files differ in size', async () => {
    const library = mkdtempSync(path.join(tmpdir(), 'stashboard-lib-'));
    mkdirSync(path.join(library, 'Bright Studio'));
    const target = path.join(
      library,
      'Bright Studio',
      '2023-08-14 - Summer Afternoon.mp4',
    );
    const copy = path.join(library, 'Bright Studio', 'other.mp4');
    writeFileSync(target, 'a bigger file');
    writeFileSync(copy, 'small');
    stash.getLibraryRoots.mockResolvedValue([library]);
    stash.getOrganizerScene.mockResolvedValue(
      localScene({
        title: 'Summer Afternoon',
        date: '2023-08-14',
        studio: { id: '1', name: 'Bright Studio' },
        stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
        files: [
          {
            ...localScene().files[0],
            path: copy,
            basename: 'other.mp4',
          },
        ],
      }),
    );
    stash.sceneIdsForPaths.mockResolvedValue(['9']);

    const result = await service.fixTaken(['7']);

    expect(stash.mergeScenes).not.toHaveBeenCalled();
    expect(stash.removeExtraFile).not.toHaveBeenCalled();
    expect(result.skipped[0].reason).toMatch(/different sizes/);
  });

  it('finds extra copies of a scene and removes them, keeping the correctly named file', async () => {
    const named = localScene({
      title: 'Summer Afternoon',
      date: '2023-08-14',
      studio: { id: '1', name: 'Bright Studio' },
      stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
      files: [
        {
          ...localScene().files[0],
          id: 'old',
          path: '/data/inbox/download.mp4',
        },
        {
          ...localScene().files[0],
          id: 'whisparr',
          path: '/data/Bright Studio/2023-08-14 - Summer Afternoon.mp4',
        },
      ],
    });
    stash.findOrganizerScenes.mockResolvedValue({ total: 1, items: [named] });

    const preview = await service.renamePreview();
    expect(preview.counts.copy).toBe(1);
    expect(preview.counts.ready).toBe(0);
    expect(preview.skipped[0]).toMatchObject({
      state: 'copy',
      fileId: 'old',
      keepFileId: 'whisparr',
    });

    await expect(service.removeExtraCopies()).resolves.toEqual({
      removed: 1,
      failed: [],
    });
    expect(stash.removeExtraFile).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      'whisparr',
      'old',
    );
  });

  it('syncs with Whisparr: rescans, waits, removes extra copies, links waiting scenes', async () => {
    const library = mkdtempSync(path.join(tmpdir(), 'stashboard-lib-'));
    mkdirSync(path.join(library, 'Studio'));
    stash.getLibraryRoots.mockResolvedValue([library]);
    const file = (id: string, filePath: string, oshash: string) => ({
      ...localScene().files[0],
      id,
      path: filePath,
      basename: path.basename(filePath),
      fingerprints: [{ type: 'oshash', value: oshash }],
    });
    // Stash lists a file Whisparr moved away.
    const gone = localScene({
      id: '1',
      title: 'Gone',
      date: '2023-08-14',
      studio: { id: '1', name: 'Bright Studio' },
      stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
      files: [file('f1', path.join(library, 'Studio', 'gone.mp4'), 'a')],
    });
    // Whisparr's copy attached to the scene that already had the same video.
    const doubled = localScene({
      id: '2',
      title: 'Doubled',
      stashIds: [{ endpoint: 'e', stashId: 'sdb-2' }],
      files: [
        file('old', '/downloads/doubled.mp4', 'same'),
        file('w2', '/data/whisparr/Doubled/doubled.mp4', 'same'),
      ],
    });
    // Two different versions merged by hand: left alone.
    const versions = localScene({
      id: '3',
      title: 'Versions',
      files: [
        file('v1', '/data/x/v-1080.mp4', 'one'),
        file('w3', '/data/whisparr/V/v-2160.mp4', 'two'),
      ],
    });
    stash.findOrganizerScenes.mockImplementation(
      (_config, options: { sceneFilter: Record<string, unknown> }) =>
        Promise.resolve(
          options.sceneFilter.file_count
            ? { total: 2, items: [doubled, versions] }
            : options.sceneFilter.path
              ? { total: 0, items: [] }
              : { total: 1, items: [gone] },
        ),
    );
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      {
        stashId: 'sdb-2',
        filePath: '/data/whisparr/Doubled/doubled.mp4',
        folder: '/data/whisparr/Doubled',
        movieId: 2,
      },
      {
        stashId: 'sdb-3',
        filePath: '/data/whisparr/V/v-2160.mp4',
        folder: '/data/whisparr/V',
        movieId: 3,
      },
      {
        stashId: 'sdb-9',
        filePath: '/data/whisparr/New/new.mp4',
        folder: '/data/whisparr/New',
        movieId: 9,
      },
    ]);
    prisma.sceneIndex.findMany.mockResolvedValue([{ stashId: 'sdb-9' }]);
    const link = jest
      .spyOn(service, 'linkWaitingScenes')
      .mockResolvedValue(['44']);

    const result = await service.syncWithWhisparr();

    expect(stash.scanPaths).toHaveBeenCalledTimes(1);
    expect(stash.scanPaths.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        '/data/whisparr/New',
        path.join(library, 'Studio'),
      ]),
    );
    expect(stash.waitForJob).toHaveBeenCalledWith(
      expect.anything(),
      'scan-job',
      expect.anything(),
    );
    expect(stash.removeExtraFile).toHaveBeenCalledTimes(1);
    expect(stash.removeExtraFile).toHaveBeenCalledWith(
      expect.anything(),
      '2',
      'w2',
      'old',
    );
    expect(link).toHaveBeenCalledWith(['sdb-9']);
    expect(result).toMatchObject({ rescanned: 2, removed: 1, linked: 1 });
    expect(result.message).toBe(
      'Rescanned 2 folders, removed 1 extra copy, linked 1 scene.',
    );
    expect(service.status()).toMatchObject({
      running: false,
      kind: 'sync',
      message: result.message,
    });
    expect(settings.lastRunKind).toBe('sync');
  });

  it('says so when Stash and Whisparr already agree, and needs Whisparr', async () => {
    stash.findOrganizerScenes.mockResolvedValue({ total: 0, items: [] });
    await expect(service.syncWithWhisparr()).resolves.toMatchObject({
      message: 'Stash and Whisparr already agree. Nothing to tidy up.',
    });
    expect(stash.scanPaths).not.toHaveBeenCalled();

    handoff.isAvailable.mockResolvedValue(false);
    await expect(service.syncWithWhisparr()).rejects.toThrow(/Whisparr/);
    expect(settings.lastRunStatus).toBe('FAILED');
  });

  it('matches only the picked scenes, without the whole-library extras', async () => {
    settings.moveUnmatched = true;
    stash.getOrganizerScene.mockImplementation((_config, id: string) =>
      Promise.resolve(localScene({ id })),
    );

    service.startAutoMatch('manual', ['7', '8', '7']);
    await waitUntilIdle(service);

    // Neither the unmatched backlog nor the waiting list is looked at.
    expect(stash.findOrganizerScenes).not.toHaveBeenCalled();
    expect(prisma.sceneIndex.findMany).not.toHaveBeenCalled();
    expect(
      stash.getOrganizerScene.mock.calls.map((call) => call[1]).sort(),
    ).toEqual(['7', '8']);
    expect(stash.applySceneMatch).not.toHaveBeenCalled();
    expect(
      (await service.matchProposals()).map((entry) => entry.scene.id),
    ).toEqual(['7']);
    expect(stash.moveFile).not.toHaveBeenCalled();
    expect(service.status().message).toMatch(/^Checked 2/);
  });

  it('moves only the picked unmatched files to Unmatched', async () => {
    stash.getOrganizerScene.mockImplementation((_config, id: string) =>
      Promise.resolve(
        id === '8'
          ? localScene({
              id,
              title: 'Matched',
              stashIds: [{ endpoint: 'e', stashId: 'x' }],
            })
          : localScene({ id }),
      ),
    );

    service.startMoveUnmatched(['7', '8']);
    await waitUntilIdle(service);

    expect(stash.findOrganizerScenes).not.toHaveBeenCalled();
    expect(stash.moveFile).toHaveBeenCalledTimes(1);
    expect(stash.moveFile).toHaveBeenCalledWith(
      expect.anything(),
      'f7',
      '/data/Unmatched',
      'BrightStudio.23.08.14.Summer.Afternoon.mp4',
    );
  });

  it('explains a move Stash refused because the new name is taken', async () => {
    stash.findOrganizerScenes.mockResolvedValue({
      total: 1,
      items: [
        localScene({
          title: 'Summer Afternoon',
          date: '2023-08-14',
          studio: { id: '1', name: 'Bright Studio' },
          stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
        }),
      ],
    });
    stash.moveFile.mockRejectedValue(
      new Error(
        'file /data/Bright Studio/2023-08-14 - Summer Afternoon.mp4 already exists',
      ),
    );

    const result = await service.renameScenes(null, 'batch');

    expect(result.failed[0].reason).toContain('may be a duplicate');
  });

  it('explains a move Stash refused because the file is gone, and rescans', async () => {
    const scene = localScene({
      title: 'Summer Afternoon',
      date: '2023-08-14',
      studio: { id: '1', name: 'Bright Studio' },
      stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
    });
    stash.findOrganizerScenes.mockResolvedValue({ total: 1, items: [scene] });
    stash.moveFile.mockRejectedValue(
      new Error(
        "renaming file failed previously with: 'rename /data/inbox/a.mp4 /data/x/a.mp4: no such file or directory'",
      ),
    );

    const result = await service.renameScenes(null, 'batch');

    expect(result.failed[0].reason).toContain("isn't there anymore");
    expect(stash.scanPaths).toHaveBeenCalledWith(expect.anything(), [
      '/data/inbox',
    ]);
  });

  it('renames with Whisparr’s own format the way Whisparr would name the file', async () => {
    settings.renamePattern =
      'scenes/{Studio Title}/{Release Date} - {Scene Title}/{Studio CleanTitleSlug}.{Scene.CleanTitle}.{Release Date}{.Quality.Title}{-Release Group}';
    stash.findOrganizerScenes.mockResolvedValue({
      total: 1,
      items: [
        localScene({
          title: 'Who’s Next? Part 2',
          date: '2023-08-14',
          studio: { id: '1', name: 'Mr. Anal' },
          stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
        }),
      ],
    });

    const preview = await service.renamePreview();

    expect(preview.changes[0]?.to).toBe(
      '/data/scenes/Mr. Anal/2023-08-14 - Who’s Next! Part 2/Mr.Anal.Whos.Next.Part.2.2023-08-14.WEBDL-1080p.mp4',
    );
  });

  it('repairs scenes Whisparr lost: resets paths, rescans, re-imports the rest', async () => {
    handoff.repairPlan.mockResolvedValue({
      whisparrDestination: '/data/scenes',
      withFiles: [
        { id: 11, path: '/data/scenes/scenes/S', target: '/data/scenes/S/x' },
      ],
      missing: [{ id: 13, path: '/data/S', target: '/data/scenes/S/y' }],
      lost: [
        { movieId: 11, stashId: 'remote-1' },
        { movieId: 12, stashId: 'gone' },
      ],
      total: 3,
    });
    handoff.resetPaths.mockResolvedValue({ stillWrong: 0, errors: [] });
    stash.findOrganizerScenes.mockImplementation(
      (
        _config,
        options: { sceneFilter: { stash_id_endpoint?: { stash_id?: string } } },
      ) =>
        Promise.resolve(
          options.sceneFilter.stash_id_endpoint?.stash_id === 'remote-1'
            ? { total: 1, items: [localScene()] }
            : { total: 0, items: [] },
        ),
    );
    handoff.send.mockResolvedValue({
      sent: [{ sceneId: '7', title: 'x' }],
      skipped: {},
      failed: [],
    });
    service.startWhisparrRepair();
    await waitUntilIdle(service);
    expect(handoff.resetPaths).toHaveBeenCalled();
    expect(handoff.send).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ id: '7' })],
      expect.objectContaining({ whisparrImportMode: 'move' }),
      expect.any(Function),
    );
    expect(service.status().message).toBe(
      'Put 2 scenes in their folders in /data; Whisparr has 1 of 2 files back. 1 aren’t in Stash.',
    );
    expect(handoff.scanWhereWhisparrPut).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [11],
    );
  });

  it('cleans up folders of only pictures unless Stash has a gallery there', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'lib-'));
    mkdirSync(path.join(lib, 'Old shots'));
    writeFileSync(path.join(lib, 'Old shots', '1.jpg'), 'x');
    mkdirSync(path.join(lib, 'Gallery'));
    writeFileSync(path.join(lib, 'Gallery', '1.jpg'), 'x');
    stash.getLibraryRoots.mockResolvedValue([lib]);
    handoff.rootFoldersAsStashSees.mockResolvedValue([]);
    stash.listGalleryFolders.mockResolvedValue([path.join(lib, 'Gallery')]);
    const found = await service.emptyFolders();
    expect(found.folders).toEqual([path.join(lib, 'Old shots')]);
    expect(found.galleries).toBe(1);
    const result = await service.cleanEmptyFolders();
    expect(result.removed).toBe(1);
    expect(existsSync(path.join(lib, 'Gallery', '1.jpg'))).toBe(true);
    expect(existsSync(path.join(lib, 'Old shots'))).toBe(false);
  });

  it('removes the folders a rename left empty, but never library or Whisparr folders', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'lib-'));
    const oldFolder = path.join(lib, 'scenes', 'scenes', 'S');
    mkdirSync(oldFolder, { recursive: true });
    mkdirSync(path.join(lib, 'whisparr-root'));
    writeFileSync(path.join(oldFolder, 'a.mp4'), 'x');
    settings.cleanEmptyFolders = true;
    settings.renamePattern = 'scenes/{studio}/{title}';
    stash.getLibraryRoots.mockResolvedValue([lib]);
    handoff.rootFoldersAsStashSees.mockResolvedValue([
      path.join(lib, 'whisparr-root'),
    ]);
    const scene = localScene({
      title: 'T',
      studio: { id: 's', name: 'S' },
      stashIds: [{ endpoint: 'e', stashId: 'x' }],
      files: [
        { ...localScene().files[0], path: path.join(oldFolder, 'a.mp4') },
      ],
    });
    const target = path.join(lib, 'scenes', 'S', 'T.mp4');
    stash.getOrganizerScene.mockResolvedValueOnce(scene).mockResolvedValue({
      ...scene,
      files: [{ ...scene.files[0], path: target }],
    });
    // Pretend Stash moved it: the real file goes away from the old folder.
    stash.moveFile.mockImplementation(async () => {
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(path.join(oldFolder, 'a.mp4'), target);
    });
    const result = await service.renameScenes(['7'], 'b');
    expect(result.moved).toHaveLength(1);
    expect(existsSync(path.join(lib, 'scenes', 'scenes'))).toBe(false);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(path.join(lib, 'whisparr-root'))).toBe(true);
  });

  it('removes no folders when it can’t ask Whisparr for its root folders', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'lib-'));
    mkdirSync(path.join(lib, 'whisparr-root'));
    stash.getLibraryRoots.mockResolvedValue([lib]);
    handoff.rootFoldersAsStashSees.mockRejectedValue(
      new Error('Failed to reach Whisparr provider endpoint.'),
    );

    await expect(service.cleanEmptyFolders()).rejects.toThrow(
      /no folders were removed/,
    );
    expect(existsSync(path.join(lib, 'whisparr-root'))).toBe(true);
  });

  it('removes the folders a rename made when it is undone', async () => {
    const lib = mkdtempSync(path.join(tmpdir(), 'lib-'));
    const madeFolder = path.join(lib, 'S', '2020');
    mkdirSync(madeFolder, { recursive: true });
    writeFileSync(path.join(madeFolder, 'T.mp4'), 'x');
    settings.cleanEmptyFolders = true;
    stash.getLibraryRoots.mockResolvedValue([lib]);
    const row = {
      id: 1,
      batchId: 'b',
      fileId: 'f7',
      fromPath: path.join(lib, 'inbox', 'a.mp4'),
      toPath: path.join(madeFolder, 'T.mp4'),
    };
    prisma.organizerRename.findFirst.mockResolvedValue(row);
    prisma.organizerRename.findMany.mockResolvedValue([row]);
    stash.moveFile.mockImplementation(async () => {
      mkdirSync(path.join(lib, 'inbox'), { recursive: true });
      renameSync(row.toPath, row.fromPath);
    });

    await service.undoLast();
    await waitUntilIdle(service);

    expect(service.status().message).toBe('Put 1 file back.');
    expect(existsSync(row.fromPath)).toBe(true);
    expect(existsSync(path.join(lib, 'S'))).toBe(false);
  });

  describe('one scene, for “Why is it like this?”', () => {
    it('plans one scene’s rename like the preview, without rescanning', async () => {
      const library = mkdtempSync(path.join(tmpdir(), 'stashboard-lib-'));
      mkdirSync(path.join(library, 'inbox'));
      mkdirSync(path.join(library, 'Bright Studio'));
      const from = path.join(library, 'inbox', 'download.mp4');
      const to = path.join(
        library,
        'Bright Studio',
        '2023-08-14 - Summer Afternoon.mp4',
      );
      writeFileSync(from, 'x');
      writeFileSync(to, 'x');
      stash.getLibraryRoots.mockResolvedValue([library]);
      stash.getOrganizerScene.mockResolvedValue(
        localScene({
          title: 'Summer Afternoon',
          date: '2023-08-14',
          studio: { id: '1', name: 'Bright Studio' },
          stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
          files: [
            { ...localScene().files[0], path: from, basename: 'download.mp4' },
          ],
        }),
      );
      const before = new Date('2026-10-01T09:00:00Z');
      prisma.organizerRename.findMany.mockResolvedValue([
        { fileId: 'f7', fromPath: from, toPath: to, createdAt: before },
      ]);

      const result = await service.renamePlansFor(['7']);

      expect(result.pattern).toBe('{studio}/{date} - {title}');
      expect(result.plans).toEqual([
        expect.objectContaining({
          sceneId: '7',
          state: 'taken',
          from,
          to,
          renamedBefore: before.toISOString(),
          taken: expect.objectContaining({ fix: 'scan', sameSize: true }),
        }),
      ]);
      expect(stash.scanPaths).not.toHaveBeenCalled();
    });

    it('finds Whisparr’s file by catalog id, or by where Stash has it', async () => {
      handoff.filesAsStashSees = jest.fn().mockResolvedValue([
        {
          stashId: 'sdb-a',
          filePath: '/data/a/a.mp4',
          folder: null,
          movieId: 3,
        },
        {
          stashId: 'sdb-b',
          filePath: '/data/b/b.mp4',
          folder: null,
          movieId: 4,
        },
      ]);

      await expect(service.whisparrFileFor(['sdb-b'])).resolves.toMatchObject({
        movieId: 4,
      });
      await expect(
        service.whisparrFileFor([], ['/DATA/A/A.mp4']),
      ).resolves.toMatchObject({ movieId: 3 });
      await expect(service.whisparrFileFor(['sdb-x'])).resolves.toBeNull();
    });

    it('says when Whisparr can’t be asked, rather than finding nothing', async () => {
      handoff.filesAsStashSees = jest
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED'));
      await expect(service.whisparrFileFor(['sdb-a'])).rejects.toThrow(
        'connect ECONNREFUSED',
      );

      handoff.isAvailable.mockResolvedValue(false);
      await expect(service.whisparrFileFor(['sdb-a'])).rejects.toThrow(
        'Whisparr isn’t set up',
      );
    });

    it('explains one waiting scene without asking Whisparr to look again', async () => {
      handoff.filesAsStashSees = jest.fn().mockResolvedValue([
        {
          stashId: 'sdb-a',
          filePath: '/data/a/a.mp4',
          folder: null,
          movieId: 3,
        },
      ]);
      stash.findOrganizerScenes.mockResolvedValue({ total: 0, items: [] });

      const explained = await service.explainWaitingScene({
        stashId: 'sdb-a',
        title: 'A',
      });

      expect(explained).toMatchObject({
        kind: 'not-in-stash',
        path: '/data/a/a.mp4',
        reason: expect.stringContaining('Stash has nothing there'),
      });
      expect(handoff.refreshMovies).not.toHaveBeenCalled();
    });

    it('lists the Stash scenes linked to a catalog scene, once each', async () => {
      const scene = localScene({
        stashIds: [
          { endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-a' },
        ],
      });
      stash.findOrganizerScenes.mockResolvedValue({ total: 1, items: [scene] });

      const found = await service.stashScenesLinkedTo(['sdb-a', 'sdb-old']);

      expect(found).toEqual([scene]);
      expect(stash.findOrganizerScenes).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sceneFilter: {
            stash_id_endpoint: { stash_id: 'sdb-old', modifier: 'EQUALS' },
          },
        }),
      );
    });

    it('names the main catalog as Stash links scenes to it', async () => {
      await expect(service.primaryCatalog()).resolves.toEqual({
        name: 'StashDB',
        endpoint: 'https://stashdb.org/graphql',
      });
    });
  });

  describe('activity log', () => {
    let activity: {
      record: jest.Mock;
      markUndone: jest.Mock;
      registerUndo: jest.Mock;
    };

    beforeEach(() => {
      activity = {
        record: jest.fn().mockResolvedValue(undefined),
        markUndone: jest.fn().mockResolvedValue(undefined),
        registerUndo: jest.fn(),
      };
      Object.assign(service, { activity });
    });

    it('adds a rename after matching, with an undo for its batch', async () => {
      settings.renameAfterMatch = true;
      await service.lookup(['7']);
      const matchedScene = localScene({
        title: 'Summer Afternoon',
        date: '2023-08-14',
        studio: { id: '1', name: 'Bright Studio' },
        stashIds: [{ endpoint: 'e', stashId: 'remote-1' }],
      });
      stash.getOrganizerScene
        .mockResolvedValueOnce(matchedScene)
        .mockResolvedValueOnce(matchedScene)
        .mockResolvedValue({
          ...matchedScene,
          files: [
            {
              ...matchedScene.files[0],
              path: '/data/Bright Studio/2023-08-14 - Summer Afternoon.mp4',
            },
          ],
        });

      await service.apply('7', 's0-remote-1');

      const batchId = (
        prisma.organizerRename.create.mock.calls[0][0] as {
          data: { batchId: string };
        }
      ).data.batchId;
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'rename',
          title: 'Renamed 1 file after matching',
          status: 'done',
          count: 1,
          undo: { type: 'rename-batch', batchId },
        }),
      );
    });

    it('lets the log undo one batch, and marks it undone', async () => {
      const row = {
        id: 4,
        batchId: 'older',
        fileId: 'f7',
        fromPath: '/data/inbox/a.mp4',
        toPath: '/data/S/T.mp4',
      };
      prisma.organizerRename.findMany.mockResolvedValue([row]);
      await service.onModuleInit();
      const [type, handler] = activity.registerUndo.mock.calls[0] as [
        string,
        (undo: { type: string; batchId: string }) => Promise<unknown>,
      ];
      expect(type).toBe('rename-batch');

      await handler({ type, batchId: 'older' });
      await waitUntilIdle(service);

      expect(prisma.organizerRename.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { batchId: 'older', undoneAt: null },
        }),
      );
      expect(stash.moveFile).toHaveBeenCalledWith(
        expect.anything(),
        'f7',
        '/data/inbox',
        'a.mp4',
      );
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'undo',
          title: 'Put 1 file back.',
          status: 'done',
        }),
      );
      expect(activity.markUndone).toHaveBeenCalledWith(
        'rename-batch',
        'batchId',
        'older',
      );
    });

    it('says so when a batch was already put back', async () => {
      prisma.organizerRename.findMany.mockResolvedValue([]);
      await expect(service.undoBatch('gone')).rejects.toThrow(
        /already put back/,
      );
    });

    it('logs finished runs but not progress', async () => {
      service.startRenameAll();
      await waitUntilIdle(service);
      const kinds = activity.record.mock.calls.map(
        ([entry]) => (entry as { kind: string }).kind,
      );
      expect(kinds).toEqual(['rename']);
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ undo: null, count: 0 }),
      );
    });
  });

  it('won’t rename or clean up from the page while a background run moves files', async () => {
    stash.findOrganizerScenes.mockReturnValue(new Promise(() => undefined));
    service.startRenameAll();

    expect(() => service.renameSelected(['7'])).toThrow(/already busy/);
    expect(() => service.cleanEmptyFoldersNow()).toThrow(/already busy/);
  });

  it('links a scene Whisparr imported straight to the StashDB scene it was downloaded for', async () => {
    const scenes: Record<string, StashOrganizerScene> = {
      '7': localScene(),
      '8': localScene({
        id: '8',
        stashIds: [{ endpoint: 'https://stashdb.org/graphql', stashId: 'old' }],
      }),
      '9': localScene({
        id: '9',
        files: [
          {
            ...localScene().files[0],
            id: 'f9',
            path: '/data/inbox/other.mp4',
          },
        ],
      }),
    };
    stash.getOrganizerScene.mockImplementation((_config, id: string) =>
      Promise.resolve(scenes[id] ?? null),
    );
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      {
        stashId: 'from-whisparr',
        // Whisparr's path through the mapping; case and slashes may differ.
        filePath: '/DATA/inbox/BrightStudio.23.08.14.Summer.Afternoon.mp4',
        folder: '/data/inbox',
      },
    ]);
    stashdb.getMatchScenesById = jest
      .fn()
      .mockResolvedValue(
        new Map([['from-whisparr', { ...remote, id: 'from-whisparr' }]]),
      );

    const result = await service.identifyNewScenes(['7', '8', '9']);

    expect(result).toEqual({
      linked: ['7'],
      matched: ['9'],
      proposed: [],
      left: [],
    });
    expect(stashdb.getMatchScenesById).toHaveBeenCalledWith(
      { baseUrl: 'https://stashdb.org', apiKey: 'k' },
      ['from-whisparr'],
    );
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '7',
      expect.objectContaining({
        stashIds: [
          { endpoint: 'https://stashdb.org/graphql', stashId: 'from-whisparr' },
        ],
      }),
    );
    // Scene 8 was already linked: left alone.
    expect(stash.applySceneMatch).not.toHaveBeenCalledWith(
      expect.anything(),
      '8',
      expect.anything(),
    );
  });

  it('still matches new scenes when Whisparr can’t be asked', async () => {
    handoff.filesAsStashSees = jest
      .fn()
      .mockRejectedValue(new Error('Whisparr is down'));

    const result = await service.identifyNewScenes(['7']);

    expect(result).toEqual({
      linked: [],
      matched: ['7'],
      proposed: [],
      left: [],
    });
  });

  it('counts the unmatched files the mover would move, and nothing else', async () => {
    const file = (id: string, path: string) => ({
      ...localScene().files[0],
      id,
      path,
    });
    stash.findOrganizerScenes.mockResolvedValue({
      total: 4,
      items: [
        // Already moved.
        localScene({ id: '1', files: [file('f1', '/data/Unmatched/a.mp4')] }),
        // Two files: the first is moved, the second copy stays put.
        localScene({
          id: '2',
          files: [
            file('f2', '/data/Unmatched/b.mp4'),
            file('f2b', '/data/inbox/b-copy.mp4'),
          ],
        }),
        // Outside Stash's library folders: can't be moved.
        localScene({ id: '3', files: [file('f3', '/elsewhere/c.mp4')] }),
        // Still to move.
        localScene({ id: '4', files: [file('f4', '/data/inbox/d.mp4')] }),
      ],
    });

    const first = await service.unmatched(1);
    const second = await service.unmatched(2);

    expect(first.total).toBe(4);
    expect(first.toMove).toBe(1);
    expect(second.toMove).toBeUndefined();
  });

  it('searches and sorts the Match list, and only counts moves for the plain list', async () => {
    const result = await service.unmatched(1, {
      q: ' summer ',
      sort: 'title',
      scope: 'unlinked',
    });

    expect(stash.findOrganizerScenes).toHaveBeenCalledWith(expect.anything(), {
      page: 1,
      perPage: expect.any(Number),
      sceneFilter: { is_missing: 'stash_id' },
      sort: 'title',
      direction: 'ASC',
      q: 'summer',
    });
    expect(result.toMove).toBeUndefined();
  });

  it('links scenes stuck at "waiting for import" by Whisparr’s file path', async () => {
    const stuck = localScene({
      id: '21',
      title: 'Scraped title',
      files: [
        { ...localScene().files[0], id: 'f21', path: '/data/scenes/A/a.mp4' },
      ],
    });
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      {
        stashId: 'sdb-a',
        filePath: '/data/scenes/A/a.mp4',
        folder: '/data/scenes/A',
      },
      { stashId: 'sdb-other', filePath: '/data/scenes/B/b.mp4', folder: null },
    ]);
    stash.findOrganizerScenes.mockImplementation(
      (_config, options: { sceneFilter: { path?: { value: string } } }) =>
        Promise.resolve(
          options.sceneFilter.path?.value === '/data/scenes/A/a.mp4'
            ? { total: 1, items: [stuck] }
            : { total: 0, items: [] },
        ),
    );
    stashdb.getMatchScenesById = jest
      .fn()
      .mockResolvedValue(new Map([['sdb-a', { ...remote, id: 'sdb-a' }]]));

    await expect(service.linkWaitingScenes(['sdb-a'])).resolves.toEqual(['21']);
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '21',
      expect.objectContaining({
        stashIds: [
          { endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-a' },
        ],
      }),
    );
  });

  it('links a waiting scene whose file Stash has under another folder', async () => {
    const moved = localScene({
      id: '22',
      files: [
        { ...localScene().files[0], id: 'f22', path: '/data/Unmatched/A.MP4' },
      ],
    });
    handoff.filesAsStashSees = jest
      .fn()
      .mockResolvedValue([
        { stashId: 'sdb-a', filePath: '/data/scenes/A/a.mp4', folder: null },
      ]);
    stash.findOrganizerScenes.mockImplementation(
      (
        _config,
        options: {
          sceneFilter: { path?: { value: string; modifier: string } };
        },
      ) =>
        Promise.resolve(
          options.sceneFilter.path?.modifier === 'INCLUDES' &&
            options.sceneFilter.path.value === 'a.mp4'
            ? { total: 1, items: [moved] }
            : { total: 0, items: [] },
        ),
    );
    stashdb.getMatchScenesById = jest
      .fn()
      .mockResolvedValue(new Map([['sdb-a', { ...remote, id: 'sdb-a' }]]));

    await expect(service.linkWaitingScenes(['sdb-a'])).resolves.toEqual(['22']);
  });

  it('says why each scene is still waiting for import', async () => {
    const rows = [
      { stashId: 'sdb-gone', title: 'Gone' },
      { stashId: 'sdb-nofile', title: 'No file' },
      { stashId: 'sdb-merged', title: 'Merged' },
      { stashId: 'sdb-fresh', title: 'Fresh' },
    ];
    // Still waiting before and after the refresh, except the stale one.
    prisma.sceneIndex.findMany = jest
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValue(rows.slice(0, 3));
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      {
        stashId: 'sdb-nofile',
        filePath: '/data/b/b.mp4',
        folder: null,
        movieId: 7,
      },
      {
        stashId: 'sdb-merged',
        filePath: '/data/c/c.mp4',
        folder: null,
        movieId: 8,
      },
    ]);
    const merged = localScene({
      id: '31',
      stashIds: [
        { endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-new' },
      ],
      files: [{ ...localScene().files[0], id: 'f31', path: '/data/c/c.mp4' }],
    });
    stash.findOrganizerScenes.mockImplementation(
      (_config, options: { sceneFilter: { path?: { value: string } } }) =>
        Promise.resolve(
          options.sceneFilter.path?.value === '/data/c/c.mp4'
            ? { total: 1, items: [merged] }
            : { total: 0, items: [] },
        ),
    );

    // A different StashDB scene, not one merged into Stash's.
    stashdb.getMatchScenesById = jest
      .fn()
      .mockResolvedValue(
        new Map([['sdb-merged', { ...remote, id: 'sdb-merged' }]]),
      );

    const result = await service.checkWaitingScenes();

    expect(result.checked).toBe(4);
    expect(result.fixed).toBe(1);
    expect(
      result.left.map((scene) => [scene.stashId, scene.kind, scene.reason]),
    ).toEqual([
      [
        'sdb-gone',
        'no-whisparr-file',
        expect.stringContaining('lists no file for it now'),
      ],
      [
        'sdb-nofile',
        'not-in-stash',
        expect.stringContaining('Stash has nothing there'),
      ],
      [
        'sdb-merged',
        'other-scene',
        expect.stringContaining('different StashDB scene (sdb-new)'),
      ],
    ]);
    expect(result.left[2].linkedTo).toBe('sdb-new');
    // Stash has no file for sdb-nofile: Whisparr is asked to look again.
    expect(handoff.refreshMovies).toHaveBeenCalledWith([7]);
  });

  it('says when Whisparr is still importing a finished download', async () => {
    const rows = [
      {
        stashId: 'sdb-q',
        title: 'Queued',
        whisparrQueueStatus: 'completed',
        whisparrQueueState: 'importPending',
      },
    ];
    prisma.sceneIndex.findMany = jest.fn().mockResolvedValue(rows);
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([]);

    const result = await service.checkWaitingScenes();

    expect(result.left).toEqual([
      expect.objectContaining({
        stashId: 'sdb-q',
        kind: 'importing',
        reason: expect.stringContaining('Whisparr says: import pending'),
      }),
    ]);
  });

  it('has Whisparr look again for files deleted from here', async () => {
    jest.useFakeTimers();
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      { stashId: 'sdb-a', filePath: '/data/a/a.mp4', folder: null, movieId: 3 },
      { stashId: 'sdb-b', filePath: '/data/b/b.mp4', folder: null, movieId: 4 },
    ]);

    await service.forgetDeletedFiles(['/data/A/A.mp4']);
    jest.advanceTimersByTime(20_000);
    jest.useRealTimers();

    expect(handoff.refreshMovies).toHaveBeenCalledWith([3]);
    expect(indexing.requestImmediateRefresh).toHaveBeenCalledWith(
      ['sdb-a'],
      'whisparr-refresh',
    );
  });

  it('links a scene StashDB merged into another, remembering the old id', async () => {
    const stuck = localScene({
      id: '23',
      stashIds: [],
      files: [{ ...localScene().files[0], id: 'f23', path: '/data/a/a.mp4' }],
    });
    const mergedAway = localScene({
      id: '24',
      stashIds: [
        { endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-new' },
      ],
      files: [{ ...localScene().files[0], id: 'f24', path: '/data/b/b.mp4' }],
    });
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      { stashId: 'sdb-old', filePath: '/data/a/a.mp4', folder: null },
      { stashId: 'sdb-old2', filePath: '/data/b/b.mp4', folder: null },
    ]);
    stash.findOrganizerScenes.mockImplementation(
      (_config, options: { sceneFilter: { path?: { value: string } } }) =>
        Promise.resolve({
          total: 1,
          items: [
            options.sceneFilter.path?.value === '/data/a/a.mp4'
              ? stuck
              : mergedAway,
          ],
        }),
    );
    // StashDB answers each old id with the scene it was merged into.
    stashdb.getMatchScenesById = jest.fn().mockResolvedValue(
      new Map([
        ['sdb-old', { ...remote, id: 'sdb-canon' }],
        ['sdb-old2', { ...remote, id: 'sdb-new' }],
      ]),
    );

    await expect(
      service.linkWaitingScenes(['sdb-old', 'sdb-old2']),
    ).resolves.toEqual(['23', '24']);
    expect(stash.applySceneMatch).toHaveBeenCalledWith(
      expect.anything(),
      '23',
      expect.objectContaining({
        // Stash allows one StashDB link per scene: only the new id.
        stashIds: [
          { endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-canon' },
        ],
      }),
    );
    expect(prisma.sceneStashAlias.upsert).toHaveBeenCalledWith({
      where: { stashId: 'sdb-old' },
      create: { stashId: 'sdb-old', aliasOf: 'sdb-canon' },
      update: { aliasOf: 'sdb-canon' },
    });
    expect(prisma.sceneStashAlias.upsert).toHaveBeenCalledWith({
      where: { stashId: 'sdb-old2' },
      create: { stashId: 'sdb-old2', aliasOf: 'sdb-new' },
      update: { aliasOf: 'sdb-new' },
    });
  });

  it('counts Whisparr’s scene as the one Stash links when told they are the same', async () => {
    const scene = localScene({
      id: '25',
      stashIds: [
        { endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-other' },
      ],
      files: [{ ...localScene().files[0], id: 'f25', path: '/data/c/c.mp4' }],
    });
    handoff.filesAsStashSees = jest
      .fn()
      .mockResolvedValue([
        { stashId: 'sdb-mine', filePath: '/data/c/c.mp4', folder: null },
      ]);
    stash.findOrganizerScenes.mockResolvedValue({ total: 1, items: [scene] });

    await service.markSameScene('sdb-mine');

    expect(prisma.sceneStashAlias.upsert).toHaveBeenCalledWith({
      where: { stashId: 'sdb-mine' },
      create: { stashId: 'sdb-mine', aliasOf: 'sdb-other' },
      update: { aliasOf: 'sdb-other' },
    });
    expect(stash.applySceneMatch).not.toHaveBeenCalled();
    expect(indexing.requestImmediateRefresh).toHaveBeenCalledWith(
      ['sdb-mine'],
      'waiting-link',
    );
  });

  it('never moves Whisparr’s own files to Unmatched, and refuses when Whisparr can’t be asked', async () => {
    const file = (id: string, path: string) => ({
      ...localScene().files[0],
      id,
      path,
    });
    stash.findOrganizerScenes.mockResolvedValue({
      total: 2,
      items: [
        localScene({
          id: '1',
          files: [file('f1', '/data/scenes/Whisparr Owned.mp4')],
        }),
        localScene({ id: '2', files: [file('f2', '/data/inbox/junk.mp4')] }),
      ],
    });
    handoff.filesAsStashSees = jest.fn().mockResolvedValue([
      {
        stashId: 'w',
        filePath: '/data/scenes/whisparr owned.mp4',
        folder: null,
      },
    ]);

    await expect(service.unmatched(1)).resolves.toMatchObject({ toMove: 1 });

    handoff.filesAsStashSees = jest.fn().mockRejectedValue(new Error('down'));
    service.startMoveUnmatched();
    await waitUntilIdle(service);
    expect(stash.moveFile).not.toHaveBeenCalled();
    expect(service.status().message).toMatch(
      /Couldn’t ask Whisparr which files are its own/,
    );
  });

  it('refuses an expired or unknown match', async () => {
    await expect(service.apply('7', 'nope')).rejects.toThrow(/expired/);
  });

  it('rejects a bad pattern', async () => {
    await expect(
      service.updateSettings({ renamePattern: '../{title}' }),
    ).rejects.toThrow(/up a folder/);
  });

  it('previews only files that would change', async () => {
    stash.findOrganizerScenes.mockResolvedValue({
      total: 2,
      items: [
        localScene({
          id: '1',
          title: 'A',
          studio: { id: 's', name: 'S' },
          date: '2020-01-02',
          stashIds: [{ endpoint: 'e', stashId: 'x' }],
        }),
        localScene({
          id: '2',
          title: 'B',
          studio: { id: 's', name: 'S' },
          date: '2020-01-02',
          stashIds: [{ endpoint: 'e', stashId: 'y' }],
          files: [
            {
              ...localScene().files[0],
              id: 'f2',
              path: '/data/S/2020-01-02 - B.mp4',
            },
          ],
        }),
      ],
    });
    const preview = await service.renamePreview();
    expect(preview.counts.ready).toBe(1);
    expect(preview.counts.same).toBe(1);
    expect(preview.changes[0].to).toBe('/data/S/2020-01-02 - A.mp4');
  });
});

describe('nested scenes folders', () => {
  const pattern = 'scenes/{studio}/{date} - {title}';
  const scene = (path: string) =>
    localScene({
      title: 'T',
      date: '2020-01-02',
      studio: { id: 's', name: 'S' },
      stashIds: [{ endpoint: 'e', stashId: 'x' }],
      files: [{ ...localScene().files[0], path }],
    });

  it('never adds scenes/ twice when the library folder already is scenes', () => {
    const roots = ['/data/stash content', '/data/stash content/scenes'];
    expect(
      planRename(
        scene('/data/stash content/scenes/S/old.mp4'),
        roots,
        pattern,
        new Set(),
      ).to,
    ).toBe('/data/stash content/scenes/S/2020-01-02 - T.mp4');
    expect(
      planRename(
        scene('/data/stash content/x.mp4'),
        roots,
        pattern,
        new Set(),
        '/data/stash content/scenes',
      ).to,
    ).toBe('/data/stash content/scenes/S/2020-01-02 - T.mp4');
  });

  it('moves files that ended up in scenes/scenes/scenes back to scenes/', () => {
    const roots = ['/data/stash content'];
    const plan = planRename(
      scene('/data/stash content/scenes/scenes/scenes/S/2020-01-02 - T.mp4'),
      roots,
      pattern,
      new Set(),
      '/data/stash content',
    );
    expect(plan).toMatchObject({
      state: 'ready',
      to: '/data/stash content/scenes/S/2020-01-02 - T.mp4',
    });
  });

  it('trims repeated prefixes from a root', () => {
    expect(
      withoutRepeatedPrefix('/data/x/scenes/scenes', [], ['scenes']).root,
    ).toBe('/data/x');
    expect(withoutRepeatedPrefix('/data/x', [], ['scenes']).root).toBe(
      '/data/x',
    );
    expect(withoutRepeatedPrefix('/data/x/scenes', [], []).root).toBe(
      '/data/x/scenes',
    );
  });
});

describe('staticPrefix', () => {
  it('takes the fixed folders at the start of a pattern', () => {
    expect(staticPrefix('scenes/{studio}/{date} - {title}')).toEqual([
      'scenes',
    ]);
    expect(staticPrefix('media/scenes/{studio}/{title}')).toEqual([
      'media',
      'scenes',
    ]);
    expect(staticPrefix('{studio}/{title}')).toEqual([]);
    expect(staticPrefix('{title}')).toEqual([]);
  });
});

describe('planUnmatchedMove', () => {
  it('keeps the file name and uses the chosen library folder if there is one', () => {
    const scene = localScene({
      files: [{ ...localScene().files[0], path: '/data/stash content/x.mp4' }],
    });
    const roots = ['/data/stash content', '/data/scenes'];
    expect(planUnmatchedMove(scene, roots, null).to).toBe(
      '/data/stash content/Unmatched/x.mp4',
    );
    expect(planUnmatchedMove(scene, roots, '/data/scenes').to).toBe(
      '/data/scenes/Unmatched/x.mp4',
    );
    expect(planUnmatchedMove(scene, ['/elsewhere'], null).state).toBe(
      'outside',
    );
  });
});

describe('rename destination', () => {
  const matched = localScene({
    title: 'T',
    date: '2020-01-02',
    studio: { id: 's', name: 'S' },
    stashIds: [{ endpoint: 'e', stashId: 'x' }],
    files: [
      { ...localScene().files[0], path: '/data/stash content/messy.mp4' },
    ],
  });
  const roots = ['/data/stash content', '/data/scenes/'];

  it('keeps each file in its own library folder by default', () => {
    expect(
      planRename(matched, roots, '{studio}/{date} - {title}', new Set()).to,
    ).toBe('/data/stash content/S/2020-01-02 - T.mp4');
  });

  it('moves files into the chosen library folder', () => {
    const target = pickTargetRoot('/data/scenes', roots);
    expect(target).toBe('/data/scenes');
    expect(
      planRename(matched, roots, '{studio}/{date} - {title}', new Set(), target)
        .to,
    ).toBe('/data/scenes/S/2020-01-02 - T.mp4');
  });

  it('ignores a folder Stash no longer has as a library', () => {
    expect(pickTargetRoot('/elsewhere', roots)).toBeNull();
    expect(pickTargetRoot('', roots)).toBeNull();
  });
});

describe('planRename', () => {
  const matched = localScene({
    title: 'T',
    studio: { id: 's', name: 'S' },
    stashIds: [{ endpoint: 'e', stashId: 'x' }],
  });

  it('skips Whisparr files', () => {
    expect(
      planRename(matched, ['/data'], '{studio}/{title}', new Set(['x'])).state,
    ).toBe('whisparr');
    // A file in one of Whisparr's scene folders is Whisparr's, whatever
    // StashDB scene Stash has it linked to.
    const inFolder = {
      ...matched,
      stashIds: [{ endpoint: 'e', stashId: 'other' }],
      files: [{ ...matched.files[0], path: '/data/scenes/S/2020 - T/t.mp4' }],
    };
    expect(
      planRename(inFolder, ['/data'], '{studio}/{title}', new Set(), null, [
        '/DATA/scenes/S/2020 - T/',
      ]).state,
    ).toBe('whisparr');
    expect(
      planRename(inFolder, ['/data'], '{studio}/{title}', new Set(), null, [
        '/data/scenes/S/2020',
      ]).state,
    ).not.toBe('whisparr');
  });

  it('skips files outside the library folders', () => {
    expect(
      planRename(matched, ['/elsewhere'], '{studio}/{title}', new Set()).state,
    ).toBe('outside');
  });

  it('needs a title', () => {
    expect(
      planRename(
        localScene({ title: null }),
        ['/data'],
        '{studio}/{title}',
        new Set(),
      ).state,
    ).toBe('missing');
  });

  it('numbers clashing names', () => {
    const plans = dedupeTargets([
      {
        sceneId: '1',
        fileId: 'a',
        title: 'T',
        from: '/data/x.mp4',
        to: '/data/S/T.mp4',
        state: 'ready',
      },
      {
        sceneId: '2',
        fileId: 'b',
        title: 'T',
        from: '/data/y.mp4',
        to: '/data/S/T.mp4',
        state: 'ready',
      },
    ]);
    expect(plans.map((plan) => plan.to)).toEqual([
      '/data/S/T.mp4',
      '/data/S/T (2).mp4',
    ]);
  });
});

describe('pickSure', () => {
  const base: MatchCandidateDto = {
    id: 'a',
    title: null,
    date: null,
    studio: null,
    performers: [],
    cast: [],
    studioImageUrl: null,
    tags: [],
    imageUrl: null,
    duration: null,
    code: null,
    source: 'StashDB',
    score: 1,
    confidence: 'exact',
    reasons: [],
  };

  it('takes a single fingerprint match', () => {
    expect(pickSure([base])?.id).toBe('a');
  });

  it('won’t guess between two fingerprint matches', () => {
    expect(pickSure([base, { ...base, id: 'b' }])).toBeNull();
  });

  it('takes a strong name match only when it is well ahead', () => {
    const strong = { ...base, confidence: 'strong' as const, score: 0.85 };
    expect(
      pickSure([
        strong,
        { ...base, id: 'b', confidence: 'likely' as const, score: 0.5 },
      ])?.id,
    ).toBe('a');
    expect(
      pickSure([
        strong,
        { ...base, id: 'b', confidence: 'strong' as const, score: 0.8 },
      ]),
    ).toBeNull();
  });

  it('ignores the same scene found on another site', () => {
    const strong = { ...base, confidence: 'strong' as const, score: 0.85 };
    expect(
      pickSure([
        strong,
        { ...strong, id: 'b', source: 'ThePornDB', score: 0.84 },
      ])?.id,
    ).toBe('a');
  });
});
