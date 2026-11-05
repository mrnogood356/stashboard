import { Logger } from '@nestjs/common';
import { HomeRailKey, type HomeRail } from '@prisma/client';
import type { HomeRailContentDto } from './dto/home-rail-content.dto';

/** Answered from memory, without asking again, for this long. */
export const FRESH_MS = 60_000;
/** After that, still answered from memory while a fresh copy loads, up to this age. */
export const STALE_MS = 15 * 60_000;

/** Rows that must always be current: your spot in a scene changes as you watch. */
const NEVER_KEPT: ReadonlySet<HomeRailKey> = new Set([
  HomeRailKey.CONTINUE_WATCHING,
]);

interface Entry {
  value: HomeRailContentDto;
  at: number;
  /** The row's settings it was built with: a changed row is built again. */
  stamp: string;
}

/**
 * Home's rows, kept on the server so Home opens at once: a row up to a
 * minute old is answered as is; an older one (up to 15 minutes) is answered
 * straight away and built again behind it. Rows that failed or came back
 * with a message aren't kept.
 */
export class HomeRowCache {
  private readonly logger = new Logger('HomeRowCache');
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<HomeRailContentDto>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * `fresh` brings a kept answer up to date cheaply before it's sent (a
   * scene's request status, say); a failure there sends it as kept.
   */
  async get(
    rail: HomeRail,
    load: () => Promise<HomeRailContentDto>,
    fresh: (value: HomeRailContentDto) => Promise<HomeRailContentDto> = (
      value,
    ) => Promise.resolve(value),
    /** Anything else the row depends on (the hidden studios and tags, say). */
    extra = '',
  ): Promise<HomeRailContentDto> {
    if (rail.key && NEVER_KEPT.has(rail.key)) {
      return load();
    }
    const stamp = stampOf(rail) + extra;
    const entry = this.entries.get(rail.id);
    const age = entry ? this.now() - entry.at : Infinity;
    if (entry && entry.stamp === stamp && age < STALE_MS) {
      if (age >= FRESH_MS) {
        void this.refresh(rail.id, stamp, load).catch((error: unknown) =>
          this.logger.debug(
            `Home row ${rail.id} refresh failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      return fresh(entry.value).catch(() => entry.value);
    }
    return this.refresh(rail.id, stamp, load);
  }

  clear(): void {
    this.entries.clear();
  }

  /** One build per row at a time; whoever asks meanwhile shares it. */
  private refresh(
    id: string,
    stamp: string,
    load: () => Promise<HomeRailContentDto>,
  ): Promise<HomeRailContentDto> {
    const running = this.loading.get(id);
    if (running) {
      return running;
    }
    const run = load()
      .then((value) => {
        if (value.message === null || value.message === undefined) {
          this.entries.set(id, { value, at: this.now(), stamp });
        } else {
          this.entries.delete(id);
        }
        return value;
      })
      .finally(() => this.loading.delete(id));
    this.loading.set(id, run);
    return run;
  }
}

function stampOf(rail: HomeRail): string {
  return JSON.stringify([
    rail.key,
    rail.source,
    rail.config,
    rail.updatedAt?.valueOf?.() ?? null,
  ]);
}

/**
 * The hidden studios, tags and words as text, so a change to any of them
 * builds the rows again. Sets and patterns don't survive plain JSON, which
 * writes both as {}.
 */
export function rulesStamp(rules: unknown): string {
  return JSON.stringify(rules ?? null, (_key, value: unknown) => {
    if (value instanceof Set) {
      return [...(value as Set<unknown>)].map(String).sort();
    }
    if (value instanceof RegExp) {
      return `/${value.source}/${value.flags}`;
    }
    if (value instanceof Map) {
      return [...(value as Map<unknown, unknown>).entries()];
    }
    return value;
  });
}
