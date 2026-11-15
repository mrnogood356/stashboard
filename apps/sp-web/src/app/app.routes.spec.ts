import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { routes } from './app.routes';
import { requireFeedGuard, requirePlaybackGuard } from './core/guards/playback-route.guard';

describe('app routes', () => {
  it('exposes the public auth routes before the protected shell', () => {
    expect(routes.slice(0, 4).map((route) => route.path)).toEqual([
      'bootstrap',
      'unreachable',
      'login',
      'setup',
    ]);
    // Shown when Stashboard can't be reached, so it needs no answer from it.
    expect(routes.find((route) => route.path === 'unreachable')?.canActivate).toBeUndefined();
    expect(routes.map((route) => route.path)).toContain('watch/:sceneId');
    expect(routes.map((route) => route.path)).toContain('feed');
  });

  it('guards the player and the swipe feed with Settings → Playback', () => {
    const watch = routes.find((route) => route.path === 'watch/:sceneId');
    const feed = routes.find((route) => route.path === 'feed');
    expect(watch?.canActivate).toContain(requirePlaybackGuard);
    expect(feed?.canActivate).toContain(requireFeedGuard);
  });

  it('keeps the canonical app-shell routes aligned with the consolidated discovery model', () => {
    const appShellChildren = routes.find((route) => route.path === '')?.children ?? [];
    const paths = appShellChildren.map((route) => route.path);

    expect(paths).toEqual([
      // Pull to refresh passes through it to rebuild a page in place.
      'refreshing',
      'home',
      'scene/:stashId',
      'tools',
      'tools/activity',
      'tools/fix',
      'tools/organize',
      'tools/match',
      'tools/rename',
      'tools/jobs',
      'tools/samples',
      'tools/stats',
      'tools/tags',
      'tools/broken',
      'tools/merge',
      'tools/smaller-copies',
      'tools/better-copies',
      'tools/schedules',
      'tools/duplicates',
      'search',
      'scenes',
      'calendar',
      'watch-later',
      'chapters',
      'history',
      'you-may-enjoy',
      'following',
      'acquisition',
      'processing',
      'library/scene/:sceneId',
      'library/performer/:id/all',
      'library/performer/:id',
      'library/studio/:id/all',
      'library/studio/:id',
      'library',
      'performers',
      'studios',
      'performer/:performerId',
      'studio/:studioId',
      'settings',
      '',
    ]);
  });

  it('organizes settings into focused child routes', () => {
    const appShellChildren = routes.find((route) => route.path === '')?.children ?? [];
    const settingsRoute = appShellChildren.find((route) => route.path === 'settings');

    expect(settingsRoute?.children?.map((route) => route.path)).toEqual([
      '',
      'integrations',
      'indexing',
      'notifications',
      'automation',
      'hidden',
      'setup-check',
      'appearance',
      'playback',
      'privacy',
      'account',
      'about',
      'logs',
    ]);
  });

  it('sends Match & rename links to Match scenes or Rename files', () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    const shell = routes.find((route) => route.path === '')?.children ?? [];
    const organize = shell.find((route) => route.path === 'tools/organize')!;
    const go = (queryParams: Record<string, string>) =>
      TestBed.runInInjectionContext(() =>
        TestBed.inject(Router).serializeUrl(
          (organize.redirectTo as (route: { queryParams: Record<string, string> }) => never)({
            queryParams,
          }),
        ),
      );
    expect(go({ tab: 'review' })).toBe('/tools/match');
    expect(go({ tab: 'match' })).toBe('/tools/match');
    expect(go({ q: 'Summer' })).toBe('/tools/match?q=Summer');
    expect(go({})).toBe('/tools/rename');
    expect(go({ tab: 'settings' })).toBe('/tools/rename?tab=settings');
    expect(go({ tab: 'rename' })).toBe('/tools/rename?tab=rename');
    expect(shell.find((route) => route.path === 'tools/match')?.data).toEqual({ tool: 'match' });
    expect(shell.find((route) => route.path === 'tools/rename')?.data).toEqual({ tool: 'rename' });
  });
});
