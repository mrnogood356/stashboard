import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Injectable, effect, inject, signal } from '@angular/core';
import { ARTWORK_ACCENT } from './appearance.types';
import { GlassArtService } from './glass-art.service';
import { accentTokens } from './theme-tokens';
import { ThemeService } from './theme.service';

/** Small enough to read fast, big enough to find the colour. */
const SAMPLE = 32;

/**
 * Accent "Match the artwork": the accent takes the most vivid colour of the
 * poster or photo on screen (GlassArtService's), contrast-checked against the
 * theme like any custom accent. Our own pictures are read here; another
 * site's (a catalog's, without CORS) by the server, which hands back only the
 * colour. No artwork, or none to be had: the theme's own accent.
 */
@Injectable({ providedIn: 'root' })
export class ArtworkAccentService {
  private readonly document = inject(DOCUMENT);
  private readonly theme = inject(ThemeService);
  private readonly art = inject(GlassArtService);
  private readonly http = inject(HttpClient);
  private readonly colors = new Map<string, string | null>();
  /** The colour taken from the current artwork, once read. */
  private readonly picked = signal<string | null>(null);
  private applied: string[] = [];

  /** Created by the app shell; from then on it follows the setting and the artwork. */
  constructor() {
    effect(() => {
      const on = this.theme.settings().accentColor === ARTWORK_ACCENT;
      const url = on ? this.art.url() : null;
      if (!url) {
        this.picked.set(null);
        return;
      }
      void this.colorOf(url).then((color) => {
        if (this.art.url() === url) {
          this.picked.set(color);
        }
      });
    });
    effect(() => {
      const color = this.picked();
      const theme = this.theme.activeTheme();
      this.write(color ? accentTokens(color, theme.palette.surface1, theme.scheme) : null);
    });
  }

  private write(tokens: Record<string, string> | null): void {
    const style = this.document.documentElement.style;
    for (const name of this.applied) {
      style.removeProperty(name);
    }
    this.applied = [];
    if (tokens) {
      for (const [name, value] of Object.entries(tokens)) {
        style.setProperty(name, value);
        this.applied.push(name);
      }
    }
  }

  private async colorOf(url: string): Promise<string | null> {
    if (this.colors.has(url)) {
      return this.colors.get(url) ?? null;
    }
    const color = this.sameOrigin(url)
      ? await this.sample(url).catch(() => null)
      : await firstValueFrom(
          this.http.get<{ color: string | null }>('/api/media/accent', { params: { url } }),
        )
          .then((answer) => answer.color)
          .catch(() => null);
    this.colors.set(url, color);
    return color;
  }

  private sameOrigin(url: string): boolean {
    try {
      const origin = this.document.defaultView?.location.origin;
      return new URL(url, origin).origin === origin;
    } catch {
      return false;
    }
  }

  private async sample(url: string): Promise<string | null> {
    const view = this.document.defaultView;
    if (!view?.Image) {
      return null;
    }
    const image = new view.Image();
    image.crossOrigin = 'anonymous';
    image.src = url;
    await image.decode();
    const canvas = this.document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return vividColor(context.getImageData(0, 0, SAMPLE, SAMPLE).data);
  }
}

/**
 * The colour an eye picks out: pixels weighted by how saturated and how far
 * from black or white they are, averaged by hue, then given enough
 * saturation to work as an accent. Grey artwork gives null.
 */
export function vividColor(pixels: Uint8ClampedArray): string | null {
  let x = 0;
  let y = 0;
  let weight = 0;
  let light = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) {
      continue;
    }
    const [h, s, l] = toHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
    const w = s * s * (1 - Math.abs(2 * l - 1));
    if (w <= 0.02) {
      continue;
    }
    x += Math.cos(h * 2 * Math.PI) * w;
    y += Math.sin(h * 2 * Math.PI) * w;
    light += l * w;
    weight += w;
  }
  if (weight < 1.5) {
    return null;
  }
  const hue = (Math.atan2(y, x) / (2 * Math.PI) + 1) % 1;
  const lightness = Math.min(0.62, Math.max(0.45, light / weight));
  return toHex(hue, 0.78, lightness);
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return [0, 0, l];
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
}

function toHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
