import { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from './themes';

export type AppearanceMode = 'light' | 'dark' | 'system';
export type AppearanceRadius = 'sharp' | 'default' | 'round';
export type AppearanceDensity = 'compact' | 'comfortable';
export type AppearanceFontScale = 'small' | 'default' | 'large';
/** solid, or glass: frosted, see-through bars and panels. */
export type AppearanceMaterial = 'solid' | 'glass';

/** Settings → Appearance, as GET/PUT /api/appearance carry it. */
export interface AppearanceSettings {
  mode: AppearanceMode;
  lightTheme: string;
  darkTheme: string;
  /** #rrggbb, or null for the theme's own accent. */
  accentColor: string | null;
  radius: AppearanceRadius;
  density: AppearanceDensity;
  fontScale: AppearanceFontScale;
  material: AppearanceMaterial;
  customCss: string;
}

export interface AppearanceResponse extends AppearanceSettings {
  /** Null until saved once; the defaults apply until then. */
  updatedAt: string | null;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  mode: 'system',
  lightTheme: DEFAULT_LIGHT_THEME_ID,
  darkTheme: DEFAULT_DARK_THEME_ID,
  accentColor: null,
  radius: 'default',
  density: 'comfortable',
  fontScale: 'default',
  material: 'solid',
  customCss: '',
};

/** Matches the API's limit; the field stops accepting text past it. */
export const CUSTOM_CSS_MAX_LENGTH = 20_000;

export const MODE_OPTIONS: readonly { value: AppearanceMode; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: 'pi pi-sun' },
  { value: 'dark', label: 'Dark', icon: 'pi pi-moon' },
  { value: 'system', label: 'System', icon: 'pi pi-desktop' },
];

export const RADIUS_OPTIONS: readonly { value: AppearanceRadius; label: string }[] = [
  { value: 'sharp', label: 'Sharp' },
  { value: 'default', label: 'Default' },
  { value: 'round', label: 'Round' },
];

export const DENSITY_OPTIONS: readonly { value: AppearanceDensity; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
];

export const MATERIAL_OPTIONS: readonly { value: AppearanceMaterial; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'glass', label: 'Glass' },
];

export const FONT_SCALE_OPTIONS: readonly { value: AppearanceFontScale; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Makes anything (server reply, old cache) into valid settings, defaulting what's unknown. */
export function normalizeAppearance(value: unknown): AppearanceSettings {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  return {
    mode: oneOf(input['mode'], ['light', 'dark', 'system'] as const, d.mode),
    lightTheme: typeof input['lightTheme'] === 'string' ? input['lightTheme'] : d.lightTheme,
    darkTheme: typeof input['darkTheme'] === 'string' ? input['darkTheme'] : d.darkTheme,
    accentColor:
      typeof input['accentColor'] === 'string' && /^#[0-9a-f]{6}$/i.test(input['accentColor'])
        ? input['accentColor'].toLowerCase()
        : null,
    radius: oneOf(input['radius'], ['sharp', 'default', 'round'] as const, d.radius),
    density: oneOf(input['density'], ['compact', 'comfortable'] as const, d.density),
    fontScale: oneOf(input['fontScale'], ['small', 'default', 'large'] as const, d.fontScale),
    material: oneOf(input['material'], ['solid', 'glass'] as const, d.material),
    customCss:
      typeof input['customCss'] === 'string'
        ? input['customCss'].slice(0, CUSTOM_CSS_MAX_LENGTH)
        : '',
  };
}

export function sameAppearance(a: AppearanceSettings, b: AppearanceSettings): boolean {
  return (
    a.mode === b.mode &&
    a.lightTheme === b.lightTheme &&
    a.darkTheme === b.darkTheme &&
    a.accentColor === b.accentColor &&
    a.radius === b.radius &&
    a.density === b.density &&
    a.fontScale === b.fontScale &&
    a.material === b.material &&
    a.customCss === b.customCss
  );
}
