import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Observable, firstValueFrom, from, share, switchMap, timeout } from 'rxjs';

export interface AppLockStatus {
  enabled: boolean;
  locked: boolean;
  timeoutSeconds: number;
  hideInSwitcher: boolean;
  hasPin: boolean;
  passkeys: Array<{ id: string; label: string; createdAt: string; lastUsedAt: string | null }>;
}

export interface AppLockSettingsInput {
  enabled: boolean;
  pin?: string;
  timeoutSeconds: number;
  hideInSwitcher: boolean;
  currentPassword: string;
}

/** How often the open app tells the server it's still in use. */
const ACTIVE_EVERY_MS = 10_000;

/** Remembered on the device so the app-switcher cover works before the first request. */
const SHIELD_PREF_KEY = 'stashboard.hideInSwitcher';
const SHIELD_CLASS = 'app-shielded';
/** How long an unlock waits for the server before saying so. */
const UNLOCK_TIMEOUT_MS = 15_000;

/**
 * App Lock on the device: tracks whether Stashboard is locked, unlocks with a PIN
 * or Face ID, and hides the screen from the app switcher. The server enforces
 * the lock; this keeps the screen in step with it.
 */
@Injectable({ providedIn: 'root' })
export class AppLockService implements OnDestroy {
  /** Previews this paused when it covered the screen, to start again after. */
  private readonly pausedPreviews = new Set<HTMLVideoElement>();
  private readonly http = inject(HttpClient);

  readonly status = signal<AppLockStatus | null>(null);
  readonly locked = signal(false);
  readonly enabled = computed(() => this.status()?.enabled ?? false);
  /** Face ID needs WebAuthn, which iOS only allows on HTTPS. */
  readonly faceIdSupported = signal(
    typeof window !== 'undefined' &&
      window.isSecureContext &&
      typeof window.PublicKeyCredential !== 'undefined',
  );
  readonly faceIdReady = computed(
    () => this.faceIdSupported() && (this.status()?.passkeys.length ?? 0) > 0,
  );

  private hiddenAt: number | null = null;
  private started = false;
  /** The app is reloading itself; the page going away isn't leaving the app. */
  private reloading = false;
  private readonly disposers: Array<() => void> = [];
  /** Called on unlock: requests refused while locked go through again. */
  private unlockWaiters: Array<() => void> = [];
  /** Requests waiting for the unlock, one per method, address and body. */
  private readonly waitingRequests = new Map<string, Observable<unknown>>();

  /** Starts the background/foreground handling. Safe to call more than once. */
  start(): void {
    // A browser on a computer, or a phone's browser tab, never locks.
    if (this.started || typeof document === 'undefined' || !this.isPhoneApp()) {
      return;
    }
    this.started = true;

    const listen = (target: Document | Window, type: string, handler: () => void) => {
      target.addEventListener(type, handler);
      this.disposers.push(() => target.removeEventListener(type, handler));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void this.onForeground();
      }
    };

