import { Injectable } from '@angular/core';
import { PreloadingStrategy, Route } from '@angular/router';
import { Observable, catchError, of, switchMap } from 'rxjs';

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** False on Data Saver or a 2G-class connection: the pages then load only when opened. */
export function shouldPreload(nav: Navigator | undefined = globalThis.navigator): boolean {
  const connection = (nav as (Navigator & { connection?: NetworkInformationLike }) | undefined)
    ?.connection;
  if (!connection) {
    return true;
  }
  if (connection.saveData) {
    return false;
  }
  return !(connection.effectiveType ?? '').includes('2g');
}

/** Emits once the browser has a quiet moment, or after `timeoutMs` at the latest. */
export function whenIdle(timeoutMs = 3000): Observable<void> {
  return new Observable<void>((subscriber) => {
    const done = () => {
      subscriber.next();
      subscriber.complete();
    };
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(done, { timeout: timeoutMs });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(done, 1500);
    return () => clearTimeout(id);
  });
}

/**
 * Like PreloadAllModules, but each page's code is fetched in a quiet moment
 * rather than straight away, so it doesn't compete with the first page's own
 * data and images on a phone. Nothing is preloaded on Data Saver or 2G.
 */
@Injectable({ providedIn: 'root' })
export class IdlePreloading implements PreloadingStrategy {
  preload(_route: Route, load: () => Observable<unknown>): Observable<unknown> {
    if (!shouldPreload()) {
      return of(null);
    }
    return whenIdle().pipe(
      // The connection can change while waiting (Wi-Fi to a weak signal).
      switchMap(() => (shouldPreload() ? load() : of(null))),
      catchError(() => of(null)),
    );
  }
}
