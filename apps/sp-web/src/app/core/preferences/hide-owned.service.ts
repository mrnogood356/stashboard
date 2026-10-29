import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HiddenContentService } from '../api/hidden-content.service';
import type { SceneStatus } from '../api/discover.types';

/** This device's copy of the setting, so lists don't flicker while it loads. */
const CACHE_KEY = 'sp-hide-owned';
/** Set once the old per-device switch has been carried over to the server. */
const MOVED_KEY = 'sp-hide-owned-moved';

/**
 * Settings → Hidden → "Scenes you already have": one setting, saved with
 * the rest of the hidden list, that leaves your library's scenes out of
 * catalog lists (Scenes, a performer's or studio's scenes, Search).
 */
@Injectable({ providedIn: 'root' })
export class HideOwnedService {
  private readonly hidden = inject(HiddenContentService);
  private readonly cached = signal(read(CACHE_KEY) === '1');

  readonly hideOwned = computed(() => this.hidden.settings()?.hideOwned ?? this.cached());

  constructor() {
    this.hidden.ensureLoaded();
    effect(() => {
      const settings = this.hidden.settings();
      if (!settings) {
        return;
      }
      // It used to be a switch on each list, kept on the device; carry it over once.
      if (!settings.hideOwned && this.cached() && read(MOVED_KEY) !== '1') {
        write(MOVED_KEY, '1');
        this.hidden.saveSettings({ ...settings, hideOwned: true }).subscribe({
          error: () => undefined,
        });
        return;
      }
      write(MOVED_KEY, '1');
      write(CACHE_KEY, settings.hideOwned ? '1' : '0');
    });
  }

  /** The scenes to show: all of them, or the ones you don't have yet. */
  filter<T extends { status?: Pick<SceneStatus, 'state'> | null }>(items: readonly T[]): T[] {
    return this.hideOwned() ? items.filter((item) => !isOwned(item)) : [...items];
  }
}

/** In your library already. */
export function isOwned(item: { status?: Pick<SceneStatus, 'state'> | null }): boolean {
  return item.status?.state === 'AVAILABLE';
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing: the server keeps the setting anyway.
  }
}
