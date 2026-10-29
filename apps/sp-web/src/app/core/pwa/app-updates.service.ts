import { DOCUMENT } from '@angular/common';
import { Injectable, inject, isDevMode, signal } from '@angular/core';

/** How often an open tab looks for a newer Stashboard. */
const CHECK_EVERY_MS = 30 * 60_000;
/** Coming back to the tab checks too, but not more often than this. */
const MIN_GAP_MS = 5 * 60_000;

/** Chrome and Edge's install prompt, held until you choose Install. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState = 'installed' | 'prompt' | 'ios' | 'manual';

/** "main-WUR5SREH.js" from a script tag or a page; changes with every release. */
export function mainBundleName(html: string): string | null {
  return /\bmain-[A-Z0-9]{8}\.js\b/.exec(html)?.[0] ?? null;
}

/**
 * The app side of being installable: registers the service worker, knows
 * when you're offline, and notices when a newer Stashboard has been deployed
 * while this tab was open.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdatesService {
  private readonly document = inject(DOCUMENT);

  readonly offline = signal(false);
  readonly updateReady = signal(false);
  /** How you can install it from here: already done, a button, or steps. */
  readonly installState = signal<InstallState>('manual');

  private installPrompt: InstallPromptEvent | null = null;

  private started = false;
  private lastCheck = 0;
  private readonly runningBundle = mainBundleName(this.document.documentElement?.outerHTML ?? '');

  start(): void {
    const view = this.document.defaultView;
    if (this.started || !view) {
      return;
    }
    this.started = true;
    this.offline.set(view.navigator.onLine === false);
    view.addEventListener('online', () => {
      this.offline.set(false);
      void this.check();
    });
    view.addEventListener('offline', () => this.offline.set(true));
    this.installState.set(this.detectInstallState(view));
    view.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installPrompt = event as InstallPromptEvent;
      this.installState.set('prompt');
    });
    view.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      this.installState.set('installed');
    });

    if (isDevMode() || !('serviceWorker' in view.navigator)) {
      return;
    }
    // After the page has loaded, so it never slows the first paint.
    const register = () => {
      view.navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    };
    if (this.document.readyState === 'complete') {
      register();
    } else {
      view.addEventListener('load', register, { once: true });
    }
    view.setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.document.addEventListener('visibilitychange', () => {
      if (this.document.visibilityState === 'visible') {
        void this.check();
      }
    });
  }

  async install(): Promise<void> {
    const prompt = this.installPrompt;
    if (!prompt) {
      return;
    }
    this.installPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    const view = this.document.defaultView;
    this.installState.set(
      choice.outcome === 'accepted' ? 'installed' : view ? this.detectInstallState(view) : 'manual',
    );
  }

  private detectInstallState(view: Window): InstallState {
    const standalone =
      view.matchMedia?.('(display-mode: standalone)').matches ||
      (view.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) {
      return 'installed';
    }
    // iPads ask for desktop sites, so they say "Macintosh"; only they have a touch screen.
    const iPadAsMac =
      /Macintosh/.test(view.navigator.userAgent) && (view.navigator.maxTouchPoints ?? 0) > 1;
    return /iPhone|iPad|iPod/.test(view.navigator.userAgent) || iPadAsMac ? 'ios' : 'manual';
  }

  reload(): void {
    this.document.defaultView?.location.reload();
  }

  /** Compares the page the server would send now with the one this tab runs. */
  async check(now = Date.now()): Promise<void> {
    if (!this.runningBundle || this.updateReady() || now - this.lastCheck < MIN_GAP_MS) {
      return;
    }
    this.lastCheck = now;
    try {
      const response = await fetch('/index.html', { cache: 'no-store' });
      if (!response.ok) {
        return;
      }
      const latest = mainBundleName(await response.text());
      if (latest && latest !== this.runningBundle) {
        this.updateReady.set(true);
      }
    } catch {
      // Offline: nothing to compare with.
    }
  }
}
