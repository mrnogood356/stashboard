import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Built-in themes with a light background. Keep in step with the web's theme list. */
export const LIGHT_THEME_IDS = [
  'light',
  'catppuccin-latte',
  'solarized-light',
] as const;

/** Built-in themes with a dark background. */
export const DARK_THEME_IDS = [
  'dark',
  'oled',
  'midnight',
  'plex',
  'nord',
  'dracula',
  'catppuccin-mocha',
  'solarized-dark',
] as const;

export const APPEARANCE_MODES = ['light', 'dark', 'system'] as const;
export const APPEARANCE_RADII = ['sharp', 'default', 'round'] as const;
export const APPEARANCE_DENSITIES = ['compact', 'comfortable'] as const;
export const APPEARANCE_FONT_SCALES = ['small', 'default', 'large'] as const;

/** Custom CSS is stored as plain text; this keeps it a tweak, not a second stylesheet. */
export const CUSTOM_CSS_MAX_LENGTH = 20_000;

export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export type LightThemeId = (typeof LIGHT_THEME_IDS)[number];
export type DarkThemeId = (typeof DARK_THEME_IDS)[number];
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];
export type AppearanceRadius = (typeof APPEARANCE_RADII)[number];
export type AppearanceDensity = (typeof APPEARANCE_DENSITIES)[number];
export type AppearanceFontScale = (typeof APPEARANCE_FONT_SCALES)[number];

export class UpdateAppearanceDto {
  @IsIn(APPEARANCE_MODES)
  mode!: AppearanceMode;

  @IsIn(LIGHT_THEME_IDS)
  lightTheme!: LightThemeId;

  @IsIn(DARK_THEME_IDS)
  darkTheme!: DarkThemeId;

  /** #rrggbb, or null/omitted for the theme's own accent. */
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_PATTERN, {
    message: 'accentColor must be a #rrggbb colour.',
  })
  accentColor?: string | null;

  @IsIn(APPEARANCE_RADII)
  radius!: AppearanceRadius;

  @IsIn(APPEARANCE_DENSITIES)
  density!: AppearanceDensity;

  @IsIn(APPEARANCE_FONT_SCALES)
  fontScale!: AppearanceFontScale;

  @IsOptional()
  @IsString()
  @MaxLength(CUSTOM_CSS_MAX_LENGTH)
  customCss?: string;
}

export interface AppearanceResponse {
  mode: AppearanceMode;
  lightTheme: LightThemeId;
  darkTheme: DarkThemeId;
  accentColor: string | null;
  radius: AppearanceRadius;
  density: AppearanceDensity;
  fontScale: AppearanceFontScale;
  customCss: string;
  /** When it was last saved; null while the defaults apply. */
  updatedAt: string | null;
}