    listen(document, 'visibilitychange', () =>
      document.visibilityState === 'hidden' ? this.onBackground() : onVisible(),
    );
    listen(window, 'pagehide', () => this.onBackground());
    // Losing focus is an early signal that the app switcher is opening, so
    // cover the screen right away.
    listen(window, 'blur', () => this.raiseShield());
    listen(window, 'focus', onVisible);
    const ios = this.isIos();
    // iOS paints nothing the page changes once it starts leaving, so blur and
    // visibilitychange come too late for the switcher's snapshot. The home
    // swipe starts as a touch on the page that iOS then takes over, which
    // cancels it: cover the screen then, while it still paints. The next touch
    // means the app never left, so take the cover down again. Only on iOS:
    // Android cancels touches when a scroll starts.
    // Only time away from the app counts toward locking: while it's open on
    // screen (watching, reading, nothing tapped) it tells the server so,
    // which otherwise sees no requests and would lock it as idle.
    const active = setInterval(() => this.reportActive(), ACTIVE_EVERY_MS);
    this.disposers.push(() => clearInterval(active));
    if (ios) {
      listen(document, 'touchcancel', () => this.raiseShield());
      listen(document, 'touchstart', () => {
        if (document.visibilityState === 'visible') {
          this.lowerShield();
        }
      });
    }
  }

  ngOnDestroy(): void {
    this.disposers.splice(0).forEach((dispose) => dispose());
    this.started = false;
  }

  async refresh(): Promise<AppLockStatus | null> {
    try {
      const status = await firstValueFrom(this.http.get<AppLockStatus>('/api/app-lock/status'));
      this.applyStatus(status);
      return status;
    } catch {
      return null;
    }
  }

  /** Called when the server answers 423 (locked). */
  markLocked(): void {
    this.locked.set(true);
    this.lowerShield();
  }

  /** Resolves once the app is unlocked (straight away when it isn't locked). */
  whenUnlocked(): Promise<void> {
    if (!this.locked()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.unlockWaiters.push(resolve));
  }

  /**
   * Sends a request refused while locked again once unlocked, so the page
   * gets its data instead of an error and nothing has to reload. The same
   * request made again meanwhile (a page checking every few seconds) waits
   * on the first one, so they don't pile up.
   */
  afterUnlock<T>(key: string, send: () => Observable<T>): Observable<T> {
    const existing = this.waitingRequests.get(key) as Observable<T> | undefined;
    if (existing) {
      return existing;
    }
    const waiting = from(this.whenUnlocked()).pipe(
      switchMap(() => {
        this.waitingRequests.delete(key);
        return send();
      }),
      share(),
    );
    this.waitingRequests.set(key, waiting);
    return waiting;
  }

  async unlockWithPin(pin: string): Promise<void> {
    // Never left waiting: an answer that doesn't come is an error to retry.
    await firstValueFrom(
      this.http.post<void>('/api/app-lock/unlock/pin', { pin }).pipe(timeout(UNLOCK_TIMEOUT_MS)),
    );
    this.unlocked();
  }

  async unlockWithFaceId(): Promise<void> {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const optionsJSON = await firstValueFrom(
      this.http.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        '/api/app-lock/unlock/passkey/options',
        {},
      ),
    );
    const response = await startAuthentication({ optionsJSON });
    await firstValueFrom(this.http.post<void>('/api/app-lock/unlock/passkey', { response }));
    this.unlocked();
  }

  async registerFaceId(label?: string): Promise<void> {
    const { startRegistration } = await import('@simplewebauthn/browser');
    const optionsJSON = await firstValueFrom(
      this.http.post<Parameters<typeof startRegistration>[0]['optionsJSON']>(
        '/api/app-lock/passkeys/options',
        { label },
      ),
    );
    const response = await startRegistration({ optionsJSON });
    await firstValueFrom(this.http.post<void>('/api/app-lock/passkeys', { response }));
    await this.refresh();
  }

  async removeFaceId(id: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(`/api/app-lock/passkeys/${encodeURIComponent(id)}`),
    );
    await this.refresh();
  }

  async saveSettings(input: AppLockSettingsInput): Promise<AppLockStatus> {
    const status = await firstValueFrom(
      this.http.put<AppLockStatus>('/api/app-lock/settings', input),
    );
    this.applyStatus(status);
    return status;
  }

  /** Turns a failed unlock into words for the lock screen. */
  describeError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      // The server says how long to wait; the wait grows with each block.
      const message = (error.error as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && message) {
        return message;
      }
      if (Array.isArray(message) && typeof message[0] === 'string') {
        return message[0];
      }
      if (error.status === 429) {
        return 'Too many tries. Wait a while and try again.';
      }
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      return 'Stashboard didn’t answer. Check your connection and try again.';
    }
    if (error instanceof Error && error.name === 'NotAllowedError') {
      return 'Face ID was cancelled.';
    }
    return 'That didn’t work. Try again.';
  }

  private reportActive(): void {
    if (document.visibilityState !== 'visible' || !this.enabled() || this.locked()) {
      return;
    }
    // A refusal (locked) shows the lock screen through the interceptor.
    this.http.post<void>('/api/app-lock/active', {}).subscribe({ error: () => undefined });
  }

  // ---------- background / foreground ----------

  /**
   * Reloads the page for the app's own reasons (switching catalogs, say).
   * The page unloading looks like leaving the app, which with "Immediately"
   * would lock it: this one doesn't count.
   */
  reloadTo(url: string): void {
    this.reloading = true;
    window.location.assign(url);
  }

  /** Reloads this page (pull to refresh, an update, a restore) without locking the app. */
  reload(): void {
    this.reloading = true;
    window.location.reload();
  }

  private onBackground(): void {
    if (this.reloading) {
      return;
    }
    this.raiseShield();
    this.hiddenAt = Date.now();
    const status = this.status();
    if (status?.enabled && status.timeoutSeconds === 0 && !this.locked()) {
      // Lock on the server as the app leaves; beacons survive the app closing.
      try {
        navigator.sendBeacon?.('/api/app-lock/lock');
      } catch {
        // The server's idle timeout still locks it.
      }
      this.locked.set(true);
    }
  }

  private async onForeground(): Promise<void> {
    const status = this.status();
    if (status?.enabled && this.hiddenAt !== null && !this.locked()) {
      const awaySeconds = (Date.now() - this.hiddenAt) / 1000;
      if (awaySeconds >= status.timeoutSeconds) {
        this.locked.set(true);
        void firstValueFrom(this.http.post<void>('/api/app-lock/lock', {})).catch(() => undefined);
      }
    }
    const cameBack = this.hiddenAt !== null;
    this.hiddenAt = null;
    // On iOS, focus can come back mid-swipe while the switcher is still
    // opening, before it has taken its picture: taking the cover down then
    // shows the page in the switcher. There it comes down only once the app
    // was really away, or at the next touch (the swipe was abandoned).
    // The lock screen is opaque, so the cover can come down either way.
    if (cameBack || this.locked() || !this.isIos()) {
      this.lowerShield();
    }
    if (status?.enabled && !this.locked()) {
      // Ask the server too; it may have locked on its own idle timer.
      const fresh = await this.refresh();
      if (fresh?.locked) {
        this.locked.set(true);
      }
    }
  }

  private unlocked(): void {
    this.locked.set(false);
    this.hiddenAt = null;
    const status = this.status();
    if (status) {
      this.status.set({ ...status, locked: false });
    }
    // Requests refused while locked go through now.
    this.unlockWaiters.splice(0).forEach((resolve) => resolve());
  }

  private applyStatus(status: AppLockStatus): void {
    this.status.set(status);
    this.locked.set(status.locked);
    try {
      localStorage.setItem(SHIELD_PREF_KEY, status.hideInSwitcher ? '1' : '0');
    } catch {
      // ignore
    }
  }

  private shieldWanted(): boolean {
    const status = this.status();
    if (status) {
      return status.hideInSwitcher || status.enabled;
    }
    try {
      return localStorage.getItem(SHIELD_PREF_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Synchronous DOM change, so it lands before iOS takes the switcher snapshot.
   * Never over the lock screen: it hides the app already, and iOS cancels
   * touches on it (a key turning disabled mid-tap), which would leave a blank
   * cover over the keypad.
   */
  private raiseShield(): void {
    if (this.locked()) {
      return;
    }
    if (this.shieldWanted()) {
      document.documentElement.classList.add(SHIELD_CLASS);
      this.pausePreviews();
    }
  }

  private lowerShield(): void {
    document.documentElement.classList.remove(SHIELD_CLASS);
    this.resumePreviews();
  }

  /**
   * Muted previews (card clips, the swipe feed) keep painting frames as the
   * app leaves, which can land in the switcher's picture: stop them while
   * covered, and start them again after. The main player is left alone.
   */
  private pausePreviews(): void {
    for (const video of Array.from(document.querySelectorAll('video'))) {
      if (video.muted && !video.paused) {
        video.pause();
        this.pausedPreviews.add(video);
      }
    }
  }

  private resumePreviews(): void {
    for (const video of this.pausedPreviews) {
      if (video.isConnected && video.paused) {
        void video.play()?.catch?.(() => undefined);
      }
    }
    this.pausedPreviews.clear();
  }

  private isIos(): boolean {
    // iPads ask for desktop sites and say "Macintosh", but have a touch screen.
    return (
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
    );
  }

  /** Installed to a phone's home screen: the only place App Lock applies. */
  isPhoneApp(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    return Boolean(standalone && touch);
  }
}
