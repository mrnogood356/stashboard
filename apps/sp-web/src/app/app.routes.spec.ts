import { describe, expect, it } from 'vitest';
import { routes } from './app.routes';
import { requireFeedGuard, requirePlaybackGuard } from './core/guards/playback-route.guard';

describe('app routes', () => {
  it('exposes the public auth routes before the protected shell', () => {
    expect(routes.slice(0, 3).map((route) => route.path)).toEqual(['bootstrap', 'login', 'setup']);
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
      'home',
      'scene/:stashId',
      'tools',
      'tools/activity',
      'tools/fix',
      'tools/organize',
      'tools/jobs',
      'tools/samples',
      'tools/duplicates',
      'search',
      'scenes',
      'acquisition',
      'processing',
      'library/scene/:sceneId',
      'library/performer/:id',
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
});
