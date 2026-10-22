import {
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  StashAdapter,
  type StashProtectedAssetResponse,
} from '../providers/stash/stash.adapter';
import { PrismaService } from '../prisma/prisma.service';
import { MediaCacheService } from './media-cache.service';
import { resizeToWebp } from './image-resize.util';

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stashAdapter: StashAdapter,
    @Optional() private readonly mediaCache?: MediaCacheService,
  ) {}

  async getStashSceneScreenshot(
    sceneId: string,
    width: number | null = null,
    version: string | null = null,
  ): Promise<StashProtectedAssetResponse> {
    const config = await this.getStashConfig();
    const id = versioned(sceneId, version);
    const loadOriginal = () =>
      this.withCache(config, 'scene-screenshot', id, () =>
        this.stashAdapter.openSceneScreenshot(sceneId, config),
      );

    const asset = width
      ? await this.withCache(
          config,
          `scene-screenshot-w${width}`,
          id,
          async () => {
            const original = await loadOriginal();
            if (!original) {
              return null;
            }
            const resized = await resizeToWebp(original.body, width);
            return resized
              ? {
                  ...original,
                  body: resized.body,
                  contentType: resized.contentType,
                }
              : original;
          },
        )
      : await loadOriginal();
    if (!asset) {
      throw new NotFoundException('Stash media asset not found.');
    }

    return asset;
  }

  async getStashStudioLogo(
    studioId: string,
    version: string | null = null,
  ): Promise<StashProtectedAssetResponse> {
    const config = await this.getStashConfig();
    const asset = await this.withCache(
      config,
      'studio-logo',
      versioned(studioId, version),
      () => this.stashAdapter.openStudioLogo(studioId, config),
    );
    if (!asset) {
      throw new NotFoundException('Stash media asset not found.');
    }

    return asset;
  }

  async getStashPerformerImage(
    performerId: string,
    width: number | null = null,
    version: string | null = null,
  ): Promise<StashProtectedAssetResponse> {
    const config = await this.getStashConfig();
    const id = versioned(performerId, version);
    const loadOriginal = () =>
      this.withCache(config, 'performer-image', id, () =>
        this.stashAdapter.openPerformerImage(performerId, config),
      );

    const asset = width
      ? await this.withCache(
          config,
          `performer-image-w${width}`,
          id,
          async () => {
            const original = await loadOriginal();
            if (!original) {
              return null;
            }
            const resized = await resizeToWebp(original.body, width);
            return resized
              ? {
                  ...original,
                  body: resized.body,
                  contentType: resized.contentType,
                }
              : original;
          },
        )
      : await loadOriginal();
    if (!asset) {
      throw new NotFoundException('Stash media asset not found.');
    }

    return asset;
  }

  async getStashMarkerScreenshot(
    sceneId: string,
    markerId: string,
  ): Promise<StashProtectedAssetResponse> {
    const config = await this.getStashConfig();
    const asset = await this.withCache(
      config,
      'marker-screenshot',
      `${sceneId}/${markerId}`,
      () =>
        this.stashAdapter.openSceneMarkerScreenshot(config, sceneId, markerId),
    );
    if (!asset) {
      throw new NotFoundException('Stash media asset not found.');
    }

    return asset;
  }

  private async withCache(
    config: { baseUrl: string },
    kind: string,
    id: string,
    load: () => Promise<StashProtectedAssetResponse | null>,
  ): Promise<StashProtectedAssetResponse | null> {
    if (!this.mediaCache) {
      return load();
    }

    // The Stash address is part of the key, so pointing Stashboard at a different
    // Stash server never serves the old server's images.
    const cached = await this.mediaCache.getOrLoad(
      `stash|${config.baseUrl}|${kind}`,
      id,
      load,
    );
    if (!cached) {
      return null;
    }

    return {
      body: cached.body,
      contentType: cached.contentType,
      contentLength: String(cached.body.byteLength),
      cacheControl: null,
    };
  }

  private async getStashConfig(): Promise<{
    baseUrl: string;
    apiKey?: string | null;
  }> {
    const integration = await this.prisma.integrationConfig.findUnique({
      where: { type: 'STASH' },
    });
    const baseUrl = integration?.baseUrl?.trim();

    if (
      !integration ||
      !integration.enabled ||
      integration.status !== 'CONFIGURED' ||
      !baseUrl
    ) {
      throw new ServiceUnavailableException('Stash media is unavailable.');
    }

    return {
      baseUrl,
      apiKey: integration.apiKey,
    };
  }
}

/**
 * A new picture version is a new cache entry, so an updated cover is fetched
 * from Stash at once instead of after the cache's day is up.
 */
function versioned(id: string, version: string | null): string {
  return version ? `${id}@${version}` : id;
}
