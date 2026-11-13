import { NotFoundException } from '@nestjs/common';
import type {
  StashAdapter,
  StashLocalSceneCard,
} from '../providers/stash/stash.adapter';
import {
  isSamplePath,
  LocalLibraryService,
  pickKeeper,
  pickKeeperWithReason,
  toCard,
} from './local-library.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PlaybackService } from './playback.service';

function card(id: string, playCount = 0): StashLocalSceneCard {
  return {
    id,
    title: `Scene ${id}`,
    date: null,
    screenshotVersion: '1',
    studio: null,
    duration: 100,
    playCount,
    resumeTime: 0,
  };
}

describe('LocalLibraryService', () => {
  const config = { baseUrl: 'http://stash.local', apiKey: 'k' };
  const playback = {
    getStashConfig: jest.fn().mockResolvedValue(config),
    getSceneDetails: jest.fn().mockResolvedValue({ id: '1' }),
  };
  const stash = {
    getLocalSceneDetails: jest.fn(),
    findLocalScenes: jest.fn(),
    updateLocalScene: jest.fn().mockResolvedValue(undefined),
    setSceneWatched: jest.fn().mockResolvedValue(undefined),
    getLocalPerformer: jest.fn(),
    getLocalStudio: jest.fn(),
    setPerformerFavorite: jest.fn().mockResolvedValue(undefined),
    searchTags: jest.fn(),
    findSampleScenes: jest.fn(),
    listLibraryFiles: jest.fn(),
    listTags: jest.fn(),
    getOrganizerScene: jest.fn(),
    deleteScene: jest.fn().mockResolvedValue(undefined),
    mergeTags: jest.fn().mockResolvedValue(undefined),
    listForMerge: jest.fn(),
    findChapters: jest.fn().mockResolvedValue([]),
    mergePerformers: jest.fn().mockResolvedValue(undefined),
    mergeStudios: jest.fn().mockResolvedValue(undefined),
    startLibraryTask: jest.fn().mockResolvedValue('7'),
    findProblemScenes: jest.fn(),
    findGenerateGaps: jest.fn().mockResolvedValue({
      missing: 3,
      checked: 10,
      unanswered: 0,
      scenes: [
        { id: '4', title: 'S', path: null, problems: ['No cover picture.'] },
      ],
    }),
    listScenesForChecks: jest.fn().mockResolvedValue([]),
  };
  const service = new LocalLibraryService(
    playback as unknown as PlaybackService,
    stash as unknown as StashAdapter,
  );

  beforeEach(() => jest.clearAllMocks());

  it('refuses to delete from disk a duplicate whose scene has more than one file', async () => {
    stash.getOrganizerScene.mockResolvedValue({
      files: [{ path: '/a' }, { path: '/b' }],
    });
    await expect(service.deleteScene('9', true, true)).rejects.toThrow(
      'has 2 files',
    );
    expect(stash.deleteScene).not.toHaveBeenCalled();
  });

  it('merges only tags Stash still has, never a tag into itself', async () => {
    stash.listTags.mockResolvedValue([
      { id: '1', name: 'Blonde', aliases: [], sceneCount: 3 },
      { id: '2', name: 'blondes', aliases: [], sceneCount: 30 },
    ]);
    await service.mergeTags('2', ['1', '2']);
    expect(stash.mergeTags).toHaveBeenCalledWith(config, ['1'], '2');

    await expect(service.mergeTags('2', ['2'])).rejects.toThrow(
      'Pick at least one',
    );
    await expect(service.mergeTags('2', ['9'])).rejects.toThrow(
      'gone from Stash',
    );
    expect(stash.mergeTags).toHaveBeenCalledTimes(1);
  });

  it('passes only plain strings to Stash for chapters and merge searches', async () => {
    await service.chapters({
      tagId: ['1', '2'] as unknown as string,
      performerId: ' 33 ',
      query: ['a', 'b'] as unknown as string,
    });
    expect(stash.findChapters).toHaveBeenCalledWith(expect.anything(), {
      tagId: null,
      performerId: '33',
      query: null,
      limit: 500,
    });
    stash.listForMerge.mockResolvedValue([]);
    await expect(
      service.mergeCandidates('performer', ['x'] as unknown as string),
    ).resolves.toEqual({ groups: [], matches: [] });
  });

  it('suggests performers entered twice, and merges only ones Stash still has', async () => {
    const person = (
      id: string,
      name: string,
      sceneCount: number,
      aliases: string[] = [],
      extra: { note?: string; links?: string[] } = {},
    ) => ({
      id,
      name,
      aliases,
      sceneCount,
      note: extra.note ?? null,
      deathDate: null,
      links: extra.links ?? [],
    });
    stash.listForMerge.mockResolvedValue([
      person('1', 'Jane Doe', 3),
      person('2', 'Jané  Doe', 9),
      person('3', 'Alexis', 1),
      person('4', 'Alexi', 1),
      person('5', 'JD', 2, ['Jane-Doe']),
    ]);

    const found = await service.mergeCandidates('performer', 'ale');
    expect(found.groups).toEqual([
      {
        keepId: '2',
        items: [
          expect.objectContaining({ id: '2' }),
          expect.objectContaining({ id: '1' }),
          expect.objectContaining({ id: '5' }),
        ],
      },
    ]);
    expect(found.matches.map((item) => item.id)).toEqual(['3', '4']);

    await expect(service.merge('performer', '2', ['2'])).rejects.toThrow(
      'Pick at least one',
    );
    await expect(service.merge('performer', '2', ['99'])).rejects.toThrow(
      'gone from Stash',
    );
    await service.merge('performer', '2', ['1', '5', '1']);
    expect(stash.mergePerformers).toHaveBeenCalledWith(expect.anything(), '2', [
      '1',
      '5',
    ]);

    // Same name, but StashDB says two people, or Stash tells them apart.
    stash.listForMerge.mockResolvedValue([
      person('1', 'Lily', 9, [], {
        links: ['https://stashdb.org/graphql|aaa'],
      }),
      person('2', 'Lily', 5, [], {
        links: ['https://stashdb.org/graphql|bbb'],
      }),
      person('3', 'Lily', 2),
      person('4', 'Mia', 4, [], { note: 'UK' }),
      person('5', 'Mia', 3, [], { note: 'US' }),
    ]);
    const apart = await service.mergeCandidates('performer');
    expect(
      apart.groups.map((group) => group.items.map((item) => item.id)),
    ).toEqual([['1', '3']]);
    await expect(service.merge('performer', '1', ['2'])).rejects.toThrow(
      'different catalog entry',
    );
    await expect(service.merge('performer', '4', ['5'])).rejects.toThrow(
      'isn’t the same',
    );
    expect(stash.mergeStudios).not.toHaveBeenCalled();
  });

  it('generates for the chosen scenes only, and never for the whole library by accident', async () => {
    await expect(service.generateFor(['4', '5'])).resolves.toEqual({
      jobId: '7',
    });
    expect(stash.startLibraryTask).toHaveBeenCalledWith(
      config,
      'generate',
      ['4', '5'],
      { now: true },
    );
    await expect(service.generateFor([])).rejects.toThrow(
      'Pick at least one scene',
    );
    expect(stash.startLibraryTask).toHaveBeenCalledTimes(1);
  });

  it('lists each kind of broken file, and says when Stash couldn’t answer one', async () => {
    stash.findProblemScenes.mockImplementation((_config, kind: string) =>
      kind === 'unreadable'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve({ count: kind === 'no-file' ? 2 : 0, scenes: [] }),
    );
    // The quick lists answer at once; the file-by-file checks run behind them.
    let finishGenerate: (value: unknown) => void = () => undefined;
    stash.findGenerateGaps.mockImplementationOnce(
      () => new Promise((resolve) => (finishGenerate = resolve)),
    );
    const lists = await service.problems();
    expect(
      lists.map((list) => [list.kind, list.count, list.checking ?? false]),
    ).toEqual([
      ['no-file', 2, false],
      ['no-length', 0, false],
      ['unreadable', null, false],
      ['file-check', null, true],
      ['generate', null, true],
    ]);
    // Asking again while it runs starts no second check.
    await service.problems();
    expect(stash.findGenerateGaps).toHaveBeenCalledTimes(1);

    finishGenerate({ missing: 3, checked: 10, unanswered: 0, scenes: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const done = await service.problems();
    expect(done.at(-1)).toMatchObject({
      kind: 'generate',
      count: 3,
      checking: false,
    });
    // Kept for a while; Look again checks afresh.
    expect(stash.findGenerateGaps).toHaveBeenCalledTimes(1);
    const again = await service.problems(true);
    expect(again.at(-1)).toMatchObject({ count: null, checking: true });
    expect(stash.findGenerateGaps).toHaveBeenCalledTimes(2);
  });

  it('reads the scene list once for both background checks', async () => {
    stash.findProblemScenes.mockResolvedValue({ count: 0, scenes: [] });
    const rows = [{ id: '1', title: 'One', markerIds: [], files: [] }];
    stash.listScenesForChecks.mockClear();
    stash.listScenesForChecks.mockResolvedValueOnce(rows);
    await service.problems(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stash.listScenesForChecks).toHaveBeenCalledTimes(1);
    expect(stash.findGenerateGaps).toHaveBeenLastCalledWith(
      expect.anything(),
      rows,
    );
  });

  it('doesn’t call it all clear when Stash didn’t answer for some files', async () => {
    stash.findProblemScenes.mockResolvedValue({ count: 0, scenes: [] });
    stash.findGenerateGaps.mockResolvedValueOnce({
      missing: 0,
      checked: 10,
      unanswered: 4,
      unansweredWhy: 'HTTP 401',
      scenes: [],
    });
    await service.problems(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.problems()).at(-1)).toMatchObject({
      kind: 'generate',
      count: null,
      unanswered: 4,
      note: 'Stash didn’t answer for 4 files across 10 scenes (HTTP 401), so they couldn’t be checked.',
    });
  });

  describe('files on disk', () => {
    const scene = (id: string, files: Array<Record<string, unknown>>) => ({
      id,
      title: `Scene ${id}`,
      markerIds: [],
      files: files.map((file, index) => ({
        id: `${id}-${index}`,
        size: 1000,
        modTime: '2026-01-01T00:00:00.000Z',
        oshash: null,
        md5: null,
        phash: 'p',
        ...file,
      })),
    });
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    const errno = (code: string) => Object.assign(new Error(code), { code });

    const check = async () => {
      stash.findProblemScenes.mockResolvedValue({ count: 0, scenes: [] });
      await service.problems(true);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      return (await service.problems()).find(
        (list) => list.kind === 'file-check',
      )!;
    };

    it('explains files that are gone, damaged, empty, unreadable or changed', async () => {
      stash.listScenesForChecks.mockResolvedValueOnce([
        scene('1', [{ path: '/ok.mp4' }]),
        scene('2', [{ path: '/gone.mp4' }]),
        scene('3', [{ path: '/cut.mp4' }]),
        scene('4', [{ path: '/changed.mp4' }]),
        scene('5', [{ path: '/empty.mp4' }]),
        scene('6', [{ path: '/io.mp4' }]),
      ]);
      service.statFile = (path) => {
        switch (path) {
          case '/gone.mp4':
            return Promise.reject(errno('ENOENT'));
          case '/io.mp4':
            return Promise.reject(errno('EIO'));
          case '/cut.mp4':
            return Promise.resolve({ size: 400, mtimeMs: at });
          case '/changed.mp4':
            return Promise.resolve({ size: 2000, mtimeMs: at + 60_000 });
          case '/empty.mp4':
            return Promise.resolve({ size: 0, mtimeMs: at });
          default:
            return Promise.resolve({ size: 1000, mtimeMs: at });
        }
      };
      const list = await check();
      expect(list.count).toBe(5);
      const why = Object.fromEntries(
        list.scenes.map((entry) => [entry.id, entry.problems?.[0] ?? '']),
      );
      expect(why['2']).toContain('The file isn’t there');
      expect(why['3']).toContain(
        'smaller than when Stash scanned it, but its date hasn’t changed',
      );
      expect(why['4']).toContain('Scan again');
      expect(why['5']).toContain('empty (0 bytes)');
      expect(why['6']).toContain('I/O error');
      // Damage first.
      expect(['3', '5', '6']).toContain(list.scenes[0].id);
    });

    it('says when Stashboard can’t see the media at all', async () => {
      stash.listScenesForChecks.mockResolvedValueOnce([
        scene('1', [{ path: '/data/a.mp4' }]),
        scene('2', [{ path: '/data/b.mp4' }]),
      ]);
      service.statFile = () => Promise.reject(errno('ENOENT'));
      const list = await check();
      expect(list.count).toBeNull();
      expect(list.note).toContain('can’t see any of your media');
    });
  });

  it('keeps Library stats, and a read under way, to the Stash they came from', async () => {
    let finish: (files: never[]) => void = () => undefined;
    stash.listLibraryFiles.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    stash.listLibraryFiles.mockResolvedValueOnce([]);
    const first = service.stats();
    await Promise.resolve();
    // Stash's address changed while the first read was still going.
    playback.getStashConfig.mockResolvedValueOnce({
      baseUrl: 'http://other.local',
      apiKey: 'k',
    });
    await service.stats();
    expect(stash.listLibraryFiles).toHaveBeenCalledTimes(2);
    finish([]);
    await first;
    // The first Stash's count is kept for it.
    await service.stats();
    expect(stash.listLibraryFiles).toHaveBeenCalledTimes(2);
  });

  it('finds related scenes, most in common first, by performers, studio and tags', async () => {
    stash.getLocalSceneDetails.mockResolvedValue({
      id: '1',
      performers: [{ id: 'p1' }],
      studio: { id: 's1' },
      tags: [{ id: 't1' }, { id: 't2' }, { id: 't3' }, { id: 't4' }],
    });
    stash.findLocalScenes.mockImplementation(
      (_config, options: { sceneFilter: Record<string, unknown> }) => {
        if (options.sceneFilter['performers']) {
          return Promise.resolve({
            total: 3,
            items: [card('1'), card('2', 3), card('3')],
          });
        }
        if (options.sceneFilter['studios']) {
          return Promise.resolve({ total: 2, items: [card('3'), card('4')] });
        }
        return Promise.reject(new Error('tags failed'));
      },
    );

    const related = await service.related('1');

    // Itself is excluded and a failing query is ignored. 3 shares the
    // performer and the studio; 2 (played) a performer, which counts more
    // than 4's studio.
    expect(related.map((item) => item.id)).toEqual(['3', '2', '4']);
    const tagCall = stash.findLocalScenes.mock.calls.find(
      ([, options]) =>
        (options as { sceneFilter: Record<string, unknown> }).sceneFilter[
          'tags'
        ],
    );
    expect((tagCall?.[1] as { sceneFilter: unknown }).sceneFilter).toEqual({
      tags: { value: ['t1', 't2', 't3'], modifier: 'INCLUDES_ALL', depth: 0 },
    });
  });

  it('marks many scenes organized, carrying on past one that fails', async () => {
    stash.updateLocalScene
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Stash said no'))
      .mockResolvedValueOnce(undefined);

    const result = await service.bulkScenes('organize', ['1', '2', '3', '1']);

    expect(stash.updateLocalScene).toHaveBeenCalledTimes(3);
    expect(stash.updateLocalScene).toHaveBeenCalledWith(config, '1', {
      organized: true,
    });
    expect(result).toEqual({
      action: 'organize',
      done: ['1', '3'],
      failed: [{ id: '2', reason: 'Stash said no' }],
    });
  });

  it('carries on a fix list right after the scenes already shown', async () => {
    const cards = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => card(String(from + index)));
    stash.findLocalScenes.mockImplementation(
      (_config, options: { page: number }) =>
        Promise.resolve({
          total: 60,
          items: options.page === 2 ? cards(24, 24) : cards(48, 12),
        }),
    );

    // 30 shown: start at the 7th scene of page 2, and fill up from page 3.
    const result = await service.fixScenes('unmatched', 1, 30);

    expect(result.items.map((item) => item.id)).toEqual([
      ...Array.from({ length: 18 }, (_, index) => String(30 + index)),
      ...Array.from({ length: 6 }, (_, index) => String(48 + index)),
    ]);
    expect(result.hasMore).toBe(true);
  });

  it('reports a missing scene', async () => {
    stash.getLocalSceneDetails.mockResolvedValue(null);
    await expect(service.related('404')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("pages a performer's scenes with the chosen sort", async () => {
    stash.findLocalScenes.mockResolvedValue({ total: 30, items: [card('9')] });

    const page = await service.performerScenes('p1', 1, 'PLAYS');

    expect(stash.findLocalScenes).toHaveBeenCalledWith(config, {
      page: 1,
      perPage: 24,
      sort: 'play_count',
      direction: 'DESC',
      sceneFilter: { performers: { value: ['p1'], modifier: 'INCLUDES_ALL' } },
    });
    expect(page).toEqual(
      expect.objectContaining({ total: 30, page: 1, hasMore: true }),
    );
  });

  it('sorts by production date on Stash 0.32 and later, and by release date before', async () => {
    stash.findLocalScenes.mockResolvedValue({ total: 1, items: [] });
    const supports = jest.fn().mockResolvedValue(true);
    (stash as Record<string, unknown>).supportsProductionDate = supports;

    await service.performerScenes('p1', 1, 'PRODUCED');
    expect(stash.findLocalScenes).toHaveBeenLastCalledWith(
      config,
      expect.objectContaining({ sort: 'production_date', direction: 'DESC' }),
    );

    supports.mockResolvedValue(false);
    await service.performerScenes('p1', 1, 'PRODUCED');
    expect(stash.findLocalScenes).toHaveBeenLastCalledWith(
      config,
      expect.objectContaining({ sort: 'date', direction: 'DESC' }),
    );
  });

  it('includes sub-studios and keeps a random order stable with the seed', async () => {
    stash.findLocalScenes.mockResolvedValue({ total: 1, items: [] });

    await service.studioScenes('s1', 2, 'RANDOM', 42);

    expect(stash.findLocalScenes).toHaveBeenCalledWith(config, {
      page: 2,
      perPage: 24,
      sort: 'random_42',
      direction: 'ASC',
      sceneFilter: {
        studios: { value: ['s1'], modifier: 'INCLUDES', depth: -1 },
      },
    });
  });

  it("narrows a performer's scenes to every picked category and any picked studio", async () => {
    stash.findLocalScenes.mockResolvedValue({ total: 1, items: [] });

    await service.performerScenes('p1', 1, 'DATE', 0, {
      tagIds: ['t1', 't2'],
      studioIds: ['s1'],
    });
    await service.studioScenes('s1', 1, 'DATE', 0, { tagIds: ['t1'] });

    expect(stash.findLocalScenes.mock.calls[0][1].sceneFilter).toEqual({
      performers: { value: ['p1'], modifier: 'INCLUDES_ALL' },
      tags: { value: ['t1', 't2'], modifier: 'INCLUDES_ALL', depth: 0 },
      studios: { value: ['s1'], modifier: 'INCLUDES', depth: -1 },
    });
    expect(stash.findLocalScenes.mock.calls[1][1].sceneFilter).toEqual({
      studios: { value: ['s1'], modifier: 'INCLUDES', depth: -1 },
      tags: { value: ['t1'], modifier: 'INCLUDES_ALL', depth: 0 },
    });
  });

  it('saves edits and returns the refreshed scene', async () => {
    await expect(service.updateScene('1', { rating100: 60 })).resolves.toEqual({
      id: '1',
    });
    expect(stash.updateLocalScene).toHaveBeenCalledWith(config, '1', {
      rating100: 60,
    });
    expect(playback.getSceneDetails).toHaveBeenCalledWith('1');
  });

  it('returns a performer with a proxied picture', async () => {
    stash.getLocalPerformer.mockResolvedValue({
      id: 'p1',
      name: 'Ana',
      imageVersion: '1',
      favorite: false,
    });
    await expect(service.performer('p1')).resolves.toEqual(
      expect.objectContaining({
        imageUrl: '/api/media/stash/performers/p1/image?v=1&w=640',
      }),
    );
  });

  it('builds cards with thumbnails and progress', () => {
    expect(
      toCard({ ...card('5'), resumeTime: 25, width: 3840, height: 2160 }),
    ).toEqual(
      expect.objectContaining({
        width: 3840,
        height: 2160,
        imageUrl: '/api/media/stash/scenes/5/screenshot?v=1',
        cardImageUrl: '/api/media/stash/scenes/5/screenshot?v=1&w=480',
        progress: 0.25,
        source: 'STASH',
      }),
    );
  });

  it('finds sample clips by name, and short ones when asked', async () => {
    const scene = (id: string, path: string, duration: number) => ({
      id,
      title: id,
      date: null,
      screenshotVersion: null,
      studio: null,
      playCount: 0,
      organized: false,
      file: {
        path,
        basename: path.split('/').pop() ?? null,
        size: 1,
        width: 1920,
        height: 1080,
        duration,
        videoCodec: 'h264',
        bitRate: 1,
        frameRate: 30,
      },
    });
    stash.findSampleScenes.mockResolvedValue([
      scene('1', '/data/Studio.Title.1080p/sample.mkv', 30),
      scene('2', '/data/Studio.Title.1080p/Samples/clip.mp4', 300),
      scene('3', '/data/Examples/trailer.mp4', 45),
      // Stash matched "sample" inside a word; not a sample.
      scene('4', '/data/Resampled Studio/scene.mp4', 1800),
      // A real 30-minute scene that lives in a folder called Samples.
      scene('5', '/data/Samples/Studio - Real Scene.mp4', 1800),
    ]);

    const found = await service.samples(1);

    expect(stash.findSampleScenes).toHaveBeenCalledWith(config, 60);
    expect(found.map((entry) => [entry.id, entry.reason])).toEqual([
      ['1', 'name'],
      ['2', 'name'],
      ['3', 'short'],
    ]);
  });

  it('tells a sample folder or file from a word that only contains "sample"', () => {
    expect(isSamplePath('/a/Movie.2020-GRP/Sample/movie-sample.mkv')).toBe(
      true,
    );
    expect(isSamplePath('/a/movie.sample.mp4')).toBe(true);
    expect(isSamplePath('/a/Examples/movie.mp4')).toBe(false);
    expect(isSamplePath('/a/Resampled/movie.mp4')).toBe(false);
  });

  it('tells Whisparr when it deletes a file, so the scene doesn’t wait for import', async () => {
    const organizer = {
      forgetDeletedFiles: jest.fn().mockResolvedValue(undefined),
    };
    const withWhisparr = new LocalLibraryService(
      playback as unknown as PlaybackService,
      {
        ...stash,
        getOrganizerScene: jest
          .fn()
          .mockResolvedValue({ files: [{ path: '/data/a/a.mp4' }] }),
        deleteScene: jest.fn().mockResolvedValue(undefined),
      } as unknown as StashAdapter,
      organizer as unknown as OrganizerService,
    );

    await withWhisparr.deleteScene('5', true);
    await withWhisparr.deleteScene('6', false);

    expect(organizer.forgetDeletedFiles).toHaveBeenCalledTimes(1);
    expect(organizer.forgetDeletedFiles).toHaveBeenCalledWith([
      '/data/a/a.mp4',
    ]);
  });

  it('picks the best copy among duplicates', () => {
    const scene = (
      id: string,
      width: number,
      height: number,
      bitRate: number,
    ) => ({
      id,
      title: id,
      date: null,
      screenshotVersion: null,
      studio: null,
      playCount: 0,
      organized: false,
      fileCount: 1,
      file: {
        path: null,
        basename: null,
        size: 1,
        width,
        height,
        duration: 1,
        videoCodec: null,
        bitRate,
        frameRate: null,
      },
    });
    expect(
      pickKeeper([
        scene('a', 1280, 720, 9),
        scene('b', 1920, 1080, 2),
        scene('c', 1920, 1080, 4),
      ]),
    ).toBe('c');
  });

  it('keeps an HEVC copy over a bigger H.264 one, and says why', () => {
    const copy = (
      id: string,
      videoCodec: string,
      bitRate: number,
      playCount = 0,
    ) => ({
      id,
      title: id,
      date: null,
      screenshotVersion: null,
      studio: null,
      playCount,
      organized: false,
      fileCount: 1,
      file: {
        path: null,
        basename: null,
        size: 1,
        width: 1920,
        height: 1080,
        duration: 1800,
        videoCodec,
        bitRate,
        frameRate: null,
      },
    });
    expect(
      pickKeeperWithReason([
        copy('h264', 'h264', 8e6),
        copy('hevc', 'hevc', 6e6),
      ]),
    ).toEqual({
      id: 'hevc',
      reason: 'Same resolution, and HEVC keeps more picture than H264.',
    });
    // Within 5% counts as the same; then the one you've played wins.
    expect(
      pickKeeperWithReason([
        copy('a', 'h264', 8e6),
        copy('b', 'h264', 8.2e6, 3),
      ]),
    ).toEqual({ id: 'b', reason: 'Same quality, and the one you’ve played.' });
    // Near the 5% line the pick doesn't depend on the order of the copies,
    // even when pairs would beat each other in a circle.
    const near = [copy('x', 'h264', 100), copy('y', 'h264', 105.2)];
    expect(pickKeeperWithReason(near).id).toBe(
      pickKeeperWithReason([...near].reverse()).id,
    );
    const long = (id: string, rate: number, duration: number) => ({
      ...copy(id, 'h264', rate),
      file: { ...copy(id, 'h264', rate).file, duration },
    });
    const a = long('a', 100, 300);
    const b = long('b', 104, 200);
    const c = long('c', 108, 100);
    const orders = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    const picks = new Set(
      orders.map((order) => pickKeeperWithReason(order).id),
    );
    // Only b and c are within 5% of the best (108); b is the longer of them.
    expect([...picks]).toEqual(['b']);
  });

  it('counts the fix-my-library lists, treating a failing list as zero', async () => {
    stash.findLocalScenes.mockImplementation(
      (_config, options: { sceneFilter: Record<string, unknown> }) =>
        options.sceneFilter['organized'] === false
          ? Promise.reject(new Error('nope'))
          : Promise.resolve({
              total: options.sceneFilter['is_missing'] === 'tags' ? 4 : 7,
              items: [],
            }),
    );

    await expect(service.fixCounts()).resolves.toEqual({
      unmatched: 7,
      untagged: 4,
      unorganized: 0,
    });
  });

  it('shuffles the whole library for the feed with a stable seed', async () => {
    stash.findLocalScenes.mockResolvedValue({ total: 0, items: [] });
    await service.feed(3, 77);
    expect(stash.findLocalScenes).toHaveBeenCalledWith(config, {
      page: 3,
      perPage: 24,
      sort: 'random_77',
      direction: 'ASC',
      sceneFilter: {},
    });
  });
});
