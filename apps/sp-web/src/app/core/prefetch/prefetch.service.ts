import { DOCUMENT } from '@angular/common';
import {
  HttpClient,
  HttpContext,
  HttpContextToken,
  HttpEvent,
  HttpInterceptorFn,
  HttpResponse,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, shareReplay } from 'rxjs';
import { CatalogBrowseService } from '../catalog/catalog-browse.service';

/** Marks Stashboard's own early requests, so they aren't answered from the cache they fill. */
const PREFETCH = new HttpContextToken<boolean>(() => false);
/** An early answer is used only this soon after it was asked for. */
const FRESH_MS = 20_000;
/** A mouse resting this long on a link counts as heading there. */
const HOVER_MS = 80;
const MAX_ENTRIES = 8;

/** The data a page will ask for first, from the link to it; null for links it doesn't know. */
export function prefetchUrlFor(path: string): string | null {
  const catalog = /^\/scene\/([^/?#]+)$/.exec(path);
  if (catalog) {
    return `/api/scenes/${encodeURIComponent(decodeURIComponent(catalog[1]))}`;
  }
  const library = /^\/library\/scene\/([^/?#]+)$/.exec(path);
  if (library) {
    return `/api/playback/scenes/${encodeURIComponent(decodeURIComponent(library[1]))}/details`;
  }
  return null;
}

interface Entry {
  at: number;
  /** The catalog it was asked from; a page on the other catalog asks again. */
  provider: string | null;
  response: Observable<HttpEvent<unknown>>;
}

/**
 * Loads a scene's details as soon as you rest the mouse on it, or touch it on
 * a phone, so the page has them when it opens. Each early answer is used
 * once, and only for a few seconds; anything else goes to the server as
 * usual. Off when the browser asks to save data.
 */
@Injectable({ providedIn: 'root' })
export class PrefetchService {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly catalog = inject(CatalogBrowseService);
  private readonly entries = new Map<string, Entry>();
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  start(): void {
    const view = this.document.defaultView;
    if (this.started || !view || saveData(view)) {
      return;
    }
    this.started = true;
    this.document.addEventListener(
      'pointerover',
      (event) => {
        const link = linkIn(event.target);
        if (!link) {
          return;
        }
        if (event.pointerType === 'mouse') {
          this.clearHover();
          this.hoverTimer = setTimeout(() => this.prefetchLink(link), HOVER_MS);
        } else {
          this.prefetchLink(link);
        }
      },
      { passive: true },
    );
    this.document.addEventListener('pointerout', () => this.clearHover(), { passive: true });
    this.document.addEventListener('focusin', (event) => {
      const link = linkIn(event.target);
      if (link) {
        this.prefetchLink(link);
      }
    });
  }

  prefetch(url: string, now = Date.now()): void {
    const existing = this.entries.get(url);
    if (existing && now - existing.at < FRESH_MS) {
      return;
    }
    const response = this.http
      .get(url, { observe: 'response', context: new HttpContext().set(PREFETCH, true) })
      .pipe(shareReplay({ bufferSize: 1, refCount: false }));
    // Start it now; whoever takes it later gets the same answer.
    response.subscribe({ error: () => this.entries.delete(url) });
    this.entries.set(url, { at: now, provider: this.catalog.providerForRequest(), response });
    while (this.entries.size > MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }

  /** The early answer for this URL, once, if it's still fresh. */
  take(url: string, now = Date.now()): Observable<HttpEvent<unknown>> | null {
    const entry = this.entries.get(url);
    if (!entry) {
      return null;
    }
    this.entries.delete(url);
    const sameCatalog = entry.provider === this.catalog.providerForRequest();
    return sameCatalog && now - entry.at < FRESH_MS ? entry.response : null;
  }

  private prefetchLink(link: HTMLAnchorElement): void {
    const view = this.document.defaultView;
    if (!view) {
      return;
    }
    const url = new URL(link.href, view.location.href);
    // A link that picks its own catalog: let the page ask, on that catalog.
    if (url.origin !== view.location.origin || url.searchParams.has('provider')) {
      return;
    }
    const api = prefetchUrlFor(url.pathname);
    if (api) {
      this.prefetch(api);
    }
  }

  private clearHover(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }
}

/** Uses an early answer when there is one; falls back to asking again if it failed. */
export const prefetchInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.method !== 'GET' || req.context.get(PREFETCH)) {
    return next(req);
  }
  const early = inject(PrefetchService).take(req.urlWithParams);
  if (!early) {
    return next(req);
  }
  return early.pipe(
    catchError(() => next(req)),
    // HttpResponse objects are immutable; a clone keeps the page from sharing one.
    (source) =>
      new Observable<HttpEvent<unknown>>((subscriber) =>
        source.subscribe({
          next: (event) => subscriber.next(event instanceof HttpResponse ? event.clone() : event),
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        }),
      ),
  );
};

function linkIn(target: EventTarget | null): HTMLAnchorElement | null {
  return target instanceof Element ? target.closest('a[href]') : null;
}

function saveData(view: Window): boolean {
  const connection = (
    view.navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection;
  return connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? '');
}
