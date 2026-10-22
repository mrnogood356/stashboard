import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlaybackFeature } from './dto/playback-settings.dto';
import {
  allowsFeature,
  PlaybackSettingsService,
} from './playback-settings.service';

const PLAYBACK_FEATURE_KEY = 'playbackFeature';

const MESSAGES: Record<PlaybackFeature, string> = {
  playback: 'Playback is turned off. Turn it on in Settings → Playback.',
  feed: 'The swipe feed is turned off. Turn it on in Settings → Playback.',
  preview: 'Preview clips are turned off. Turn them on in Settings → Playback.',
};

/**
 * Refuses a playback endpoint while Settings → Playback has it turned off.
 * Runs after the login check, and also on the public stream route, so a
 * stream link handed out earlier stops working once playback is off.
 */
@Injectable()
export class PlaybackFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly settings: PlaybackSettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature =
      this.reflector.getAllAndOverride<PlaybackFeature | undefined>(
        PLAYBACK_FEATURE_KEY,
        [context.getHandler(), context.getClass()],
      ) ?? 'playback';
    const settings = await this.settings.get();
    if (allowsFeature(settings, feature)) {
      return true;
    }
    throw new ForbiddenException(
      settings.enabled ? MESSAGES[feature] : MESSAGES.playback,
    );
  }
}

/** Only while Settings → Playback has this feature on; 403 otherwise. */
export function RequiresPlayback(
  feature: PlaybackFeature = 'playback',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(PLAYBACK_FEATURE_KEY, feature),
    UseGuards(PlaybackFeatureGuard),
  );
}
