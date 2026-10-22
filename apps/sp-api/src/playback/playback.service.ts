import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { stashMediaUrl } from '../media/media-url.util';
import { PlaybackTokenService } from './playback-token.service';
import {
  hashFromVttPath,
  toStreamSources,
  type StreamSource,
} from './stash-stream.util';

export const PLAYBACK_STREAM_ROUTE = '/api/playback/stream';

export interface PlaybackSourceDto {
  kind: StreamSource['kind'];
  label: string;
  mimeType: string;
  resolution: string | null;
  url: string;
}

export interface PlaybackInfoDto {
  sceneId: string;
  title: string;
  studio: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  resumeTime: number;
  playCount: number;
  posterUrl: string | null;
  thumbnailsVttUrl: string | null;
  sources: PlaybackSourceDto[];
  markers: SceneMarkerDto[];
  viewUrl: string;
  expiresAt: number;
}

export interface SceneMarkerDto {
  id: string;
  title: string;
  seconds: number;
  imageUrl: string;
}

export interface LocalSceneFileDto {
  basename: string | null;
  size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  frameRate: number | null;
  bitRate: number | null;
}

export interface LocalSceneDetailsDto {
  id: string;
  title: string;
  code: string | null;
  details: string | null;
  date: string | null;
  rating100: number | null;
  oCounter: number;
  playCount: number;
  resumeTime: number;
  duration: number | null;
  organized: boolean;
  imageUrl: string | null;
  studio: { id: string; name: string; imageUrl: string | null } | null;
  performers: Array<{
    id: string;
    name: string;
    gender: string | null;
    favorite: boolean;
    imageUrl: string | null;
  }>;
  tags: Array<{ id: string; name: string }>;
  /** Chapters from Stash scene markers. */
  markers: SceneMarkerDto[];
  files: LocalSceneFileDto[];
  /** StashDB/FansDB scene this copy is linked to, for the catalog scene page. */
  catalogSceneId: string | null;
  viewUrl: string;
}

@Injectable()
export class PlaybackService {
  private readonly logger = new Logger(PlaybackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stashAdapter: StashAdapter,
    private readonly tokens: PlaybackTokenService,
  ) {}

  async getPlaybackInfo(sceneId: string): Promise<PlaybackInfoDto> {
    const config = await this.getStashConfig();
    const scene = await this.stashAdapter.getScenePlayback(config, sceneId);
    if (!scene) {
      throw new NotFoundException('That scene is not in your Stash library.');
    }

    this.logger.log(
      `Playing “${scene.title ?? `Stash scene ${scene.id}`}” (Stash scene ${scene.id}).`,
    );
    const hash = hashFromVttPath(scene.vttPath);
    const { token, expiresAt } = this.tokens.issue(scene.id, hash);
    const prefix = `${PLAYBACK_STREAM_ROUTE}/${token}/scene`;

    return {
      sceneId: scene.id,
      title: scene.title,
      studio: scene.studio,
      duration: scene.duration,
      width: scene.width,
      height: scene.height,
      videoCodec: scene.videoCodec,
      audioCodec: scene.audioCodec,
      container: scene.container,
      resumeTime: scene.resumeTime,
      playCount: scene.playCount,
      posterUrl: scene.screenshotVersion
        ? stashMediaUrl(
            `scenes/${encodeURIComponent(scene.id)}/screenshot`,
            scene.screenshotVersion,
          )
        : null,
      thumbnailsVttUrl: hash ? `${prefix}/${hash}_thumbs.vtt` : null,
      sources: toStreamSources(scene.id, scene.streams).map((source) => ({
        kind: source.kind,
        label: source.label,
        mimeType: source.mimeType,
        resolution: source.resolution,
        url: `${prefix}/${source.stashPath}`,
      })),
      markers: toMarkerDtos(scene.id, scene.markers ?? []),
      viewUrl: scene.viewUrl,
      expiresAt,
    };
  }

  /** Details for the local scene page: what's in Stash, before pressing Play. */
  async getSceneDetails(sceneId: string): Promise<LocalSceneDetailsDto> {
    const config = await this.getStashConfig();
    const [scene, indexRow] = await Promise.all([
      this.stashAdapter.getLocalSceneDetails(config, sceneId),
      this.prisma.librarySceneIndex
        .findUnique({
          where: { stashSceneId: sceneId },
          select: { linkedStashId: true },
        })
        .catch((error: unknown) => {
          this.logger.debug(
            `Couldn't read the library index for scene ${sceneId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }),
    ]);
    if (!scene) {
      throw new NotFoundException('That scene is not in your Stash library.');
    }

    return {
      id: scene.id,
      title: scene.title,
      code: scene.code,
      details: scene.details,
      date: scene.date,
      rating100: scene.rating100,
      oCounter: scene.oCounter,
      playCount: scene.playCount,
      resumeTime: scene.resumeTime,
      duration: scene.files[0]?.duration ?? null,
      organized: scene.organized,
      imageUrl: scene.screenshotVersion
        ? stashMediaUrl(
            `scenes/${encodeURIComponent(scene.id)}/screenshot`,
            scene.screenshotVersion,
          )
        : null,
      studio: scene.studio
        ? {
            id: scene.studio.id,
            name: scene.studio.name,
            imageUrl: scene.studio.imageVersion
              ? stashMediaUrl(
                  `studios/${encodeURIComponent(scene.studio.id)}/logo`,
                  scene.studio.imageVersion,
                )
              : null,
          }
        : null,
      performers: scene.performers.map((performer) => ({
        id: performer.id,
        name: performer.name,
        gender: performer.gender,
        favorite: performer.favorite,
        imageUrl: performer.imageVersion
          ? stashMediaUrl(
              `performers/${encodeURIComponent(performer.id)}/image`,
              performer.imageVersion,
              320,
            )
          : null,
      })),
      tags: scene.tags,
      markers: toMarkerDtos(scene.id, scene.markers ?? []),
      files: scene.files,
      catalogSceneId: indexRow?.linkedStashId ?? null,
      viewUrl: scene.viewUrl,
    };
  }

  async saveActivity(
    sceneId: string,
    resumeTime: number,
    playDuration: number,
  ): Promise<void> {
    const config = await this.getStashConfig();
    await this.stashAdapter.saveSceneActivity(
      config,
      sceneId,
      Math.max(0, resumeTime),
      Math.max(0, playDuration),
    );
  }

  async addPlay(sceneId: string): Promise<void> {
    const config = await this.getStashConfig();
    await this.stashAdapter.addScenePlay(config, sceneId);
  }

  async getStashConfig(): Promise<{ baseUrl: string; apiKey?: string | null }> {
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
      this.logger.warn('Stash is not set up, so playback was refused.');
      throw new ServiceUnavailableException(
        'Stash is not available for playback.',
      );
    }

    return { baseUrl, apiKey: integration.apiKey };
  }
}

function toMarkerDtos(
  sceneId: string,
  markers: Array<{ id: string; title: string; seconds: number }>,
): SceneMarkerDto[] {
  return markers.map((marker) => ({
    id: marker.id,
    title: marker.title,
    seconds: marker.seconds,
    imageUrl: `/api/media/stash/scenes/${encodeURIComponent(sceneId)}/markers/${encodeURIComponent(marker.id)}/screenshot`,
  }));
}
