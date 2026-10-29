import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceResponse, DEFAULT_APPEARANCE } from './appearance.types';
import { APPEARANCE_CACHE_KEY, AppearanceCache, buildAppearanceCache } from './theme-tokens';
import { ThemeService } from './theme.service';

function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const list = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => list),
  );
  return {
    set(dark: boolean) {
      list.matches = dark;
      listeners.forEach((listener) => listener({ matches: dark } as MediaQueryListEvent));
    },
  };
}

function response(patch: Partial<AppearanceResponse> = {}): AppearanceResponse {
  return { ...DEFAULT_APPEARANCE, updatedAt: '2026-10-22T10:00:00.000Z', ...patch };
}

describe('ThemeService', () => {
  let http: HttpTestingController;
  const root = () => document.documentElement;
  const tokenCss = () => document.getElementById('sp-theme-tokens')?.textContent ?? '';

  function create(): ThemeService {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    return TestBed.inject(ThemeService);
  }

  beforeEach(() => {
    localStorage.clear();
    document.getElementById('sp-theme-tokens')?.remove();
    document.getElementById('sp-custom-css')?.remove();
    document
      .querySelectorAll(
        'meta[name="theme-color"], meta[name="apple-mobile-web-app-status-bar-style"]',
      )
      .forEach((meta) => meta.remove());
    for (const name of ['data-theme', 'data-theme-id', 'data-radius', 'data-density']) {
      root().removeAttribute(name);
    }
    root().removeAttribute('data-font-scale');
    root().removeAttribute('data-material');
    root().removeAttribute('data-glass-art');
  });

  afterEach(() => {
    http?.verify();
    TestBed.resetTestingModule();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('follows the device in System mode by default, and keeps following it', () => {
    const media = installMatchMedia(true);
    const service = create();

    expect(service.settings().mode).toBe('system');
    expect(service.theme()).toBe('dark');
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().getAttribute('data-theme-id')).toBe('dark');

    media.set(false);
    expect(service.theme()).toBe('light');
    expect(root().getAttribute('data-theme')).toBe('light');
    expect(root().getAttribute('data-theme-id')).toBe('light');
  });

  it('starts from the cached settings so the first paint matches', () => {
    installMatchMedia(false);
    const cached: AppearanceCache = buildAppearanceCache({
      ...DEFAULT_APPEARANCE,
      mode: 'dark',
      darkTheme: 'oled',
      radius: 'round',
    });
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(cached));

    const service = create();
    expect(service.theme()).toBe('dark');
    expect(root().getAttribute('data-theme-id')).toBe('oled');
    expect(root().getAttribute('data-radius')).toBe('round');
    expect(tokenCss()).toContain('--app-bg:#000000');
  });

  it('keeps a choice made with the old header toggle until the server has one', async () => {
    installMatchMedia(false);
    localStorage.setItem('sp-theme', 'dark');
    const service = create();
    expect(service.theme()).toBe('dark');

    const sync = service.syncFromServer();
    http.expectOne('/api/appearance').flush(response({ updatedAt: null }));
    await sync;
    expect(service.theme()).toBe('dark');
  });

  it('applies the server settings: theme, accent, layout, custom CSS and status bar', async () => {
    installMatchMedia(false);
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    const appleBar = document.createElement('meta');
    appleBar.name = 'apple-mobile-web-app-status-bar-style';
    document.head.appendChild(appleBar);

    const service = create();
    const sync = service.syncFromServer();
    http.expectOne('/api/appearance').flush(
      response({
        mode: 'dark',
        darkTheme: 'nord',
        accentColor: '#ff9f0a',
        density: 'compact',
        fontScale: 'large',
        material: 'glass',
        customCss: '.x { color: red; }',
      }),
    );
    await sync;

    expect(service.loaded()).toBe(true);
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(root().getAttribute('data-theme-id')).toBe('nord');
    expect(root().getAttribute('data-density')).toBe('compact');
    expect(root().getAttribute('data-font-scale')).toBe('large');
    expect(root().getAttribute('data-material')).toBe('glass');
    expect(root().hasAttribute('data-glass-art')).toBe(false);
    expect(tokenCss()).toContain('--accent:#ff9f0a');
    expect(tokenCss().startsWith(':root:root[data-theme]{')).toBe(true);
    expect(meta.content).toBe('#242933');
    expect(appleBar.content).toBe('black-translucent');

    const custom = document.getElementById('sp-custom-css');
    expect(custom?.tagName).toBe('STYLE');
    expect(custom?.textContent).toBe('.x { color: red; }');

    const cache = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY)!) as AppearanceCache;
    expect(cache.mode).toBe('dark');
    expect(cache.dark.id).toBe('nord');
    expect(cache.light.id).toBe('light');
    meta.remove();
    appleBar.remove();
  });

  it('adds custom CSS as text, never as HTML', () => {
    installMatchMedia(false);
    const service = create();
    service.preview({
      ...DEFAULT_APPEARANCE,
      customCss: '/* </style><script>window.__pwned = true</script> */',
    });
    const custom = document.getElementById('sp-custom-css')!;
    expect(custom.children.length).toBe(0);
    expect(document.querySelector('#sp-custom-css script')).toBeNull();
    expect(custom.textContent).toContain('<script>');
    expect((window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();

    service.preview({ ...DEFAULT_APPEARANCE, customCss: '   ' });
    expect(document.getElementById('sp-custom-css')).toBeNull();
  });

  it('previews without saving, and reverts to the saved look', () => {
    installMatchMedia(false);
    const service = create();
    service.preview({ ...DEFAULT_APPEARANCE, mode: 'dark', darkTheme: 'dracula' });
    expect(root().getAttribute('data-theme-id')).toBe('dracula');
    expect(localStorage.getItem(APPEARANCE_CACHE_KEY)).toBeNull();

    service.revertPreview();
    expect(root().getAttribute('data-theme-id')).toBe('light');
  });

  it('saves to the server and caches what it returns', async () => {
    installMatchMedia(false);
    const service = create();
    const saving = service.save({
      ...DEFAULT_APPEARANCE,
      mode: 'light',
      lightTheme: 'solarized-light',
    });
    const request = http.expectOne('/api/appearance');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toMatchObject({ lightTheme: 'solarized-light' });
    request.flush(response({ mode: 'light', lightTheme: 'solarized-light' }));
    await saving;

    expect(service.saved().lightTheme).toBe('solarized-light');
    expect(root().getAttribute('data-theme-id')).toBe('solarized-light');
    expect(localStorage.getItem(APPEARANCE_CACHE_KEY)).toContain('solarized-light');
  });

  it('toggles between the chosen light and dark themes and saves the mode', () => {
    installMatchMedia(false);
    const service = create();
    service.preview({
      ...DEFAULT_APPEARANCE,
      darkTheme: 'midnight',
      lightTheme: 'catppuccin-latte',
    });
    expect(service.theme()).toBe('light');

    service.toggleTheme();
    expect(service.theme()).toBe('dark');
    expect(root().getAttribute('data-theme-id')).toBe('midnight');
    const request = http.expectOne('/api/appearance');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toMatchObject({ mode: 'dark' });
    request.flush(response({ mode: 'dark' }));

    service.toggleTheme();
    expect(service.theme()).toBe('light');
    http.expectOne('/api/appearance').flush(response({ mode: 'light' }));
  });

  it('keeps the current look when the server cannot be reached', async () => {
    installMatchMedia(true);
    const service = create();
    const sync = service.syncFromServer();
    http
      .expectOne('/api/appearance')
      .flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await sync;
    expect(service.loaded()).toBe(false);
    expect(service.theme()).toBe('dark');
  });
});
