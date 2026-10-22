import { Injectable } from '@angular/core';
import { SceneExplorerItem } from '../../core/api/discover.types';

/** What the Scenes page had loaded, and how far down it was scrolled. */
export interface ScenesSearchSnapshot {
  items: SceneExplorerItem[];
  total: number;
  page: number;
  hasMore: boolean;
  /** Scenes Settings → Hidden content left out of these pages. */
  hidden?: number;
  scrollY: number;
  unknownTags?: string[];
  uncheckedTags?: string[];
}

/**
 * Keeps the last few Scenes searches in memory, keyed by their URL, so going
 * back from a scene puts you where you were instead of at the top of page one.
 */
@Injectable({ providedIn: 'root' })
export class ScenesSearchCacheService {
  private static readonly MAX_ENTRIES = 10;
  /** Older than this, the catalog may have moved on; load fresh instead. */
  private static readonly TTL_MS = 30 * 60_000;

  private readonly entries = new Map<string, { savedAt: number; snapshot: ScenesSearchSnapshot }>();

  save(key: string, snapshot: ScenesSearchSnapshot): void {
    this.entries.delete(key);
    this.entries.set(key, { savedAt: Date.now(), snapshot });
    while (this.entries.size > ScenesSearchCacheService.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  get(key: string): ScenesSearchSnapshot | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.savedAt > ScenesSearchCacheService.TTL_MS) {
      this.entries.delete(key);
      return null;
    }

    return entry.snapshot;
  }

  clear(): void {
    this.entries.clear();
  }
}
