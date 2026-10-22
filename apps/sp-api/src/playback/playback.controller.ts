import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { Public } from '../auth/decorators/public.decorator';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { PlaybackActivityDto } from './dto/playback-activity.dto';
import { RequiresPlayback } from './playback-feature.guard';
import { PlaybackTokenService } from './playback-token.service';
import {
  LocalSceneDetailsDto,
  PLAYBACK_STREAM_ROUTE,
  PlaybackInfoDto,
  PlaybackService,
} from './playback.service';
import { filterStreamQuery, parseStashStreamPath } from './stash-stream.util';

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
];
/** How long to wait for Stash to start answering; transcodes can take a while to start. */
const STREAM_START_TIMEOUT_MS = 60_000;

@Controller('api/playback')
export class PlaybackController {
  private readonly logger = new Logger(PlaybackController.name);

  constructor(
    private readonly playbackService: PlaybackService,
    private readonly stashAdapter: StashAdapter,
    private readonly tokens: PlaybackTokenService,
  ) {}

  @RequiresPlayback()
  @Get('scenes/:sceneId')
  getPlaybackInfo(@Param('sceneId') sceneId: string): Promise<PlaybackInfoDto> {
    return this.playbackService.getPlaybackInfo(sceneId);
  }

  @Get('scenes/:sceneId/details')
  getSceneDetails(
    @Param('sceneId') sceneId: string,
  ): Promise<LocalSceneDetailsDto> {
    return this.playbackService.getSceneDetails(sceneId);
  }

  @RequiresPlayback()
  @Post('scenes/:sceneId/activity')
  @HttpCode(204)
  async saveActivity(
    @Param('sceneId') sceneId: string,
    @Body() body: PlaybackActivityDto,
  ): Promise<void> {
    await this.playbackService.saveActivity(
      sceneId,
      body.resumeTime,
      body.playDuration,
    );
  }

  @RequiresPlayback()
  @Post('scenes/:sceneId/play')
  @HttpCode(204)
  async addPlay(@Param('sceneId') sceneId: string): Promise<void> {
    await this.playbackService.addPlay(sceneId);
  }

  /**
   * Streams a scene from Stash. Authorised by the signed token in the path
   * (scoped to one scene, expiring), so video players, HLS segments and TVs
   * that can't send the login cookie still work. Refused while playback is
   * turned off, even with a valid link.
   */
  @Public()
  @RequiresPlayback()
  @Get('stream/:token/scene/*path')
  async stream(
    @Param('token') token: string,
    @Param('path') pathParam: string | string[],
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const grant = this.tokens.verify(token);
    if (!grant) {
      throw new ForbiddenException(
        'This playback link has expired. Reopen the player.',
      );
    }

    const path = Array.isArray(pathParam) ? pathParam.join('/') : pathParam;
    const target = parseStashStreamPath(path);
    if (!target) {
      throw new NotFoundException();
    }
    const allowed =
      target.kind === 'scene'
        ? target.sceneId === grant.sceneId
        : target.hash === grant.hash;
    if (!allowed) {
      throw new ForbiddenException(
        'This playback link is for a different scene.',
      );
    }

    // Stash writes this prefix into HLS segment URLs, so segments come back here.
    await this.proxyToStash(
      target.rest,
      `${PLAYBACK_STREAM_ROUTE}/${token}`,
      request,
      response,
    );
  }

  /**
   * The short preview clip Stash makes for each scene (for card previews and
   * the swipe feed). Uses the login cookie, so no token is needed.
   */
  @RequiresPlayback('preview')
  @Get('scenes/:sceneId/preview')
  async preview(
    @Param('sceneId') sceneId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!/^\d+$/.test(sceneId)) {
      throw new NotFoundException();
    }
    await this.proxyToStash(`${sceneId}/preview`, undefined, request, response);
  }

  private async proxyToStash(
    rest: string,
    forwardedPrefix: string | undefined,
    request: Request,
    response: Response,
  ): Promise<void> {
    const config = await this.playbackService.getStashConfig();
    const controller = new AbortController();
    const startTimer = setTimeout(
      () => controller.abort(),
      STREAM_START_TIMEOUT_MS,
    );
    response.on('close', () => controller.abort());

    let upstream: globalThis.Response;
    try {
      upstream = await this.stashAdapter.openSceneStream(
        config,
        rest,
        filterStreamQuery(request.query),
        {
          range:
            typeof request.headers.range === 'string'
              ? request.headers.range
              : undefined,
          forwardedPrefix,
        },
        controller.signal,
      );
    } catch (error) {
      clearTimeout(startTimer);
      if (controller.signal.aborted && response.writableEnded) {
        return;
      }
      this.logger.warn(
        `Stash stream failed to start: ${(error as Error).message}`,
      );
      response
        .status(502)
        .json({ message: 'Stash did not respond to the stream request.' });
      return;
    }
    clearTimeout(startTimer);

    if (upstream.status >= 300 && upstream.status < 400) {
      response
        .status(502)
        .json({ message: 'Stash redirected the stream; check the Stash URL.' });
      return;
    }

    response.status(upstream.status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) {
        response.setHeader(name, value);
      }
    }
    // Segments and files never change for a given URL; the token keeps it
    // private. An error isn't kept, or a failed segment would stay failed.
    response.setHeader(
      'Cache-Control',
      upstream.status === 200 || upstream.status === 206
        ? 'private, max-age=3600'
        : 'no-store',
    );

    if (!upstream.body) {
      response.end();
      return;
    }

    const body = Readable.fromWeb(
      upstream.body as import('node:stream/web').ReadableStream,
    );
    body.on('error', () => response.destroy());
    body.pipe(response);
  }
}
