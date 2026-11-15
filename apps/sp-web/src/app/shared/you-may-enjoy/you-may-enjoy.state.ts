import { Injectable, signal } from '@angular/core';
import type { Suggestion } from '../../core/api/suggestions.service';
import type { RecentPick } from '../filter-bar/recent-picks';

/** What a You may enjoy list showed, to put back when you return to it. */
export interface EnjoySnapshot {
  /** The categories it was picked for, as `tagKey()` writes them. */
  tags: string;
  items: Suggestion[];
  message: string | null;
  expanded: boolean;
  scrollY: number;
  savedAt: number;
}

const STORAGE_KEY = 'stashboard.enjoy.tags';
/** Older than this, the list may have moved on; ask again. */
const SNAPSHOT_TTL_MS = 30 * 60_000;

/**
 * Shared by the section on Requests and the page of its own: the categories
 * picked (kept in this browser), and the last list each showed, so going back
 * from a scene finds the same picks where you left them.
 */
@Injectable({ providedIn: 'root' })
export class YouMayEnjoyState {
  readonly tags = signal<RecentPick[]>(readTags());
  private readonly snapshots = new Map<string, EnjoySnapshot>();

  setTags(tags: RecentPick[]): void {
    this.tags.set(tags);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(tags));
    } catch {
      // Not kept past this visit; the picks still apply now.
    }
  }

  tagKey(): string {
    return this.tags()
      .map((tag) => tag.id)
      .sort()
      .join(',');
  }

  save(where: 'page' | 'section', snapshot: Omit<EnjoySnapshot, 'savedAt'>): void {
    this.snapshots.set(where, { ...snapshot, savedAt: Date.now() });
  }

  /** The last list here, if it's recent and for the same categories. */
  restore(where: 'page' | 'section'): EnjoySnapshot | null {
    const snapshot = this.snapshots.get(where);
    if (
      !snapshot ||
      snapshot.tags !== this.tagKey() ||
      Date.now() - snapshot.savedAt > SNAPSHOT_TTL_MS
    ) {
      return null;
    }
    return snapshot;
  }
}

function readTags(): RecentPick[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (tag): tag is RecentPick =>
            !!tag &&
            typeof (tag as RecentPick).id === 'string' &&
            typeof (tag as RecentPick).name === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
