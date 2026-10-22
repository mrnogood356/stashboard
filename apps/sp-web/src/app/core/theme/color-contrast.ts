/**
 * Small colour helpers for the theme: WCAG contrast, and nudging a colour
 * lighter or darker until text on it (or it on a background) stays readable.
 * Works on #rrggbb strings only; that's all the themes and the picker use.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function parseHex(hex: string): Rgb | null {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) {
    return null;
  }
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  const value = Number.parseInt(digits, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: string | Rgb): number {
  const rgb = typeof color === 'string' ? parseHex(color) : color;
  if (!rgb) {
    return 0;
  }
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Mixes `a` toward `b`; amount 0 keeps `a`, 1 gives `b`. */
export function mixHex(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) {
    return a;
  }
  const t = Math.min(1, Math.max(0, amount));
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
  });
}

export const WHITE = '#ffffff';
/** Near-black reads softer than pure black on bright accents. */
export const INK = '#111114';

/**
 * Text colour for a filled accent (buttons, pills, badges). White while it
 * still reaches 3:1, the WCAG minimum for the bold, button-sized labels it's
 * used for (so the classic iOS blue keeps white text); on brighter fills
 * (amber, yellow, pastels) whichever of white or near-black reads better.
 */
export function readableTextOn(background: string, preferWhiteAt = 3): string {
  const white = contrastRatio(WHITE, background);
  if (white >= preferWhiteAt) {
    return WHITE;
  }
  return white >= contrastRatio(INK, background) ? WHITE : INK;
}

/**
 * Moves `color` toward white or black (whichever direction increases contrast
 * against `background`) in small steps until it reaches `minRatio`. Returns
 * the colour unchanged when it already passes.
 */
export function ensureContrast(color: string, background: string, minRatio: number): string {
  if (!parseHex(color) || !parseHex(background)) {
    return color;
  }
  if (contrastRatio(color, background) >= minRatio) {
    return color.toLowerCase();
  }
  const target = relativeLuminance(background) > 0.4 ? '#000000' : WHITE;
  for (let step = 1; step <= 20; step++) {
    const candidate = mixHex(color, target, step * 0.05);
    if (contrastRatio(candidate, background) >= minRatio) {
      return candidate;
    }
  }
  return target;
}

/** A hover shade: a little lighter on dark themes, a little darker on light ones. */
export function shiftForHover(color: string, scheme: 'light' | 'dark', amount = 0.12): string {
  return mixHex(color, scheme === 'dark' ? WHITE : '#000000', amount);
}
