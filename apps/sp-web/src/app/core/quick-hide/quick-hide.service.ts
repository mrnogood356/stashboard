import { DOCUMENT } from '@angular/common';
import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { ImageObscurationService } from '../preferences/image-obscuration.service';

/** On this device only: someone else's phone shouldn't change yours. */
export const QUICK_HIDE_KEY = 'sp-quick-hide';

export interface QuickHideSettings {
  /** Esc twice on a keyboard, or three quick taps on a touch screen. */
  gesture: boolean;
  /** Images start obscured every time Stashboard opens. */
  obscureOnOpen: boolean;
  /** Obscure images after this many minutes without a touch or key; 0 is never. */
  idleMinutes: number;
}

export const QUICK_HIDE_DEFAULTS: QuickHideSettings = {
  gesture: true,
  obscureOnOpen: false,
  idleMinutes: 0,
};

export const IDLE_OPTIONS = [
  { value: 0, label: 'Never' },
  { value: 2, label: 'After 2 minutes' },
  { value: 5, label: 'After 5 minutes' },
  { value: 15, label: 'After 15 minutes' },
  { value: 30, label: 'After 30 minutes' },
];

/** Two Escs or three taps must land within this long. */
const GESTURE_WINDOW_MS = 600;
/** Taps further apart than this are separate taps, not one gesture. */
const TAP_SLOP_PX = 60;
const IDLE_CHECK_MS = 15_000;

/**
 * Quick hide: one gesture covers the screen, pauses anything playing and
 * obscures images; a tap brings the app back as it was. Also obscures
 * images on open or after a while idle, if asked.
 */
@Injectable({ providedIn: 'root' })
export class QuickHideService implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly obscuration = inject(ImageObscurationService);

  readonly settings = signal<QuickHideSettings>(readSettings());
  /** The cover is up. */
  readonly hidden = signal(false);

  private started = false;
  private blurredBefore = false;
  private lastActivity = Date.now();
  private escAt = 0;
  private taps: Array<{ at: number; x: number; y: number }> = [];
  /** Takes the listeners and the idle timer away again. */
  private readonly stopListening = new AbortController();
  private idleTimer: number | null = null;

  start(): void {
    if (this.started || typeof window === 'undefined') {
      return;
    }
    this.started = true;
    if (this.settings().obscureOnOpen) {
      this.obscuration.setMode('obscured');
    }
    const win = this.document.defaultView ?? window;
    const signal = this.stopListening.signal;
    win.addEventListener('keydown', (event) => this.onKey(event), { capture: true, signal });
    win.addEventListener('pointerdown', (event) => this.onPointer(event), {
      capture: true,
      passive: true,
      signal,
    });
    for (const type of ['pointermove', 'wheel', 'scroll'] as const) {
      win.addEventListener(type, () => this.touch(), { capture: true, passive: true, signal });
    }
    this.idleTimer = win.setInterval(() => this.checkIdle(), IDLE_CHECK_MS);
  }

  /**
   * The app keeps it for as long as it's open; a test's app doesn't, and a
   * hidden one left listening would swallow the next one's keys.
   */
  ngOnDestroy(): void {
    this.stopListening.abort();
    if (this.idleTimer !== null) {
      (this.document.defaultView ?? window).clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  save(settings: QuickHideSettings): void {
    this.settings.set(settings);
    try {
      localStorage.setItem(QUICK_HIDE_KEY, JSON.stringify(settings));
    } catch {
      // Private mode: it lasts until the tab closes.
    }
  }

  /** Cover the screen now. */
  hide(): void {
    if (!this.hidden()) {
      // How pictures were before, so coming back puts them back as they were.
      this.blurredBefore = this.obscuration.isObscured();
    }
    this.obscuration.setMode('obscured');
    for (const media of Array.from(this.document.querySelectorAll('video, audio'))) {
      (media as HTMLMediaElement).pause?.();
    }
    this.hidden.set(true);
  }

  /**
   * Back to the app, with pictures as they were before hiding: clear if they
   * were clear, still blurred if they were blurred already.
   */
  reveal(): void {
    this.hidden.set(false);
    if (!this.blurredBefore) {
      this.obscuration.setMode('clear');
    }
    this.touch();
  }

  /** For tests: the idle check, without waiting for its timer. */
  checkIdle(now = Date.now()): void {
    const minutes = this.settings().idleMinutes;
    if (minutes > 0 && now - this.lastActivity >= minutes * 60_000) {
      this.obscuration.setMode('obscured');
      this.lastActivity = now;
    }
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private onKey(event: KeyboardEvent): void {
    this.touch();
    // Nothing under the cover hears a key (Space would play the video). On
    // the focused cover itself, Enter or Space still bring the app back.
    if (this.hidden()) {
      event.stopPropagation();
      return;
    }
    if (!this.settings().gesture || event.key !== 'Escape' || event.repeat) {
      return;
    }
    const now = Date.now();
    if (now - this.escAt <= GESTURE_WINDOW_MS) {
      this.escAt = 0;
      this.hide();
      return;
    }
    this.escAt = now;
  }

  private onPointer(event: PointerEvent): void {
    this.touch();
    if (!this.settings().gesture || event.pointerType !== 'touch' || this.hidden()) {
      return;
    }
    const now = Date.now();
    const first = this.taps[0];
    if (
      first &&
      (now - first.at > GESTURE_WINDOW_MS ||
        Math.hypot(event.clientX - first.x, event.clientY - first.y) > TAP_SLOP_PX)
    ) {
      this.taps = [];
    }
    this.taps.push({ at: now, x: event.clientX, y: event.clientY });
    if (this.taps.length >= 3) {
      this.taps = [];
      this.hide();
    }
  }
}

function readSettings(): QuickHideSettings {
  try {
    const stored = JSON.parse(
      localStorage.getItem(QUICK_HIDE_KEY) ?? 'null',
    ) as Partial<QuickHideSettings> | null;
    if (stored && typeof stored === 'object') {
      return {
        gesture: stored.gesture !== false,
        obscureOnOpen: stored.obscureOnOpen === true,
        idleMinutes: IDLE_OPTIONS.some((option) => option.value === stored.idleMinutes)
          ? (stored.idleMinutes as number)
          : 0,
      };
    }
  } catch {
    // Unreadable: the defaults.
  }
  return { ...QUICK_HIDE_DEFAULTS };
}
