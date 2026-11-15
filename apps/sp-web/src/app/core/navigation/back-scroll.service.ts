import { Injectable, inject } from '@angular/core';
import { Router, Scroll } from '@angular/router';
import { filter } from 'rxjs';

/** How long a page has to fill in before Back gives up on its old position. */
const WAIT_MS = 3000;

/**
 * Browser Back puts you where you were on the page before, even when that
 * page loads its list again first: it keeps trying until the page is long
 * enough, and stops as soon as you scroll or tap yourself.
 */
@Injectable({ providedIn: 'root' })
export class BackScrollService {
  private readonly router = inject(Router);
  private started = false;
  private cancel: (() => void) | null = null;

  start(): void {
    if (this.started || typeof window === 'undefined') {
      return;
    }
    this.started = true;
    this.router.events
      .pipe(filter((event): event is Scroll => event instanceof Scroll))
      .subscribe((event) => {
        this.cancel?.();
        const position = event.position;
        if (!position || position[1] <= 0) {
          return;
        }
        this.restore(position[1]);
      });
  }

  private restore(top: number): void {
    const until = performance.now() + WAIT_MS;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
        window.removeEventListener(type, stop);
      }
      this.cancel = null;
    };
    for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) {
      window.addEventListener(type, stop, { passive: true });
    }
    this.cancel = stop;
    const step = () => {
      window.scrollTo({ top, behavior: 'instant' });
      if (Math.abs(window.scrollY - top) <= 1 || performance.now() > until) {
        stop();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }
}
