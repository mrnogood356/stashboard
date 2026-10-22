import type { IndexingService } from '../indexing/indexing.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type {
  StashAdapter,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import type { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  WhisparrHandoffService,
  candidateBases,
  directItem,
  mapPath,
} from './whisparr-handoff.service';

function scene(
  overrides: Partial<StashOrganizerScene> = {},
): StashOrganizerScene {
  return {
    id: '7',
    title: 'Summer',
    code: null,
    date: null,
    organized: false,
    screenshotVersion: null,
    studio: { id: '1', name: 'Bright' },
    performers: [],
    tagIds: [],
    stashIds: [{ endpoint: 'https://stashdb.org/graphql', stashId: 'sdb-1' }],
    files: [
      {
        id: 'f',
        path: '/data/inbox/a.mp4',
        basename: 'a.mp4',
        duration: 1,
        size: 1,
        width: 1,
        height: 1,
        fingerprints: [],
      },
    ],
    ...overrides,
  };
}

const settings = {
  sendToWhisparr: true,
  addToWhisparr: false,
  whisparrImportMode: 'move',
  whisparrPathFrom: '/data',
  whisparrPathTo: '/mnt/user/media',
} as never;

describe('WhisparrHandoffService', () => {
  let whisparr: Record<string, jest.Mock>;
  let stash: Record<string, jest.Mock>;
  let indexing: Record<string, jest.Mock>;
  let service: WhisparrHandoffService;

  beforeEach(() => {
    whisparr = {
      // Missing before the import, there after it.
      findMovieByStashId: jest
        .fn()
        .mockResolvedValueOnce({ movieId: 5, stashId: 'sdb-1', hasFile: false })
        .mockResolvedValue({ movieId: 5, stashId: 'sdb-1', hasFile: true }),
      pathType: jest.fn().mockResolvedValue('missing'),
      getQualityDefinitions: jest.fn().mockResolvedValue([
        {
          id: 0,
          name: 'Unknown',
          source: 'unknown',
          resolution: 0,
          raw: { id: 0, name: 'Unknown' },
        },
        {
          id: 3,
          name: 'WEBDL-1080p',
          source: 'webdl',
          resolution: 1080,
          raw: { id: 3, name: 'WEBDL-1080p' },
        },
        {
          id: 7,
          name: 'Bluray-1080p',
          source: 'bluray',
          resolution: 1080,
          raw: { id: 7, name: 'Bluray-1080p' },
        },
      ]),
      getManualImportItems: jest.fn().mockResolvedValue([
        {
          path: '/mnt/user/media/inbox/a.mp4',
          quality: { q: 1 },
          languages: [],
          releaseGroup: null,
          rejections: [],
        },
      ]),
      startManualImport: jest.fn().mockResolvedValue(77),
      getCommandStatus: jest
        .fn()
        .mockResolvedValue({ status: 'completed', message: null }),
      getRootFolders: jest
        .fn()
        .mockResolvedValue([
          { id: 1, path: '/mnt/user/media/whisparr', accessible: true },
        ]),
      getQualityProfiles: jest.fn().mockResolvedValue([{ id: 3, name: 'Any' }]),
      createMovie: jest.fn().mockResolvedValue({ movieId: 9 }),
    };
    stash = {
      startLibraryTask: jest.fn().mockResolvedValue('scan'),
      scanPaths: jest.fn().mockResolvedValue('scan'),
      listStashBoxes: jest.fn().mockResolvedValue([]),
    };
    indexing = {
      requestImmediateRefresh: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      integrationConfig: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          status: 'CONFIGURED',
          baseUrl: 'http://w',
          apiKey: 'k',
        }),
      },
    };
    const catalog = {
      getInstanceCatalogProvider: jest
        .fn()
        .mockResolvedValue({ baseUrl: 'https://stashdb.org', apiKey: null }),
    };
    service = new WhisparrHandoffService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      whisparr as unknown as WhisparrAdapter,
      catalog as unknown as CatalogProviderService,
      indexing as unknown as IndexingService,
    );
    service.sleep = () => Promise.resolve();
  });

  it('passes on Whisparr being unreachable instead of answering "nothing"', async () => {
    whisparr.listMovies = jest
      .fn()
      .mockRejectedValue(new Error('Failed to reach Whisparr'));
    whisparr.getRootFolders.mockRejectedValue(
      new Error('Failed to reach Whisparr'),
    );

    await expect(service.trackedStashIds()).rejects.toThrow(/reach Whisparr/);
    await expect(service.rootFoldersAsStashSees(settings)).rejects.toThrow(
      /reach Whisparr/,
    );
  });

  it('says when imports leave copies behind, and stays quiet when unsure', async () => {
    whisparr.getImportSettings = jest
      .fn()
      .mockResolvedValue({ copyUsingHardlinks: true, torrentClients: 1 });
    await expect(service.leavesCopies(settings)).resolves.toEqual({
      by: 'whisparr',
      hardlinks: true,
    });

    whisparr.getImportSettings.mockResolvedValue({
      copyUsingHardlinks: null,
      torrentClients: 0,
    });
    await expect(service.leavesCopies(settings)).resolves.toBeNull();
    await expect(
      service.leavesCopies({ whisparrImportMode: 'copy' }),
    ).resolves.toEqual({ by: 'stashboard', hardlinks: null });

    whisparr.getImportSettings.mockRejectedValue(new Error('down'));
    await expect(service.leavesCopies(settings)).resolves.toBeNull();
  });

  it('lists Whisparr’s files as Stash sees them', async () => {
    whisparr.listMovies = jest.fn().mockResolvedValue([
      {
        id: 1,
        title: 'A',
        stashId: 'sdb-1',
        path: '/mnt/user/media/scenes/A',
        rootFolderPath: '/mnt/user/media/scenes',
        hasFile: true,
        filePath: '/mnt/user/media/scenes/A/a.mp4',
      },
      {
        id: 2,
        title: 'Missing',
        stashId: 'sdb-2',
        path: '/mnt/user/media/scenes/B',
        rootFolderPath: '/mnt/user/media/scenes',
        hasFile: false,
        filePath: null,
      },
    ]);

    await expect(service.filesAsStashSees(settings)).resolves.toEqual([
      {
        stashId: 'sdb-1',
        filePath: '/data/scenes/A/a.mp4',
        folder: '/data/scenes/A',
        movieId: 1,
      },
    ]);
  });

  it('imports a missing scene into Whisparr through the mapped path', async () => {
    whisparr.listMovies = jest
      .fn()
      .mockResolvedValue([{ id: 5, path: '/mnt/user/media/whisparr/Summer' }]);
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [scene()],
      settings,
    );
    expect(whisparr.getManualImportItems).toHaveBeenCalledWith(
      expect.anything(),
      '/mnt/user/media/inbox/a.mp4',
      5,
      60000,
    );
    expect(whisparr.startManualImport).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          movieId: 5,
          item: expect.objectContaining({
            path: '/mnt/user/media/inbox/a.mp4',
          }),
        }),
      ],
      'move',
    );
    expect(result.sent).toEqual([{ sceneId: '7', title: 'Summer' }]);
    // Only the folder Whisparr put the scene in, as Stash sees it.
    expect(stash.scanPaths).toHaveBeenCalledWith(expect.anything(), [
      '/data/whisparr/Summer',
    ]);
    expect(indexing.requestImmediateRefresh).toHaveBeenCalledWith(
      ['sdb-1'],
      'whisparr-handoff',
    );
  });

  it('skips scenes Whisparr already has, doesn’t know, or that aren’t from StashDB', async () => {
    whisparr.findMovieByStashId
      .mockReset()
      .mockResolvedValueOnce({ movieId: 5, stashId: 'sdb-1', hasFile: true })
      .mockResolvedValueOnce(null);
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [
        scene(),
        scene({ id: '8' }),
        scene({
          id: '9',
          stashIds: [
            { endpoint: 'https://theporndb.net/graphql', stashId: 't' },
          ],
        }),
      ],
      settings,
    );
    expect(result.skipped).toEqual({
      'already-has-file': 1,
      'not-in-whisparr': 1,
      'not-catalog': 1,
    });
    expect(whisparr.startManualImport).not.toHaveBeenCalled();
  });

  it('adds unknown scenes to Whisparr when that is on', async () => {
    whisparr.findMovieByStashId
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ movieId: 9, stashId: 'sdb-1', hasFile: true });
    await service.send({ baseUrl: 'http://stash' }, [scene()], {
      ...(settings as object),
      addToWhisparr: true,
    } as never);
    expect(whisparr.createMovie).toHaveBeenCalledWith(
      expect.objectContaining({
        foreignId: 'sdb-1',
        title: 'Summer',
        studio: 'Bright',
        rootFolderPath: '/mnt/user/media/whisparr',
        qualityProfileId: 3,
        addOptions: { searchForMovie: false },
      }),
      expect.anything(),
    );
    expect(whisparr.getManualImportItems).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      9,
      60000,
    );
  });

  it('reports when Whisparr can’t see the file', async () => {
    whisparr.getManualImportItems.mockResolvedValue([]);
    whisparr.pathType = jest.fn().mockResolvedValue('missing');
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [scene()],
      settings,
    );
    expect(result.failed[0].reason).toMatch(
      /can’t see \/mnt\/user\/media\/inbox\/a\.mp4 \(Stash has it at \/data\/inbox\/a\.mp4\)/,
    );
  });

  it('asks about the folder when Whisparr lists nothing for the file itself', async () => {
    whisparr.getManualImportItems
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          path: '/mnt/user/media/inbox/other.mp4',
          quality: null,
          languages: [],
          releaseGroup: null,
          rejections: [],
        },
        {
          path: '/mnt/user/media/inbox/a.mp4',
          quality: { q: 2 },
          languages: [],
          releaseGroup: null,
          rejections: [],
        },
      ]);
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [scene()],
      settings,
    );
    expect(whisparr.getManualImportItems).toHaveBeenLastCalledWith(
      expect.anything(),
      '/mnt/user/media/inbox',
      0,
      600000,
    );
    expect(whisparr.startManualImport).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          item: expect.objectContaining({
            path: '/mnt/user/media/inbox/a.mp4',
          }),
        }),
      ],
      'move',
    );
    expect(result.sent).toHaveLength(1);
  });

  it('says when Whisparr sees the folder but can’t read the file', async () => {
    whisparr.getManualImportItems.mockResolvedValue([]);
    whisparr.pathType = jest.fn((_config, path: string) =>
      Promise.resolve(path.endsWith('.mp4') ? 'missing' : 'folder'),
    );
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [scene()],
      settings,
    );
    expect(result.failed[0].reason).toMatch(/permission/);
  });

  it('finds where Whisparr sees the files', async () => {
    whisparr.getRootFolders.mockResolvedValue([
      { id: 1, path: '/mnt/user/media/whisparr', accessible: true },
    ]);
    const seen = new Set([
      '/mnt/user/media/stash/inbox/a.mp4',
      '/mnt/user/media/stash/b/c.mp4',
    ]);
    whisparr.pathType = jest.fn((_config, path: string) =>
      Promise.resolve(seen.has(path) ? 'file' : 'missing'),
    );
    const found = await service.detectMapping([
      scene({
        files: [{ ...scene().files[0], path: '/data/stash/inbox/a.mp4' }],
      }),
      scene({ files: [{ ...scene().files[0], path: '/data/stash/b/c.mp4' }] }),
    ]);
    expect(found).toEqual({
      from: '/data',
      to: '/mnt/user/media',
      example: '/mnt/user/media/stash/inbox/a.mp4',
    });
  });

  it('says so when both apps use the same path, and gives up politely otherwise', async () => {
    whisparr.pathType = jest.fn().mockResolvedValueOnce('file');
    expect(await service.detectMapping([scene()])).toEqual({
      from: '',
      to: '',
      example: '/data/inbox/a.mp4',
    });
    whisparr.pathType = jest.fn().mockResolvedValue('missing');
    expect(await service.detectMapping([scene()])).toBeNull();
  });

  it('lists likely folders, deepest first', () => {
    const bases = candidateBases(['/mnt/user/media/whisparr']);
    expect(bases.slice(0, 2)).toEqual([
      '/mnt/user/media/whisparr',
      '/mnt/user/media',
    ]);
    expect(bases).toContain('/data');
    expect(bases[bases.length - 1]).toBe('/');
  });

  it('explains a path Whisparr can’t see, with both paths', async () => {
    whisparr.getManualImportItems.mockResolvedValue([]);
    whisparr.pathType = jest.fn().mockResolvedValue('missing');
    const result = await service.send({ baseUrl: 'http://stash' }, [scene()], {
      ...(settings as object),
      whisparrPathFrom: null,
      whisparrPathTo: null,
    } as never);
    expect(result.failed[0].reason).toMatch(/Find it for me/);
  });

  it('imports directly when Whisparr can see the file but won’t list it', async () => {
    whisparr.getManualImportItems.mockResolvedValue([]);
    whisparr.pathType.mockResolvedValue('file');
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [scene({ files: [{ ...scene().files[0], width: 1920, height: 1080 }] })],
      settings,
    );
    const [, files] = whisparr.startManualImport.mock.calls[0];
    expect(files[0].item.quality).toEqual({
      quality: { id: 3, name: 'WEBDL-1080p' },
      revision: { version: 1, real: 0, isRepack: false },
    });
    expect(whisparr.getManualImportItems).toHaveBeenCalledTimes(1); // no folder scan
    expect(result.sent).toHaveLength(1);
  });

  it('scans a big folder once for all its scenes, and waits longer for it', async () => {
    whisparr.findMovieByStashId
      .mockReset()
      .mockResolvedValue({ movieId: 5, stashId: 'sdb-1', hasFile: false });
    whisparr.getManualImportItems.mockImplementation((_config, path: string) =>
      Promise.resolve(path === '/mnt/user/media/inbox' ? [] : []),
    );
    await service.send(
      { baseUrl: 'http://stash' },
      [scene(), scene({ id: '8' })],
      settings,
    );
    const folderCalls = whisparr.getManualImportItems.mock.calls.filter(
      ([, path]) => path === '/mnt/user/media/inbox',
    );
    expect(folderCalls).toHaveLength(1);
    expect(folderCalls[0][3]).toBe(600000);
  });

  it('only counts a scene as sent when Whisparr really has the file', async () => {
    whisparr.findMovieByStashId
      .mockReset()
      .mockResolvedValue({ movieId: 5, stashId: 'sdb-1', hasFile: false });
    const result = await service.send(
      { baseUrl: 'http://stash' },
      [scene()],
      settings,
    );
    expect(result.sent).toHaveLength(0);
    expect(result.failed[0].reason).toMatch(/didn’t take/);
    expect(indexing.requestImmediateRefresh).not.toHaveBeenCalled();
  });

  it('builds an import entry from the file’s resolution', () => {
    const qualities = [
      {
        id: 5,
        name: 'WEBDL-720p',
        source: 'webdl',
        resolution: 720,
        raw: { id: 5 },
      },
    ];
    expect(
      directItem('/a.mp4', qualities, { width: 1280, height: 720 }).quality,
    ).toEqual({
      quality: { id: 5 },
      revision: { version: 1, real: 0, isRepack: false },
    });
    expect(
      directItem('/a.mp4', [], { width: null, height: null }).quality,
    ).toMatchObject({ quality: { id: 0, name: 'Unknown' } });
  });

  it('plans which Whisparr scenes to move into the scenes folder', async () => {
    whisparr.listMovies = jest.fn().mockResolvedValue([
      {
        id: 1,
        title: 'A',
        path: '/data/stash content/Studio A/A',
        rootFolderPath: '/data/stash content',
        hasFile: true,
        filePath: '/data/stash content/Studio A/A/a.mp4',
      },
      {
        id: 2,
        title: 'B',
        path: '/data/stash content/scenes/Studio B',
        rootFolderPath: '/data/stash content/scenes',
        hasFile: true,
        filePath: '/data/stash content/scenes/Studio B/b.mp4',
      },
      {
        id: 3,
        title: 'C',
        path: '/data/stash content/Studio C',
        rootFolderPath: '/data/stash content',
        hasFile: false,
        filePath: null,
      },
      {
        id: 4,
        title: 'D',
        path: '/elsewhere/D',
        rootFolderPath: '/elsewhere',
        hasFile: true,
        filePath: '/elsewhere/D/d.mp4',
      },
      {
        id: 5,
        title: 'E',
        path: '/data/stash content/scenes/scenes/scenes/Studio E',
        rootFolderPath: '/data/stash content/scenes/scenes/scenes',
        hasFile: true,
        filePath: '/data/stash content/scenes/scenes/scenes/Studio E/e.mp4',
      },
    ]);
    const plan = await service.relocationPlan(
      { whisparrPathFrom: null, whisparrPathTo: null } as never,
      ['/data/stash content', '/data/'],
      '/data/stash content/scenes',
    );
    expect(plan).toMatchObject({
      whisparrDestination: '/data/stash content/scenes',
      movieIds: [1, 5],
    });
  });

  it('has Whisparr move them (adding the root folder), waits, then scans Stash', async () => {
    whisparr.getRootFolders.mockResolvedValue([
      { id: 1, path: '/data/stash content', accessible: true },
    ]);
    whisparr.addRootFolder = jest.fn().mockResolvedValue(undefined);
    whisparr.moveMoviesToRootFolder = jest.fn().mockResolvedValue(undefined);
    whisparr.listCommands = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 9, name: 'BulkMoveMovie', status: 'started' },
      ])
      .mockResolvedValue([
        { id: 9, name: 'BulkMoveMovie', status: 'completed' },
      ]);
    whisparr.listMovies = jest.fn().mockResolvedValue([
      { id: 1, path: '/data/stash content/scenes/A' },
      { id: 5, path: '/data/stash content/scenes/E' },
      { id: 6, path: '/data/stash content/scenes/F' },
    ]);
    const moved = await service.relocate(
      { baseUrl: 'http://stash' },
      { whisparrDestination: '/data/stash content/scenes', movieIds: [1, 5] },
    );
    expect(moved).toBe(2);
    expect(whisparr.addRootFolder).toHaveBeenCalledWith(
      expect.anything(),
      '/data/stash content/scenes',
    );
    expect(whisparr.moveMoviesToRootFolder).toHaveBeenCalledWith(
      expect.anything(),
      [1, 5],
      '/data/stash content/scenes',
    );
    expect(whisparr.listCommands).toHaveBeenCalledTimes(2);
    expect(stash.scanPaths).toHaveBeenCalledWith(expect.anything(), [
      '/data/stash content/scenes/A',
      '/data/stash content/scenes/E',
    ]);
  });

  it('plans every scene into its pattern folder, keeping the studio', async () => {
    whisparr.listMovies = jest.fn().mockResolvedValue([
      {
        id: 1,
        title: 'A',
        stashId: 'a',
        path: '/data/sc/scenes/scenes/S1/A - 2020',
        rootFolderPath: '',
        hasFile: true,
        filePath: 'x',
        studio: 'S1',
        date: '2020-01-01',
      },
      {
        id: 2,
        title: 'B',
        stashId: 'b',
        path: '/data/sc/scenes/B - 2021',
        rootFolderPath: '',
        hasFile: false,
        filePath: null,
        studio: 'S2',
        date: '2021-02-02',
      },
      {
        id: 3,
        title: 'C',
        stashId: 'c',
        path: '/data/sc/scenes/S1/2020-03-03 - C',
        rootFolderPath: '',
        hasFile: true,
        filePath: 'y',
        studio: 'S1',
        date: '2020-03-03',
      },
      {
        id: 4,
        title: 'D',
        stashId: 'd',
        path: '/elsewhere/D',
        rootFolderPath: '',
        hasFile: false,
        filePath: null,
        studio: 'S1',
        date: '2020-04-04',
      },
      {
        id: 5,
        title: 'E',
        stashId: 'e',
        path: '/data/sc/scenes/E',
        rootFolderPath: '',
        hasFile: false,
        filePath: null,
        studio: 'S1',
        date: '2020-03-03',
      },
    ]);
    const folderFor = (movie: {
      title: string;
      studio?: string | null;
      date?: string | null;
    }) =>
      movie.title === 'E'
        ? '/data/sc/scenes/S1/2020-03-03 - C'
        : `/data/sc/scenes/${movie.studio}/${movie.date} - ${movie.title}`;
    const plan = await service.repairPlan(
      { whisparrPathFrom: null, whisparrPathTo: null } as never,
      ['/data/sc'],
      '/data/sc/scenes',
      new Set(['b']),
      folderFor,
      '/data/sc',
    );
    expect(plan).toMatchObject({
      whisparrRoot: '/data/sc',
      withFiles: [{ id: 1, target: '/data/sc/scenes/S1/2020-01-01 - A' }],
      missing: [
        { id: 2, target: '/data/sc/scenes/S2/2021-02-02 - B' },
        // Same folder as scene 3, which is already right: gets its own.
        { id: 5, target: '/data/sc/scenes/S1/2020-03-03 - C (2)' },
      ],
      lost: [{ movieId: 2, stashId: 'b' }],
      total: 3,
    });
  });

  it('moves downloaded scenes with their files, points missing ones without moving anything, and checks the result', async () => {
    whisparr.getRootFolders.mockResolvedValue([
      { id: 1, path: '/data/sc/scenes', accessible: true },
    ]);
    whisparr.setMoviePath = jest.fn().mockResolvedValue(undefined);
    whisparr.refreshMovies = jest.fn().mockResolvedValue(undefined);
    whisparr.listCommands = jest.fn().mockResolvedValue([]);
    whisparr.listMovies = jest.fn().mockResolvedValue([
      { id: 1, path: '/data/sc/scenes/S/2020 - A', hasFile: true },
      { id: 2, path: '/data/sc/scenes/B', hasFile: false },
    ]);
    const result = await service.resetPaths({
      whisparrDestination: '/data/sc/scenes',
      withFiles: [
        {
          id: 1,
          title: 'A',
          path: '/data/sc/scenes/A',
          target: '/data/sc/scenes/S/2020 - A',
        },
      ],
      missing: [
        {
          id: 2,
          title: 'B',
          path: '/data/sc/scenes/B',
          target: '/data/sc/scenes/S/2021 - B',
        },
      ],
      lost: [
        { movieId: 2, stashId: 'b', title: 'B', path: '/data/sc/scenes/B' },
      ],
    });
    expect(whisparr.setMoviePath).toHaveBeenCalledWith(
      expect.anything(),
      1,
      '/data/sc/scenes/S/2020 - A',
      '/data/sc/scenes',
      true,
    );
    expect(whisparr.setMoviePath).toHaveBeenCalledWith(
      expect.anything(),
      2,
      '/data/sc/scenes/S/2021 - B',
      '/data/sc/scenes',
      false,
    );
    expect(whisparr.refreshMovies).toHaveBeenCalledWith(expect.anything(), [2]);
    // Whisparr still has scene 2 in the old folder.
    expect(result.stillWrong).toBe(1);
  });

  it('maps paths', () => {
    expect(mapPath('/data/a/b.mp4', '/data/', '/mnt/user/media')).toBe(
      '/mnt/user/media/a/b.mp4',
    );
    expect(mapPath('/database/x.mp4', '/data', '/m')).toBe('/database/x.mp4');
    expect(mapPath('/data/a.mp4', '', '')).toBe('/data/a.mp4');
    expect(mapPath('/data/a/b.mp4', '/data', 'D:\\media')).toBe(
      'D:\\media\\a\\b.mp4',
    );
  });
});
