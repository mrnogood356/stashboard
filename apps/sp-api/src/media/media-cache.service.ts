import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

export interface CachedMediaAsset {
  body: Buffer;
  contentType: string | null;
}

interface CachedMediaMeta {
  contentType: string | null;
  storedAt: number;
}

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_MAX_MB = 512;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Small on-disk cache for images proxied from Stash. Each image normally costs
 * a GraphQL lookup plus a download from Stash; caching it in the app data
 * volume makes repeat views instant and takes load off Stash.
 */
@Injectable()
export class MediaCacheService {
  private readonly logger = new Logger(MediaCacheService.name);
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly inFlight = new Map<
    string,
    Promise<CachedMediaAsset | null>
  >();
  private enabled: boolean;
  private ready: Promise<void> | null = null;
  private lastPruneAt = 0;

  constructor() {
    const appDataDir =
      process.env.APP_DATA_DIR?.trim() || '/var/lib/stashboard';
    this.dir =
      process.env.MEDIA_CACHE_DIR?.trim() || join(appDataDir, 'media-cache');
    this.ttlMs =
      readPositiveNumber(process.env.MEDIA_CACHE_TTL_HOURS, DEFAULT_TTL_HOURS) *
      3_600_000;
    this.maxBytes =
      readPositiveNumber(process.env.MEDIA_CACHE_MAX_MB, DEFAULT_MAX_MB) *
      1024 *
      1024;
    // Off in unit tests unless a test points it at its own directory.
    this.enabled =
      process.env.MEDIA_CACHE_DISABLED !== 'true' &&
      (process.env.NODE_ENV !== 'test' ||
        !!process.env.MEDIA_CACHE_DIR?.trim());
  }

  /**
   * Returns the cached asset for this key, or runs `load`, stores its result and
   * returns it. Concurrent requests for the same image share one load.
   */
  async getOrLoad(
    namespace: string,
    id: string,
    load: () => Promise<CachedMediaAsset | null>,
  ): Promise<CachedMediaAsset | null> {
    if (!this.enabled || !(await this.ensureReady())) {
      return load();
    }

    const key = cacheKey(namespace, id);
    // Join a request already in progress before any disk I/O, so concurrent
    // requests for one image always share a single load.
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      const cached = await this.read(key);
      if (cached) {
        this.logger.verbose(`Image cache hit (${namespace}) ${key}`);
        return cached;
      }
      this.logger.verbose(`Image cache miss (${namespace}) ${key}`);
      const asset = await load();
      if (asset) {
        await this.write(key, asset);
      }
      return asset;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    return promise;
  }

  private async ensureReady(): Promise<boolean> {
    this.ready ??= mkdir(this.dir, { recursive: true, mode: 0o700 }).then(
      () => undefined,
      (error: unknown) => {
        this.enabled = false;
        this.logger.warn(
          `Image cache disabled; cannot use ${this.dir}: ${errorMessage(error)}`,
        );
      },
    );
    await this.ready;
    return this.enabled;
  }

  private async read(key: string): Promise<CachedMediaAsset | null> {
    try {
      const meta = JSON.parse(
        await readFile(this.metaPath(key), 'utf8'),
      ) as CachedMediaMeta;
      if (Date.now() - meta.storedAt > this.ttlMs) {
        return null;
      }

      return {
        body: await readFile(this.bodyPath(key)),
        contentType: meta.contentType,
      };
    } catch {
      return null;
    }
  }

  private async write(key: string, asset: CachedMediaAsset): Promise<void> {
    try {
      const meta: CachedMediaMeta = {
        contentType: asset.contentType,
        storedAt: Date.now(),
      };
      // Write to temp files and rename so a reader never sees a half-written image.
      const suffix = `.${process.pid}.${Date.now()}.tmp`;
      await writeFile(this.bodyPath(key) + suffix, asset.body);
      await writeFile(this.metaPath(key) + suffix, JSON.stringify(meta));
      await rename(this.bodyPath(key) + suffix, this.bodyPath(key));
      await rename(this.metaPath(key) + suffix, this.metaPath(key));
    } catch (error) {
      this.logger.debug(`Could not cache image ${key}: ${errorMessage(error)}`);
      return;
    }

    void this.pruneIfDue();
  }

  /** Drops expired entries, then the oldest ones until the cache is under its size cap. */
  private async pruneIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAt = now;

    try {
      const files = (await readdir(this.dir)).filter((name) =>
        name.endsWith('.bin'),
      );
      const entries = await Promise.all(
        files.map(async (name) => {
          const info = await stat(join(this.dir, name)).catch(() => null);
          return info
            ? { key: name.slice(0, -4), size: info.size, mtime: info.mtimeMs }
            : null;
        }),
      );
      const live = entries
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => a.mtime - b.mtime);

      let total = live.reduce((sum, entry) => sum + entry.size, 0);
      let removed = 0;
      for (const entry of live) {
        const expired = now - entry.mtime > this.ttlMs;
        if (!expired && total <= this.maxBytes) {
          continue;
        }
        await this.remove(entry.key);
        total -= entry.size;
        removed += 1;
      }
      this.logger.debug(
        `Image cache pruned: ${removed} of ${live.length} image(s) removed, ${Math.round(total / 1024 / 1024)} MB left.`,
      );
    } catch (error) {
      this.logger.debug(`Image cache prune failed: ${errorMessage(error)}`);
    }
  }

  private async remove(key: string): Promise<void> {
    await rm(this.bodyPath(key), { force: true });
    await rm(this.metaPath(key), { force: true });
  }

  private bodyPath(key: string): string {
    return join(this.dir, `${key}.bin`);
  }

  private metaPath(key: string): string {
    return join(this.dir, `${key}.json`);
  }
}

function cacheKey(namespace: string, id: string): string {
  return createHash('sha256').update(`${namespace}\u0000${id}`).digest('hex');
}

function readPositiveNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
