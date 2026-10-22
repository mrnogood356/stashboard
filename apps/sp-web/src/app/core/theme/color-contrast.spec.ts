import { describe, expect, it } from 'vitest';
import {
  INK,
  WHITE,
  contrastRatio,
  ensureContrast,
  isHexColor,
  mixHex,
  parseHex,
  readableTextOn,
  relativeLuminance,
  shiftForHover,
} from './color-contrast';
import { TEXT_CONTRAST, UI_CONTRAST, accentTokens, buildThemeTokens } from './theme-tokens';
import { ALL_THEMES, DARK_THEMES, LIGHT_THEMES } from './themes';

describe('color contrast helpers', () => {
  it('parses 6- and 3-digit hex and rejects anything else', () => {
    expect(parseHex('#0a84ff')).toEqual({ r: 10, g: 132, b: 255 });
    expect(parseHex('fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('red')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(isHexColor('#ABCDEF')).toBe(true);
    expect(isHexColor('#abc')).toBe(false);
    expect(isHexColor(42)).toBe(false);
  });

  it('computes WCAG luminance and contrast ratios', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Known pair: #767676 on white is the classic 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(contrastRatio('#767676', '#ffffff'));
  });

  it('mixes colours', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff');
  });

  it('picks white or near-black text, whichever reads better', () => {
    expect(readableTextOn('#0a84ff')).toBe(WHITE);
    expect(readableTextOn('#ffd60a')).toBe(INK);
    expect(readableTextOn('#e5a00d')).toBe(INK);
  });

  it('leaves a colour alone when it already has enough contrast', () => {
    expect(ensureContrast('#0055b3', '#ffffff', TEXT_CONTRAST)).toBe('#0055b3');
  });

  it('darkens a pale colour on a light background until it passes', () => {
    const nudged = ensureContrast('#ffd60a', '#ffffff', TEXT_CONTRAST);
    expect(contrastRatio(nudged, '#ffffff')).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(relativeLuminance(nudged)).toBeLessThan(relativeLuminance('#ffd60a'));
  });

  it('lightens a deep colour on a dark background until it passes', () => {
    const nudged = ensureContrast('#1b1f7a', '#151517', UI_CONTRAST);
    expect(contrastRatio(nudged, '#151517')).toBeGreaterThanOrEqual(UI_CONTRAST);
    expect(relativeLuminance(nudged)).toBeGreaterThan(relativeLuminance('#1b1f7a'));
  });

  it('shifts hover shades in the right direction for each scheme', () => {
    expect(relativeLuminance(shiftForHover('#0a84ff', 'dark'))).toBeGreaterThan(
      relativeLuminance('#0a84ff'),
    );
    expect(relativeLuminance(shiftForHover('#0a84ff', 'light'))).toBeLessThan(
      relativeLuminance('#0a84ff'),
    );
  });
});

describe('theme tokens', () => {
  it('keeps every built-in theme readable: body and muted text pass 4.5:1 on cards', () => {
    for (const theme of ALL_THEMES) {
      const p = theme.palette;
      expect(contrastRatio(p.text, p.surface1), `${theme.id} text`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(p.textMuted, p.surface1), `${theme.id} muted`).toBeGreaterThanOrEqual(
        TEXT_CONTRAST,
      );
    }
  });

  it('gives every theme an accent with readable text on it and as text on cards', () => {
    for (const theme of ALL_THEMES) {
      const tokens = buildThemeTokens(theme);
      const surface = theme.palette.surface1;
      expect(contrastRatio(tokens['--accent'], surface), theme.id).toBeGreaterThanOrEqual(
        UI_CONTRAST,
      );
      expect(contrastRatio(tokens['--accent-text'], surface), theme.id).toBeGreaterThanOrEqual(
        TEXT_CONTRAST,
      );
      expect(
        contrastRatio(tokens['--accent-contrast'], tokens['--accent']),
        theme.id,
      ).toBeGreaterThanOrEqual(UI_CONTRAST);
    }
  });

  it('nudges a custom accent that would vanish on the theme', () => {
    const latte = LIGHT_THEMES.find((theme) => theme.id === 'catppuccin-latte')!;
    const tokens = buildThemeTokens(latte, '#fff5cc');
    expect(tokens['--accent']).not.toBe('#fff5cc');
    expect(contrastRatio(tokens['--accent'], latte.palette.surface1)).toBeGreaterThanOrEqual(
      UI_CONTRAST,
    );
    expect(tokens['--accent-contrast']).toBe(readableTextOn(tokens['--accent']));
  });

  it('ignores an accent override that is not a hex colour', () => {
    const oled = DARK_THEMES.find((theme) => theme.id === 'oled')!;
    expect(buildThemeTokens(oled, 'javascript:alert(1)')['--accent']).toBe(
      accentTokens(oled.palette.accent, oled.palette.surface1, 'dark')['--accent'],
    );
  });

  it('derives status and chip tokens for preset themes but not for Light/Dark', () => {
    const nord = DARK_THEMES.find((theme) => theme.id === 'nord')!;
    const dark = DARK_THEMES.find((theme) => theme.id === 'dark')!;
    expect(buildThemeTokens(nord)['--badge-available-text']).toBeDefined();
    expect(buildThemeTokens(nord)['--chip-bg']).toBe(nord.palette.raised);
    expect(buildThemeTokens(dark)['--chip-bg']).toBeUndefined();
    expect(buildThemeTokens(dark)['--app-bg']).toBe('#0b0b0d');
  });

  it('has an OLED theme with a pure black background', () => {
    expect(DARK_THEMES.find((theme) => theme.id === 'oled')?.palette.appBg).toBe('#000000');
  });
});
