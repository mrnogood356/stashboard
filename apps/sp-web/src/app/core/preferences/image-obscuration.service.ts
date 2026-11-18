import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, Signal, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subject, catchError, concatMap, of } from 'rxjs';
import { AppLockService } from '../app-lock/app-lock.service';

export type ImageObscurationMode = 'clear' | 'obscured';

@Injectable({
  providedIn: 'root',
})
export class ImageObscurationService {
  private static readonly STORAGE_KEY = 'sp-images';
  /** A change the server hasn't confirmed yet: sent again before its copy is believed. */
  private static readonly UNSENT_KEY = 'sp-images-unsent';

  private readonly document = inject(DOCUMENT);
  private readonly http = inject(HttpClient);
  private readonly appLock = inject(AppLockService);
  private readonly modeState = signal<ImageObscurationMode>('clear');
  /** The server's copy has been read (installed phone app only). */
  private synced = false;
  /** Changed on this device since it opened: that wins over the server's copy. */
  private changedHere = false;
  /** Saves go one at a time, so the last choice is the one the server keeps. */
  private readonly saves = new Subject<ImageObscurationMode>();

  readonly mode: Signal<ImageObscurationMode> = this.modeState.asReadonly();
  /**
   * The server's copy (installed phone app only): not read yet, a save on
   * its way, saved, or the last save failed (sent again on the next open).
   */
  readonly serverCopy = signal<'unknown' | 'saving' | 'saved' | 'failed'>('unknown');
  readonly isObscured = computed(() => this.modeState() === 'obscured');

  constructor() {
    this.initializeMode();
    this.saves
      .pipe(
        concatMap((mode) =>
          this.http
            .put<void>('/api/app-lock/images', { obscured: mode === 'obscured' })
            .pipe(catchError(() => of('failed' as const))),
        ),
      )
      .subscribe((result) => {
        this.queued = Math.max(0, this.queued - 1);
        // Only once nothing newer is on its way does the change count as sent.
        if (this.queued === 0) {
          if (result !== 'failed') {
            this.removeStored(ImageObscurationService.UNSENT_KEY);
          }
          this.serverCopy.set(result === 'failed' ? 'failed' : 'saved');
        }
      });
    // The installed phone app: iOS can clear the app's own storage (and the
    // eye with it), so the server keeps a copy, read once the app's status
    // comes in.
    effect(() => {
      const status = this.appLock.status();
      if (status && !this.synced && this.appLock.isPhoneApp()) {
        untracked(() => this.syncWithServer(status.imagesObscured ?? null));
      }
    });
  }

  toggle(): void {
    this.setMode(this.modeState() === 'obscured' ? 'clear' : 'obscured');
  }

  setMode(mode: ImageObscurationMode): void {
    this.changedHere = true;
    this.modeState.set(mode);
    this.persistMode(mode);
    this.applyMode(mode);
    if (this.synced) {
      this.saveToServer(mode);
    }
  }

  private syncWithServer(stored: boolean | null): void {
    this.synced = true;
    // Never sent yet, changed here before the server answered, or a change
    // the server never got: this device's setting goes up.
    if (
      stored === null ||
      this.changedHere ||
      this.readStored(ImageObscurationService.UNSENT_KEY)
    ) {
      this.saveToServer(this.modeState());
      return;
    }
    const mode: ImageObscurationMode = stored ? 'obscured' : 'clear';
    this.serverCopy.set('saved');
    if (mode !== this.modeState()) {
      this.modeState.set(mode);
      this.persistMode(mode);
      this.applyMode(mode);
    }
  }

  private saveToServer(mode: ImageObscurationMode): void {
    if (!this.appLock.isPhoneApp()) {
      return;
    }
    // Marked unsent until the server confirms, so a save that fails is sent
    // again next time instead of the server's older copy winning.
    this.writeStored(ImageObscurationService.UNSENT_KEY, '1');
    this.serverCopy.set('saving');
    this.queued += 1;
    this.saves.next(mode);
  }

  /** Saves sent and not yet answered. */
  private queued = 0;

  private readStored(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStored(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Nowhere to keep it: it's sent again only while the app stays open.
    }
  }

  private removeStored(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to remove.
    }
  }

  private initializeMode(): void {
    const mode = this.readStoredMode();
    this.modeState.set(mode);
    this.applyMode(mode);
  }

  private applyMode(mode: ImageObscurationMode): void {
    const root = this.document.documentElement;

    if (mode === 'obscured') {
      root.setAttribute('data-images', 'obscured');
    } else {
      root.removeAttribute('data-images');
    }
  }

  private readStoredMode(): ImageObscurationMode {
    if (typeof window === 'undefined') {
      return 'clear';
    }

    try {
      return window.localStorage.getItem(ImageObscurationService.STORAGE_KEY) === 'obscured'
        ? 'obscured'
        : 'clear';
    } catch {
      return 'clear';
    }
  }

  private persistMode(mode: ImageObscurationMode): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(ImageObscurationService.STORAGE_KEY, mode);
    } catch {
      // Private mode or full storage: the server's copy still has it.
    }
  }
}
