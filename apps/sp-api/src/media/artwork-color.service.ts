import { Injectable, Logger } from '@nestjs/common';
import { IntegrationType } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { allowedImageHost, vividColor } from './artwork-color.util';

const SAMPLE = 32;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const CACHE_LIMIT = 500;

/**
 * Accent "Match the artwork" for pictures the browser can't read itself
 * (another site's, without CORS): fetched here from the catalog's own sites,
 * shrunk, and only the colour handed back.
 */
@Injectable()
export class ArtworkColorService {
  private readonly logger = new Logger(ArtworkColorService.name);
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaService) {}

  async colorOf(rawUrl: string): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    const key = url.toString();
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? null;
    }
    if (!allowedImageHost(url, await this.catalogHosts())) {
      return null;
    }
    const color = await this.sample(url).catch((error: unknown) => {
      this.logger.debug(
        `Couldn't read the colour of ${url.host}: ${(error as Error)?.message}`,
      );
      return null;
    });
    this.cache.set(key, color);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    return color;
  }

  private async catalogHosts(): Promise<string[]> {
    const rows = await this.prisma.integrationConfig.findMany({
      where: {
        type: { in: [IntegrationType.STASHDB, IntegrationType.FANSDB] },
      },
      select: { baseUrl: true },
    });
    return rows.flatMap((row) => {
      try {
        return row.baseUrl ? [new URL(row.baseUrl).hostname] : [];
      } catch {
        return [];
      }
    });
  }

  private async sample(url: URL): Promise<string | null> {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      return null;
    }
    const pixels = await sharp(bytes)
      .resize(SAMPLE, SAMPLE, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();
    return vividColor(pixels, 3);
  }
}
