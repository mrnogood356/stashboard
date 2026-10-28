import { Injectable, signal } from '@angular/core';
import type { SceneStatus } from '../api/discover.types';

/**
 * "Hide ones I have" for catalog lists (Scenes, a performer's or studio's
 * scenes, Search): one switch for all of them, remembered on this device.
 */
@Injectable({ providedIn: 'root' })
export class HideOwnedService {
  private static readonly STORAGE_KEY = 'sp-hide-owned';

  private readonly state = signal(HideOwnedService.read());
  readonly hideOwned = this.state.asReadonly();

  set(hide: boolean): void {
    this.state.set(hide);
    try {
      window.localStorage.setItem(HideOwnedService.STORAGE_KEY, hide ? '1' : '0');
    } catch {
      // Private browsing: kept for this visit only.
    }
  }

  /** The scenes to show: all of them, or the ones you don't have yet. */
  filter<T extends { status?: Pick<SceneStatus, 'state'> | null }>(items: readonly T[]): T[] {
    return this.state() ? items.filter((item) => !isOwned(item)) : [...items];
  }

  private static read(): boolean {
    try {
      return window.localStorage.getItem(HideOwnedService.STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }
}

/** In your library already. */
export function isOwned(item: { status?: Pick<SceneStatus, 'state'> | null }): boolean {
  return item.status?.state === 'AVAILABLE';
}
