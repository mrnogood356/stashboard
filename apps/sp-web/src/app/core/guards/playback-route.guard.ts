import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AppNotificationsService } from '../notifications/app-notifications.service';
import { PlaybackSettingsService } from '../playback/playback-settings.service';

/** /watch: only while Settings → Playback has playback on; Home otherwise. */
export const requirePlaybackGuard: CanActivateFn = async () => {
  const playback = inject(PlaybackSettingsService);
  const router = inject(Router);
  const notifications = inject(AppNotificationsService);
  await playback.ensureLoaded();
  if (playback.playbackEnabled()) {
    return true;
  }
  notifications.info('Playback is turned off', 'Turn it on in Settings → Playback.');
  return router.createUrlTree(['/home']);
};

/** /feed: only while Settings → Playback has the swipe feed on; Home otherwise. */
export const requireFeedGuard: CanActivateFn = async () => {
  const playback = inject(PlaybackSettingsService);
  const router = inject(Router);
  const notifications = inject(AppNotificationsService);
  await playback.ensureLoaded();
  if (playback.feedEnabled()) {
    return true;
  }
  notifications.info(
    playback.playbackEnabled() ? 'The swipe feed is turned off' : 'Playback is turned off',
    'Turn it on in Settings → Playback.',
  );
  return router.createUrlTree(['/home']);
};
