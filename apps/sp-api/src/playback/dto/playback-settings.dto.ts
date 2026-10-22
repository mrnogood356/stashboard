import { IsBoolean } from 'class-validator';

/** Settings → Playback, as saved. */
export class UpdatePlaybackSettingsDto {
  /** The Watch page, Play buttons and streaming from Stash. Off turns all playback off. */
  @IsBoolean()
  enabled!: boolean;

  /** The swipe feed of preview clips. Only applies while playback is on. */
  @IsBoolean()
  feedEnabled!: boolean;

  /** Preview clips on scene cards. Only applies while playback is on. */
  @IsBoolean()
  previewsEnabled!: boolean;
}

export interface PlaybackSettingsResponse {
  enabled: boolean;
  feedEnabled: boolean;
  previewsEnabled: boolean;
  /** Null until saved; everything is on until then. */
  updatedAt: string | null;
}

/** What a playback endpoint needs turned on. */
export type PlaybackFeature = 'playback' | 'feed' | 'preview';
