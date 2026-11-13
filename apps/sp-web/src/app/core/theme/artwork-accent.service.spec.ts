import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ArtworkAccentService, vividColor } from './artwork-accent.service';
import { GlassArtService } from './glass-art.service';
import { ThemeService } from './theme.service';
import { AppearanceSettings, DEFAULT_APPEARANCE } from './appearance.types';
import { darkThemeOrDefault } from './themes';

function pixels(colors: Array<[number, number, number]>, each = 64): Uint8ClampedArray {
  const data = new Uint8ClampedArray(colors.length * each * 4);
  let i = 0;
  for (const [r, g, b] of colors) {
    for (let n = 0; n < each; n += 1) {
      data.set([r, g, b, 255], i);
      i += 4;
    }
  }
  return data;
}

describe('vividColor', () => {
  it('picks the vivid hue out of mostly grey artwork', () => {
    const color = vividColor(
      pixels([
        [40, 40, 40],
        [200, 200, 200],
        [220, 30, 60],
      ]),
    );
    expect(color).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color!.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g + 80);
    expect(r).toBeGreaterThan(b);
  });

  it('gives nothing for grey artwork, so the theme accent stays', () => {
    expect(
      vividColor(
        pixels([
          [30, 30, 30],
          [128, 128, 128],
          [240, 240, 240],
        ]),
      ),
    ).toBeNull();
  });
});

describe('ArtworkAccentService', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
    TestBed.resetTestingModule();
  });

  it('only acts while the accent is set to the artwork, and clears what it wrote', async () => {
    const settings = signal<AppearanceSettings>({ ...DEFAULT_APPEARANCE, accentColor: 'artwork' });
    const url = signal<string | null>('/art/one.jpg');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        {
          provide: ThemeService,
          useValue: { settings, activeTheme: signal(darkThemeOrDefault('dark')) },
        },
        { provide: GlassArtService, useValue: { url } },
      ],
    });
    const service = TestBed.inject(ArtworkAccentService);
    // jsdom can't decode images: hand the colour straight to the service.
    (service as unknown as { picked: { set(v: string | null): void } }).picked.set('#e0204a');
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--accent')).not.toBe('');

    settings.set({ ...DEFAULT_APPEARANCE, accentColor: null });
    TestBed.tick();
    await Promise.resolve();
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });

  it('asks the server for another site’s picture, which the browser can’t read', async () => {
    const settings = signal<AppearanceSettings>({ ...DEFAULT_APPEARANCE, accentColor: 'artwork' });
    const url = signal<string | null>('https://cdn.stashdb.org/images/a.jpg');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ThemeService,
          useValue: { settings, activeTheme: signal(darkThemeOrDefault('dark')) },
        },
        { provide: GlassArtService, useValue: { url } },
      ],
    });
    TestBed.inject(ArtworkAccentService);
    TestBed.tick();
    const http = TestBed.inject(HttpTestingController);
    const call = http.expectOne((request) => request.url === '/api/media/accent');
    expect(call.request.params.get('url')).toBe('https://cdn.stashdb.org/images/a.jpg');
    call.flush({ color: '#2a6fe0' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
    expect(document.documentElement.style.getPropertyValue('--accent')).not.toBe('');
  });
});
