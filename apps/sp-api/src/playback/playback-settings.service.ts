import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type PlaybackFeature,
  type PlaybackSettingsResponse,
  UpdatePlaybackSettingsDto,
} from './dto/playback-settings.dto';

const KEY = 'GLOBAL';

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettingsResponse = {
  enabled: true,
  feedEnabled: true,
  previewsEnabled: true,
  updatedAt: null,
};

/**
 * Settings → Playback: whether Stashboard's own player, swipe feed and card
 * previews are offered, for installs that only want the request and
 * download side. Kept in memory once read, since every video segment asks.
 */
@Injectable()
export class PlaybackSettingsService {
  private readonly logger = new Logger('PlaybackSettings');
  private cached: PlaybackSettingsResponse | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<PlaybackSettingsResponse> {
    if (this.cached) {
      return { ...this.cached };
    }
    const row = await this.prisma.playbackSettings.findUnique({
      where: { key: KEY },
    });
    this.cached = row
      ? {
          enabled: row.enabled,
          feedEnabled: row.feedEnabled,
          previewsEnabled: row.previewsEnabled,
          updatedAt: row.updatedAt.toISOString(),
        }
      : { ...DEFAULT_PLAYBACK_SETTINGS };
    return { ...this.cached };
  }

  async update(
    body: UpdatePlaybackSettingsDto,
  ): Promise<PlaybackSettingsResponse> {
    const before = await this.get();
    const data = {
      enabled: body.enabled,
      feedEnabled: body.feedEnabled,
      previewsEnabled: body.previewsEnabled,
    };
    const row = await this.prisma.playbackSettings.upsert({
      where: { key: KEY },
      create: { key: KEY, ...data },
      update: data,
    });
    this.cached = {
      enabled: row.enabled,
      feedEnabled: row.feedEnabled,
      previewsEnabled: row.previewsEnabled,
      updatedAt: row.updatedAt.toISOString(),
    };
    const changes = (['enabled', 'feedEnabled', 'previewsEnabled'] as const)
      .filter((field) => before[field] !== this.cached?.[field])
      .map((field) => `${LABELS[field]} ${data[field] ? 'on' : 'off'}`);
    this.logger.log(
      changes.length > 0
        ? `Playback settings changed: ${changes.join(', ')}`
        : 'Playback settings saved (no change)',
    );
    return { ...this.cached };
  }

  /** Whether an endpoint's feature is turned on right now. */
  async allows(feature: PlaybackFeature): Promise<boolean> {
    return allowsFeature(await this.get(), feature);
  }
}

const LABELS = {
  enabled: 'playback',
  feedEnabled: 'feed',
  previewsEnabled: 'card previews',
} as const;

/**
 * Playback off turns everything off. Preview clips are what the feed shows,
 * so they stay available while either the feed or card previews is on.
 */
export function allowsFeature(
  settings: Pick<
    PlaybackSettingsResponse,
    'enabled' | 'feedEnabled' | 'previewsEnabled'
  >,
  feature: PlaybackFeature,
): boolean {
  if (!settings.enabled) {
    return false;
  }
  switch (feature) {
    case 'playback':
      return true;
    case 'feed':
      return settings.feedEnabled;
    case 'preview':
      return settings.feedEnabled || settings.previewsEnabled;
  }
}
