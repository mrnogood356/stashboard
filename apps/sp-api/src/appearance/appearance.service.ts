import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  APPEARANCE_DENSITIES,
  APPEARANCE_FONT_SCALES,
  APPEARANCE_MATERIALS,
  APPEARANCE_MODES,
  APPEARANCE_RADII,
  type AppearanceResponse,
  DARK_THEME_IDS,
  HEX_COLOR_PATTERN,
  LIGHT_THEME_IDS,
  UpdateAppearanceDto,
} from './dto/appearance.dto';

const KEY = 'GLOBAL';

export const DEFAULT_APPEARANCE: AppearanceResponse = {
  mode: 'system',
  lightTheme: 'light',
  darkTheme: 'dark',
  accentColor: null,
  radius: 'default',
  density: 'comfortable',
  fontScale: 'default',
  material: 'solid',
  customCss: '',
  updatedAt: null,
};

interface AppearanceRow {
  mode: string;
  lightTheme: string;
  darkTheme: string;
  accentColor: string | null;
  radius: string;
  density: string;
  fontScale: string;
  material: string;
  customCss: string;
  updatedAt: Date;
}

/**
 * Settings → Appearance. One row for the whole install, so the look follows
 * the admin to every device (phone home-screen app and desktop alike).
 */
@Injectable()
export class AppearanceService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AppearanceResponse> {
    const row = await this.prisma.appearanceSettings.findUnique({
      where: { key: KEY },
    });
    return row ? describe(row) : { ...DEFAULT_APPEARANCE };
  }

  async update(body: UpdateAppearanceDto): Promise<AppearanceResponse> {
    const data = {
      mode: body.mode,
      lightTheme: body.lightTheme,
      darkTheme: body.darkTheme,
      accentColor: body.accentColor ? body.accentColor.toLowerCase() : null,
      radius: body.radius,
      density: body.density,
      fontScale: body.fontScale,
      customCss: body.customCss ?? '',
      ...(body.material ? { material: body.material } : {}),
    };
    const row = await this.prisma.appearanceSettings.upsert({
      where: { key: KEY },
      create: { key: KEY, ...data },
      update: data,
    });
    return describe(row);
  }

  async reset(): Promise<AppearanceResponse> {
    await this.prisma.appearanceSettings.deleteMany({ where: { key: KEY } });
    return { ...DEFAULT_APPEARANCE };
  }
}

/** A stored value that is no longer known (a theme removed later) falls back to the default. */
function pick<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function describe(row: AppearanceRow): AppearanceResponse {
  return {
    mode: pick(row.mode, APPEARANCE_MODES, DEFAULT_APPEARANCE.mode),
    lightTheme: pick(
      row.lightTheme,
      LIGHT_THEME_IDS,
      DEFAULT_APPEARANCE.lightTheme,
    ),
    darkTheme: pick(
      row.darkTheme,
      DARK_THEME_IDS,
      DEFAULT_APPEARANCE.darkTheme,
    ),
    accentColor:
      row.accentColor && HEX_COLOR_PATTERN.test(row.accentColor)
        ? row.accentColor
        : null,
    radius: pick(row.radius, APPEARANCE_RADII, DEFAULT_APPEARANCE.radius),
    density: pick(
      row.density,
      APPEARANCE_DENSITIES,
      DEFAULT_APPEARANCE.density,
    ),
    fontScale: pick(
      row.fontScale,
      APPEARANCE_FONT_SCALES,
      DEFAULT_APPEARANCE.fontScale,
    ),
    material: pick(
      row.material,
      APPEARANCE_MATERIALS,
      DEFAULT_APPEARANCE.material,
    ),
    customCss: row.customCss,
    updatedAt: row.updatedAt.toISOString(),
  };
}
