import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { MediaCacheService } from './media-cache.service';
import { MediaService } from './media.service';

describe('MediaService', () => {
  const integrationFindUniqueMock = jest.fn();
  const openSceneScreenshotMock = jest.fn();
  const openStudioLogoMock = jest.fn();

  const prismaService = {
    integrationConfig: {
      findUnique: integrationFindUniqueMock,
    },
  } as unknown as PrismaService;

  const stashAdapter = {
    openSceneScreenshot: openSceneScreenshotMock,
    openStudioLogo: openStudioLogoMock,
  } as unknown as StashAdapter;

  let service: MediaService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MediaService(prismaService, stashAdapter);
  });

  it('returns a proxied scene screenshot using stash integration credentials', async () => {
    const body = Buffer.from([1, 2, 3]);

    integrationFindUniqueMock.mockResolvedValue({
      type: 'STASH',
      enabled: true,
      status: 'CONFIGURED',
      baseUrl: 'http://stash.local',
      apiKey: 'secret',
    });
    openSceneScreenshotMock.mockResolvedValue({
      body,
      contentType: 'image/jpeg',
      contentLength: '128',
      cacheControl: 'public, max-age=300',
    });

    const result = await service.getStashSceneScreenshot('411');

    expect(integrationFindUniqueMock).toHaveBeenCalledWith({
      where: { type: 'STASH' },
    });
    expect(openSceneScreenshotMock).toHaveBeenCalledWith('411', {
      baseUrl: 'http://stash.local',
      apiKey: 'secret',
    });
    expect(result).toEqual({
      body,
      contentType: 'image/jpeg',
      contentLength: '128',
      cacheControl: 'public, max-age=300',
    });
  });

  it('returns a proxied studio logo using stash integration credentials', async () => {
    const body = Buffer.from([4, 5, 6]);

    integrationFindUniqueMock.mockResolvedValue({
      type: 'STASH',
      enabled: true,
      status: 'CONFIGURED',
      baseUrl: 'http://stash.local/base',
      apiKey: null,
    });
    openStudioLogoMock.mockResolvedValue({
      body,
      contentType: 'image/png',
      contentLength: null,
      cacheControl: null,
    });

    const result = await service.getStashStudioLogo('studio-1');

    expect(openStudioLogoMock).toHaveBeenCalledWith('studio-1', {
      baseUrl: 'http://stash.local/base',
      apiKey: null,
    });
    expect(result.contentType).toBe('image/png');
  });

  it('throws not found when stash returns no matching media asset', async () => {
    integrationFindUniqueMock.mockResolvedValue({
      type: 'STASH',
      enabled: true,
      status: 'CONFIGURED',
      baseUrl: 'http://stash.local',
      apiKey: 'secret',
    });
    openSceneScreenshotMock.mockResolvedValue(null);

    await expect(service.getStashSceneScreenshot('411')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws service unavailable when stash is not configured', async () => {
    integrationFindUniqueMock.mockResolvedValue(null);

    await expect(service.getStashStudioLogo('studio-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(openStudioLogoMock).not.toHaveBeenCalled();
  });

  it('serves a resized WebP thumbnail when a width is requested', async () => {
    const body = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: '#224' },
    })
      .jpeg()
      .toBuffer();

    integrationFindUniqueMock.mockResolvedValue({
      type: 'STASH',
      enabled: true,
      status: 'CONFIGURED',
      baseUrl: 'http://stash.local',
      apiKey: null,
    });
    openSceneScreenshotMock.mockResolvedValue({
      body,
      contentType: 'image/jpeg',
      contentLength: String(body.byteLength),
      cacheControl: null,
    });

    const result = await service.getStashSceneScreenshot('411', 480);

    expect(result.contentType).toBe('image/webp');
    expect((await sharp(result.body).metadata()).width).toBe(480);
    expect(result.body.byteLength).toBeLessThan(body.byteLength);
  });

  it('fetches a cover again as soon as its version changes, despite the cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stashboard-media-version-'));
    const previous = process.env.MEDIA_CACHE_DIR;
    process.env.MEDIA_CACHE_DIR = dir;
    try {
      const cached = new MediaService(
        prismaService,
        stashAdapter,
        new MediaCacheService(),
      );
      integrationFindUniqueMock.mockResolvedValue({
        type: 'STASH',
        enabled: true,
        status: 'CONFIGURED',
        baseUrl: 'http://stash.local',
        apiKey: null,
      });
      openSceneScreenshotMock
        .mockResolvedValueOnce({
          body: Buffer.from('old'),
          contentType: 'image/jpeg',
        })
        .mockResolvedValueOnce({
          body: Buffer.from('new'),
          contentType: 'image/jpeg',
        });

      const first = await cached.getStashSceneScreenshot('411', null, '100');
      const again = await cached.getStashSceneScreenshot('411', null, '100');
      const updated = await cached.getStashSceneScreenshot('411', null, '200');

      expect(first.body.toString()).toBe('old');
      expect(again.body.toString()).toBe('old');
      expect(updated.body.toString()).toBe('new');
      expect(openSceneScreenshotMock).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) {
        delete process.env.MEDIA_CACHE_DIR;
      } else {
        process.env.MEDIA_CACHE_DIR = previous;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
