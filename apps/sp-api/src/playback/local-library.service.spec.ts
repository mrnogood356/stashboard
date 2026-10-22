import { NotFoundException } from '@nestjs/common';
import type {
  StashAdapter,
  StashLocalSceneCard,
} from '../providers/stash/stash.adapter';
import {
  isSamplePath,
  LocalLibraryService,
  pickKeeper,
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
  };
  const service = new LocalLibraryService(
    playback as unknown as PlaybackService,
    stash as unknown as StashAdapter,
  );

  beforeEach(() => jest.clearAllMocks());

  it('finds related scenes by performers, then studio, then tags, unwatched first', async () => {
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

    // Itself is excluded, duplicates removed, a failing query is ignored,
    // and the watched scene 2 moves after the unwatched ones.
    expect(related.map((item) => item.id)).toEqual(['3', '4', '2']);
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
    expect(toCard({ ...card('5'), resumeTime: 25 })).toEqual(
      expect.objectContaining({
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
      scene('2', '/data/Studio.Title.1080p/Samples/clip.mp4', 900),
      scene('3', '/data/Examples/trailer.mp4', 45),
      // Stash matched "sample" inside a word; not a sample.
      scene('4', '/data/Resampled Studio/scene.mp4', 1800),
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
