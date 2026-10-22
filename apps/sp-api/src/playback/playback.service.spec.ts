import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { PlaybackTokenService } from './playback-token.service';
import { PlaybackService } from './playback.service';

describe('PlaybackService', () => {
  const findUnique = jest.fn();
  const getScenePlayback = jest.fn();
  const saveSceneActivity = jest.fn();
  const addScenePlay = jest.fn();
  const getLocalSceneDetails = jest.fn();
  const indexFindUnique = jest.fn();
  const tokens = new PlaybackTokenService();
  const service = new PlaybackService(
    {
      integrationConfig: { findUnique },
      librarySceneIndex: { findUnique: indexFindUnique },
    } as unknown as PrismaService,
    {
      getScenePlayback,
      saveSceneActivity,
      addScenePlay,
      getLocalSceneDetails,
    } as unknown as StashAdapter,
    tokens,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue({
      type: 'STASH',
      enabled: true,
      status: 'CONFIGURED',
      baseUrl: 'http://stash.local',
      apiKey: 'k',
    });
  });

  it('builds tokened sources and scrub-preview links for the player', async () => {
    getScenePlayback.mockResolvedValue({
      id: '12',
      title: 'Scene',
      studio: 'Studio',
      resumeTime: 95,
      playCount: 2,
      duration: 1800,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      vttPath: 'http://stash.local/scene/abcdef0123456789_thumbs.vtt',
      screenshotVersion: '1',
      streams: [
        {
          url: 'http://stash.local/scene/12/stream',
          label: 'Direct stream',
          mime_type: 'video/mp4',
        },
        {
          url: 'http://stash.local/scene/12/stream.m3u8?resolution=STANDARD_HD',
          label: 'HLS HD (720p)',
        },
      ],
      viewUrl: 'http://stash.local/scenes/12',
    });

    const info = await service.getPlaybackInfo('12');
    const token = /\/api\/playback\/stream\/([^/]+)\/scene\//.exec(
      info.sources[0].url,
    )![1];

    expect(tokens.verify(token)).toEqual(
      expect.objectContaining({ sceneId: '12', hash: 'abcdef0123456789' }),
    );
    expect(info).toEqual(
      expect.objectContaining({
        sceneId: '12',
        resumeTime: 95,
        posterUrl: '/api/media/stash/scenes/12/screenshot?v=1',
        thumbnailsVttUrl: `/api/playback/stream/${token}/scene/abcdef0123456789_thumbs.vtt`,
      }),
    );
    expect(info.sources.map((source) => [source.kind, source.url])).toEqual([
      ['direct', `/api/playback/stream/${token}/scene/12/stream`],
      [
        'hls',
        `/api/playback/stream/${token}/scene/12/stream.m3u8?resolution=STANDARD_HD`,
      ],
    ]);
  });

  it('explains when the scene is not in Stash or Stash is not set up', async () => {
    getScenePlayback.mockResolvedValue(null);
    await expect(service.getPlaybackInfo('404')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    findUnique.mockResolvedValue(null);
    await expect(service.getPlaybackInfo('12')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('saves progress and plays to Stash, never sending negative values', async () => {
    await service.saveActivity('12', -5, 12.5);
    expect(saveSceneActivity).toHaveBeenCalledWith(
      expect.anything(),
      '12',
      0,
      12.5,
    );

    await service.addPlay('12');
    expect(addScenePlay).toHaveBeenCalledWith(expect.anything(), '12');
  });

  describe('getSceneDetails', () => {
    const details = {
      id: '12',
      title: 'Scene',
      code: null,
      details: 'About it',
      date: '2026-01-02',
      rating100: 80,
      oCounter: 1,
      playCount: 3,
      resumeTime: 61,
      organized: true,
      screenshotVersion: '1',
      studio: { id: '5', name: 'Studio', imageVersion: '1' },
      performers: [
        {
          id: '7',
          name: 'Ana',
          gender: 'FEMALE',
          favorite: true,
          imageVersion: '1',
        },
        {
          id: '8',
          name: 'Bo',
          gender: null,
          favorite: false,
          imageVersion: null,
        },
      ],
      tags: [{ id: '9', name: 'Tag' }],
      files: [
        {
          basename: 'a.mp4',
          size: 1000,
          duration: 1800,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
          container: 'mp4',
          frameRate: 30,
          bitRate: 5000000,
        },
      ],
      viewUrl: 'http://stash.local/scenes/12',
    };

    it('returns proxied image links and the linked catalog scene', async () => {
      getLocalSceneDetails.mockResolvedValue(details);
      indexFindUnique.mockResolvedValue({ linkedStashId: 'cat-1' });

      const result = await service.getSceneDetails('12');

      expect(result).toEqual(
        expect.objectContaining({
          id: '12',
          duration: 1800,
          imageUrl: '/api/media/stash/scenes/12/screenshot?v=1',
          studio: {
            id: '5',
            name: 'Studio',
            imageUrl: '/api/media/stash/studios/5/logo?v=1',
          },
          catalogSceneId: 'cat-1',
          resumeTime: 61,
        }),
      );
      expect(result.performers.map((performer) => performer.imageUrl)).toEqual([
        '/api/media/stash/performers/7/image?v=1&w=320',
        null,
      ]);
    });

    it('still works when the scene is not indexed yet', async () => {
      getLocalSceneDetails.mockResolvedValue(details);
      indexFindUnique.mockResolvedValue(null);

      await expect(service.getSceneDetails('12')).resolves.toEqual(
        expect.objectContaining({ catalogSceneId: null }),
      );
    });

    it('reports a missing scene', async () => {
      getLocalSceneDetails.mockResolvedValue(null);
      indexFindUnique.mockResolvedValue(null);

      await expect(service.getSceneDetails('404')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
