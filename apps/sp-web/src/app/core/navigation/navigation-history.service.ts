import { Injectable, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
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
  private readonly location = inject(Location);
  private started = false;
  private current: string | null = null;
  /** Each browser history entry this tab has seen, and the entry behind it. */
  private readonly entries = new Map<number, { url: string; behind: number | null }>();
  private entry: number | null = null;
  private nextEntry = 1;

  /** The page before this one, or null when this is the first page opened. */
  readonly previous = signal<string | null>(null);
  /**
   * The page Back in the browser goes to, when it's known: the entry behind
   * this one in history, which can differ from `previous` after Back and
   * Forward or a replaced address.
   */
  readonly behind = signal<string | null>(null);

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    // Before the first page has finished opening, the router's url is just "/".
    this.current = this.router.navigated ? this.router.url : null;
    if (this.current) {
      this.track(this.current, false, false);
    }
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        const next = event.urlAfterRedirects;
        const navigation = this.router.lastSuccessfulNavigation();
        if (!navigation?.extras.skipLocationChange) {
          this.track(
            next,
            navigation?.trigger === 'popstate',
            navigation?.extras.replaceUrl === true,
          );
        }
        if (next !== this.current) {
          this.previous.set(this.current);
          this.current = next;
        }
      });
  }

  /** Keeps up with the browser's history: a new entry, a replaced one, or one gone back or forward to. */
  private track(url: string, traversed: boolean, replaced: boolean): void {
    if (traversed) {
      const known = this.readEntry();
      const entry = known !== null ? this.entries.get(known) : undefined;
      if (known !== null && entry) {
        this.entry = known;
        entry.url = url;
      } else {
        // An entry from before this tab's app started: what's behind it isn't known.
        this.entry = this.add(url, null);
      }
    } else if (replaced && this.entry !== null) {
      this.entries.get(this.entry)!.url = url;
    } else {
      this.entry = this.add(url, this.entry);
    }
    this.writeEntry(this.entry);
    const behind = this.entries.get(this.entry)?.behind;
    this.behind.set(
      behind !== null && behind !== undefined ? (this.entries.get(behind)?.url ?? null) : null,
    );
  }

  private add(url: string, behind: number | null): number {
    const id = this.nextEntry++;
    this.entries.set(id, { url, behind });
    return id;
  }

  private readEntry(): number | null {
    try {
      const value = (this.location.getState() as Record<string, unknown> | null)?.[ENTRY_KEY];
      return typeof value === 'number' ? value : null;
    } catch {
      return null;
    }
  }

  /** Marks the current history entry, keeping the router's own state with it. */
  private writeEntry(entry: number | null): void {
    if (entry === null) {
      return;
    }
    try {
      const state = (this.location.getState() as Record<string, unknown> | null) ?? {};
      if (state[ENTRY_KEY] !== entry) {
        this.location.replaceState(this.location.path(true), '', { ...state, [ENTRY_KEY]: entry });
      }
    } catch {
      // No history to mark: Back links just open their page.
    }
  }
}

/** Stashboard's own mark on a history entry, kept alongside the router's. */
const ENTRY_KEY = 'stashboardEntry';

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
