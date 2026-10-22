import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppNotificationsService } from '../notifications/app-notifications.service';
import { PlaybackSettingsService } from '../playback/playback-settings.service';
import { requireFeedGuard, requirePlaybackGuard } from './playback-route.guard';

describe('playback route guards', () => {
  const playbackEnabled = signal(true);
  const feedEnabled = signal(true);
  const playback = {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    playbackEnabled,
    feedEnabled,
  };
  const notifications = { info: vi.fn() };
  let router: Router;

  beforeEach(() => {
    playbackEnabled.set(true);
    feedEnabled.set(true);
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: PlaybackSettingsService, useValue: playback },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    });
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const run = (guard: CanActivateFn) =>
    TestBed.runInInjectionContext(() =>
      guard({} as ActivatedRouteSnapshot, { url: '/x' } as RouterStateSnapshot),
    ) as Promise<boolean | UrlTree>;

  it('lets /watch and /feed open while playback is on', async () => {
    await expect(run(requirePlaybackGuard)).resolves.toBe(true);
    await expect(run(requireFeedGuard)).resolves.toBe(true);
    expect(playback.ensureLoaded).toHaveBeenCalled();
    expect(notifications.info).not.toHaveBeenCalled();
  });

  it('sends /watch to Home with a note while playback is off', async () => {
    playbackEnabled.set(false);
    feedEnabled.set(false);
    const result = await run(requirePlaybackGuard);
    expect(router.serializeUrl(result as UrlTree)).toBe('/home');
    expect(notifications.info).toHaveBeenCalledWith(
      'Playback is turned off',
      'Turn it on in Settings → Playback.',
    );
  });

  it('sends /feed to Home while only the feed is off, and still allows /watch', async () => {
    feedEnabled.set(false);
    const result = await run(requireFeedGuard);
    expect(router.serializeUrl(result as UrlTree)).toBe('/home');
    expect(notifications.info).toHaveBeenCalledWith(
      'The swipe feed is turned off',
      'Turn it on in Settings → Playback.',
    );
    await expect(run(requirePlaybackGuard)).resolves.toBe(true);
  });
});
