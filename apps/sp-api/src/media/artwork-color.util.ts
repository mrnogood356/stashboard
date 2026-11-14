/**
 * The colour an eye picks out of a picture: pixels weighted by how saturated
 * and how far from black or white they are, averaged by hue, then given
 * enough saturation to work as an accent. Grey pictures give null.
 * The web app does the same for pictures it can read itself
 * (core/theme/artwork-accent.service.ts); keep the two in step.
 */
export function vividColor(
  pixels: Uint8Array | Uint8ClampedArray,
  channels = 4,
): string | null {
  let x = 0;
  let y = 0;
  let weight = 0;
  let light = 0;
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    if (channels === 4 && pixels[i + 3] < 128) {
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

/** Where catalogs keep their pictures, besides the site itself. */
const IMAGE_SUBDOMAINS = ['cdn', 'images', 'img', 'media', 'static'];

/**
 * The address to fetch for a catalog picture, or null when it isn't on the
 * catalog's own site: stashdb.org, or cdn.stashdb.org and the like, when
 * StashDB is set up at stashdb.org. The address is rebuilt from the saved
 * catalog host, so the request can never pick where the server connects.
 */
export function catalogImageUrl(url: URL, catalogHosts: string[]): URL | null {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  const scheme = url.protocol === 'https:' ? 'https:' : 'http:';
  const host = url.host.toLowerCase();
  for (const allowed of catalogHosts) {
    const base = allowed.toLowerCase().replace(/^www\./, '');
    const match = [
      base,
      ...IMAGE_SUBDOMAINS.map((sub) => `${sub}.${base}`),
    ].find((candidate) => candidate === host);
    if (match) {
      // Joined after the host, never resolved against it: a path such as
      // //evil.com/x would otherwise replace the host.
      return new URL(`${scheme}//${match}${url.pathname}${url.search}`);
    }
  }
  return null;
}
