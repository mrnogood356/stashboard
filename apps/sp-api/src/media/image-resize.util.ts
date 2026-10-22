import { Logger } from '@nestjs/common';

/** Widths the app asks for; anything else is snapped to the nearest one so the cache stays small. */
export const THUMBNAIL_WIDTHS = [320, 480, 640, 960] as const;

const logger = new Logger('ImageResize');
type SharpFactory = typeof import('sharp');
let sharpModule: SharpFactory | null | undefined;

/** Loads sharp on first use; if it can't load on this platform, resizing is skipped. */
function loadSharp(): SharpFactory | null {
  if (sharpModule !== undefined) {
    return sharpModule;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sharpModule = require('sharp') as SharpFactory;
  } catch (error) {
    sharpModule = null;
    logger.warn(
      `Thumbnail resizing unavailable, serving full-size images: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return sharpModule;
}

export function normalizeThumbnailWidth(value: unknown): number | null {
  const parsed =
    typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return THUMBNAIL_WIDTHS.reduce((best, width) =>
    Math.abs(width - parsed) < Math.abs(best - parsed) ? width : best,
  );
}

/**
 * Shrinks an image to `width` pixels wide as WebP. Returns null when sharp is
 * unavailable or the image can't be decoded, so callers fall back to the original.
 */
export async function resizeToWebp(
  body: Buffer,
  width: number,
): Promise<{ body: Buffer; contentType: string } | null> {
  const sharp = loadSharp();
  if (!sharp) {
    return null;
  }

  try {
    const resized = await sharp(body, { failOn: 'none' })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();
    return { body: resized, contentType: 'image/webp' };
  } catch (error) {
    logger.debug(
      `Could not resize image: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
