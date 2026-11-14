import { DOCUMENT } from '@angular/common';
import { Component, NgZone, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

/** How far to pull before letting go reloads. */
export const PULL_TO_RELOAD_PX = 80;
/** Pages where a downward swipe means something else. */
const OWN_GESTURES = ['/watch', '/feed'];

/**
 * Pull down from the top of a page to reload it, in the app on a phone's
 * home screen (a browser has its own). Not while a sheet is open, in the
 * player or the swipe feed, or when the swipe is more sideways than down.
 */
@Component({
  selector: 'app-pull-to-refresh',
  template: `
    @if (pulled() > 0) {
      <div
        class="pull"
        role="status"
        [class.ready]="pulled() >= threshold"
        [style.transform]="'translate(-50%, ' + (Math.min(pulled(), threshold * 1.4) - 44) + 'px)'"
      >
        <i
          class="pi"
          [class.pi-arrow-down]="!reloading()"
          [class.pi-spinner]="reloading()"
          [class.pi-spin]="reloading()"
          [style.transform]="'rotate(' + (pulled() >= threshold ? 180 : 0) + 'deg)'"
          aria-hidden="true"
        ></i>
        <span class="visually-hidden">{{
          reloading() ? 'Reloading' : pulled() >= threshold ? 'Let go to reload' : 'Pull to reload'
        }}</span>
      </div>
    }
  `,
  styles: `
    /* Takes no place in the page's layout: only its arrow shows, fixed on top. */
    :host {
      display: contents;
    }
    .pull {
      position: fixed;
      top: env(safe-area-inset-top);
      left: 50%;
      z-index: 1200;
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 50%;
      background: var(--surface-elevated, var(--surface-1));
      color: var(--text-muted);
      box-shadow: 0 6px 18px rgb(0 0 0 / 30%);
      pointer-events: none;
    }
    .pull.ready {
      color: var(--accent);
    }
    .pull .pi {
      transition: transform 0.15s ease;
    }
  `,
})
export class PullToRefreshComponent implements OnInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private readonly router = inject(Router);

  protected readonly Math = Math;
  protected readonly threshold = PULL_TO_RELOAD_PX;
  protected readonly pulled = signal(0);
  protected readonly reloading = signal(false);

  private start: { x: number; y: number } | null = null;
  private readonly listeners: Array<() => void> = [];

  ngOnInit(): void {
    const view = this.document.defaultView;
    if (!view || !this.inHomeScreenApp(view)) {
      return;
    }
    const on = <K extends keyof WindowEventMap>(
      type: K,
      handler: (event: WindowEventMap[K]) => void,
    ) => {
      view.addEventListener(type, handler as EventListener, { passive: true });
      this.listeners.push(() => view.removeEventListener(type, handler as EventListener));
    };
    this.zone.runOutsideAngular(() => {
      on('touchstart', (event) => this.onStart(event, view));
      on('touchmove', (event) => this.onMove(event));
      on('touchend', () => this.onEnd(view));
      on('touchcancel', () => this.reset());
    });
  }

  ngOnDestroy(): void {
    this.listeners.forEach((remove) => remove());
  }

  private inHomeScreenApp(view: Window): boolean {
    return (
      view.matchMedia?.('(display-mode: standalone)').matches === true ||
      (view.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  }

  private onStart(event: TouchEvent, view: Window): void {
    if (this.reloading()) {
      return;
    }
    const touch = event.touches[0];
    const path = this.router.url.split('?')[0];
    if (
      event.touches.length !== 1 ||
      !touch ||
      view.scrollY > 0 ||
      this.document.body.classList.contains('app-sheet-open') ||
      // The page itself or anything under it: /watch, not /watch-later.
      OWN_GESTURES.some((page) => path === page || path.startsWith(`${page}/`)) ||
      this.insideScrolled(event.target, view)
    ) {
      // A second finger, say: whatever was pulled so far doesn't count.
      this.reset();
      return;
    }
    this.start = { x: touch.clientX, y: touch.clientY };
  }

  /** Started in a list scrolled down inside the page: a drag there scrolls it back up. */
  private insideScrolled(target: EventTarget | null, view: Window): boolean {
    let node = target instanceof Element ? target : null;
    while (node && node !== this.document.body) {
      if (node.scrollTop > 0) {
        const overflow = view.getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  private onMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (!this.start || !touch) {
      return;
    }
    const down = touch.clientY - this.start.y;
    const across = Math.abs(touch.clientX - this.start.x);
    // Sideways (a row of cards) or back up: not a pull.
    if (down <= 0 || across > down) {
      if (this.pulled() > 0) {
        this.zone.run(() => this.pulled.set(0));
      }
      if (across > 12) {
        this.start = null;
      }
      return;
    }
    // Resists as it goes, like the browser's own.
    this.zone.run(() => this.pulled.set(Math.round(down * 0.55)));
  }

  private onEnd(view: Window): void {
    // Only a pull that's still going reloads.
    const ready = this.start !== null && this.pulled() >= this.threshold;
    this.start = null;
    if (!ready) {
      this.reset();
      return;
    }
    this.zone.run(() => this.reloading.set(true));
    this.reload(view);
  }

  protected reload(view: Window): void {
    view.location.reload();
  }

  private reset(): void {
    this.start = null;
    if (this.pulled() > 0) {
      this.zone.run(() => this.pulled.set(0));
    }
  }
}
