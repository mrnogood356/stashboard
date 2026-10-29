import { Injectable, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { QUICK_PAGES } from '../../shared/quick-search/quick-search.model';

/**
 * Where you were before this page, inside the app, so a back button can say
 * where it goes ("‹ Home") and go there. Started by the app shell.
 */
@Injectable({ providedIn: 'root' })
export class NavigationHistoryService {
  private readonly router = inject(Router);
  private started = false;
  private current: string | null = null;

  /** The page before this one, or null when this is the first page opened. */
  readonly previous = signal<string | null>(null);

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    // Before the first page has finished opening, the router's url is just "/".
    this.current = this.router.navigated ? this.router.url : null;
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        const next = event.urlAfterRedirects;
        if (next !== this.current) {
          this.previous.set(this.current);
          this.current = next;
        }
      });
  }
}

/** "Home", "Requests", "Scene"… for a back button; "Back" when the page has no short name. */
export function pageLabel(url: string | null): string {
  if (!url) {
    return 'Home';
  }
  const path = url.split(/[?#]/, 1)[0];
  const page = QUICK_PAGES.find((candidate) => candidate.url === path);
  if (page) {
    return page.label;
  }
  if (/^\/(library\/)?scene\//.test(path)) {
    return 'Scene';
  }
  if (/^\/(library\/)?performer\//.test(path)) {
    return 'Performer';
  }
  if (/^\/(library\/)?studio\//.test(path)) {
    return 'Studio';
  }
  return 'Back';
}
