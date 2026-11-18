import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, Signal, computed, effect, inject, signal, untracked } from '@angular/core';
import { AppLockService } from '../app-lock/app-lock.service';

export type ImageObscurationMode = 'clear' | 'obscured';

@Injectable({
  providedIn: 'root',
})
export class ImageObscurationService {
  private static readonly STORAGE_KEY = 'sp-images';

  private readonly document = inject(DOCUMENT);
  private readonly http = inject(HttpClient);
  private readonly appLock = inject(AppLockService);
  private readonly modeState = signal<ImageObscurationMode>('clear');
  /** The server's copy has been read (installed phone app only). */
  private synced = false;
  /** Changed on this device since it opened: that wins over the server's copy. */
  private changedHere = false;

  readonly mode: Signal<ImageObscurationMode> = this.modeState.asReadonly();
  readonly isObscured = computed(() => this.modeState() === 'obscured');

  constructor() {
    this.initializeMode();
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
    // Never sent yet, or changed here before the server answered: this
    // device's setting goes up.
    if (stored === null || this.changedHere) {
      this.saveToServer(this.modeState());
      return;
    }
    const mode: ImageObscurationMode = stored ? 'obscured' : 'clear';
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
    this.http
      .put<void>('/api/app-lock/images', { obscured: mode === 'obscured' })
      .subscribe({ error: () => undefined });
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
