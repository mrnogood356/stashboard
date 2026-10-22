import { AppearanceSettings } from './appearance.types';
import {
  contrastRatio,
  ensureContrast,
  isHexColor,
  parseHex,
  readableTextOn,
  shiftForHover,
} from './color-contrast';
import { ColorScheme, ThemeDefinition, darkThemeOrDefault, lightThemeOrDefault } from './themes';

/** WCAG minimums: 4.5:1 for body text, 3:1 for large text and UI parts. */
export const TEXT_CONTRAST = 4.5;
export const UI_CONTRAST = 3;

/** The resolved look for one colour scheme: what the boot script and the service apply. */
export interface AppliedTheme {
  id: string;
  scheme: ColorScheme;
  /** `:root` custom properties for this theme, as a stylesheet. */
  css: string;
  /** For <meta name="theme-color">: the page background. */
  themeColor: string;
}

/**
 * What localStorage keeps so the next load can paint the right theme before
 * Angular starts (public/theme-boot.js reads it). Both schemes are kept so
 * "System" can follow the device without waiting for anything.
 */
export interface AppearanceCache {
  v: 1;
  mode: AppearanceSettings['mode'];
  light: AppliedTheme;
  dark: AppliedTheme;
  radius: AppearanceSettings['radius'];
  density: AppearanceSettings['density'];
  fontScale: AppearanceSettings['fontScale'];
  customCss: string;
  /** The settings themselves, so the app starts from them before the server answers. */
  settings: AppearanceSettings;
}

export const APPEARANCE_CACHE_KEY = 'sp-appearance-v1';
/** Ids of the elements the boot script and the service share. */
export const THEME_STYLE_ID = 'sp-theme-tokens';
export const CUSTOM_CSS_STYLE_ID = 'sp-custom-css';

function rgbWithAlpha(hex: string, alphaPercent: number): string {
  const rgb = parseHex(hex);
  return rgb ? `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${alphaPercent}%)` : hex;
}

/** Accent shades that keep text readable whatever colour was picked. */
export function accentTokens(
  accent: string,
  surface: string,
  scheme: ColorScheme,
): Record<string, string> {
  // As a fill or an outline it needs 3:1 against the card; as text, 4.5:1.
  const ui = ensureContrast(accent, surface, UI_CONTRAST);
  const text = ensureContrast(accent, surface, TEXT_CONTRAST);
  const contrast = readableTextOn(ui);
  return {
    '--accent': ui,
    '--focus-ring': ui,
    '--accent-contrast': contrast,
    '--accent-hover': shiftForHover(ui, scheme),
    '--accent-active': shiftForHover(ui, scheme, 0.22),
    '--accent-text': text,
    '--badge-requested-bg': `color-mix(in srgb, ${ui} ${scheme === 'dark' ? 20 : 12}%, transparent)`,
    '--badge-requested-text': text,
  };
}

/** Every custom property a theme sets, accent override applied. */
export function buildThemeTokens(
  theme: ThemeDefinition,
  accentOverride: string | null = null,
): Record<string, string> {
  const p = theme.palette;
  const accent = isHexColor(accentOverride) ? accentOverride : p.accent;
  const tokens: Record<string, string> = {
    '--app-bg': p.appBg,
    '--surface-1': p.surface1,
    '--surface-2': p.surface2,
    '--surface-elevated': p.elevated,
    '--surface-raised': p.raised,
    '--text-primary': p.text,
    '--text-secondary': p.textSecondary,
    '--text-muted': p.textMuted,
    '--border-subtle': p.borderSubtle,
    '--border-strong': p.borderStrong,
    '--danger': p.danger,
    '--success': p.success,
    '--warning': p.warning,
    '--info': p.info,
    ...accentTokens(accent, p.surface1, theme.scheme),
  };
  if (theme.builtIn) {
    // Light and Dark keep the hand-tuned tokens in styles.scss.
    return tokens;
  }

  const textOn = (color: string) => ensureContrast(color, p.surface1, TEXT_CONTRAST);
  const tint = theme.scheme === 'dark' ? 18 : 13;
  const status = (name: string, color: string, text: string) => ({
    [`--badge-${name}-bg`]: `color-mix(in srgb, ${color} ${tint}%, transparent)`,
    [`--badge-${name}-border`]: 'transparent',
    [`--badge-${name}-text`]: text,
  });
  const successText = textOn(p.success);
  const warningText = textOn(p.warning);
  const dangerText = textOn(p.danger);
  const infoText = textOn(p.info);

  return {
    ...tokens,
    '--success-text': successText,
    '--warning-text': warningText,
    '--danger-text': dangerText,
    '--info-text': infoText,
    '--chip-bg': p.raised,
    '--chip-text': p.text,
    '--button-bg': p.elevated,
    '--button-border': p.borderStrong,
    '--button-text': p.text,
    '--glass-bg': rgbWithAlpha(p.appBg, 74),
    '--separator': `color-mix(in srgb, ${p.borderStrong} 55%, transparent)`,
    '--warning-bg': `color-mix(in srgb, ${p.warning} 16%, ${p.surface1})`,
    '--warning-border': `color-mix(in srgb, ${p.warning} 45%, ${p.surface1})`,
    '--success-bg': `color-mix(in srgb, ${p.success} 16%, ${p.surface1})`,
    '--success-border': `color-mix(in srgb, ${p.success} 45%, ${p.surface1})`,
    '--badge-not-requested-bg': p.raised,
    '--badge-not-requested-border': 'transparent',
    '--badge-not-requested-text': p.textSecondary,
    ...status('downloading', p.warning, warningText),
    ...status('import-pending', p.info, infoText),
    ...status('available', p.success, successText),
    ...status('failed', p.danger, dangerText),
    '--scrollbar-thumb': p.borderStrong,
  };
}

/**
 * `:root:root[data-theme]` outranks the stylesheet's `:root[data-theme='dark']`
 * whatever order the two arrive in.
 */
export function tokensToCss(tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join('');
  return `:root:root[data-theme]{${body}}`;
}

export function resolveApplied(theme: ThemeDefinition, accent: string | null): AppliedTheme {
  return {
    id: theme.id,
    scheme: theme.scheme,
    css: tokensToCss(buildThemeTokens(theme, accent)),
    themeColor: theme.palette.appBg,
  };
}

export function buildAppearanceCache(settings: AppearanceSettings): AppearanceCache {
  return {
    v: 1,
    mode: settings.mode,
    light: resolveApplied(lightThemeOrDefault(settings.lightTheme), settings.accentColor),
    dark: resolveApplied(darkThemeOrDefault(settings.darkTheme), settings.accentColor),
    radius: settings.radius,
    density: settings.density,
    fontScale: settings.fontScale,
    customCss: settings.customCss,
    settings,
  };
}

/** Lowest contrast an accent gets against the theme's cards, for the picker's hint. */
export function accentContrastAgainst(theme: ThemeDefinition, accent: string): number {
  return contrastRatio(accent, theme.palette.surface1);
}
