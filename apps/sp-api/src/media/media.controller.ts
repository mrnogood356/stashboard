import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { normalizeThumbnailWidth } from './image-resize.util';
import { MediaService } from './media.service';

@Controller('api/media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get('stash/scenes/:sceneId/screenshot')
  async getStashSceneScreenshot(
    @Param('sceneId') sceneId: string,
    @Query('w') width: string | undefined,
    @Query('v') version: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const imageVersion = normalizeImageVersion(version);
    const asset = await this.mediaService.getStashSceneScreenshot(
      sceneId,
      normalizeThumbnailWidth(width),
      imageVersion,
    );
    this.writeAssetResponse(asset, response, imageVersion);
  }

  @Get('stash/scenes/:sceneId/markers/:markerId/screenshot')
  async getStashMarkerScreenshot(
    @Param('sceneId') sceneId: string,
    @Param('markerId') markerId: string,
    @Res() response: Response,
  ): Promise<void> {
    const asset = await this.mediaService.getStashMarkerScreenshot(
      sceneId,
      markerId,
    );
    this.writeAssetResponse(asset, response);
  }

  @Get('stash/studios/:studioId/logo')
  async getStashStudioLogo(
    @Param('studioId') studioId: string,
    @Query('v') version: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const imageVersion = normalizeImageVersion(version);
    const asset = await this.mediaService.getStashStudioLogo(
      studioId,
      imageVersion,
    );
    this.writeAssetResponse(asset, response, imageVersion);
  }

  @Get('stash/performers/:performerId/image')
  async getStashPerformerImage(
    @Param('performerId') performerId: string,
    @Query('w') width: string | undefined,
    @Query('v') version: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const imageVersion = normalizeImageVersion(version);
    const asset = await this.mediaService.getStashPerformerImage(
      performerId,
      normalizeThumbnailWidth(width),
      imageVersion,
    );
    this.writeAssetResponse(asset, response, imageVersion);
  }

  private writeAssetResponse(
    asset: Awaited<ReturnType<MediaService['getStashSceneScreenshot']>>,
    response: Response,
    version: string | null = null,
  ): void {
    response.setHeader(
      'Content-Type',
      asset.contentType ?? 'application/octet-stream',
    );
    response.setHeader(
      'Content-Length',
      asset.contentLength ?? String(asset.body.byteLength),
    );
    // Images sit behind the admin login, so only the viewer's own browser may
    // keep them. A versioned address changes whenever the picture does, so that
    // copy can be kept for good; an unversioned one for a day.
    response.setHeader(
      'Cache-Control',
      version
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=86400',
    );
    response.status(200).end(asset.body);
  }
}

/** The ?v= an image URL carries (see stashMediaUrl); anything odd is ignored. */
export function normalizeImageVersion(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,40}$/.test(value)
    ? value
    : null;
}
