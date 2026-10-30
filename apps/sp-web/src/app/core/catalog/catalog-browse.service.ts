import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs';

export type CatalogProviderKey = 'STASHDB' | 'FANSDB' | 'THEPORNDB';

function isProviderKey(value: string | null | undefined): value is CatalogProviderKey {
  return value === 'STASHDB' || value === 'FANSDB' || value === 'THEPORNDB';
}

export interface CatalogBrowseProviders {
  instance: CatalogProviderKey | null;
  available: Array<{ key: CatalogProviderKey; label: string; browseOnly: boolean }>;
}

const STORAGE_KEY = 'stashboard.browseProvider';
/** Pages that follow the StashDB/FansDB switch. */
const LIST_ROUTE = /^\/(scenes|performers|studios)(\/|$)/;
/** Pages that inherit the provider of the page they were opened from. */
const DETAIL_ROUTE = /^\/(scene|performer|studio)\//;

/**
 * Which catalog provider the browse pages show. The instance provider handles
 * requests; a second ready provider (e.g. FansDB next to StashDB) can be browsed.
 */
@Injectable({ providedIn: 'root' })
export class CatalogBrowseService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  /** Provider the current page uses; null means the instance provider. */
  private readonly pageProvider = signal<CatalogProviderKey | null>(null);
  private readonly providers = signal<CatalogBrowseProviders | null>(null);
  private readonly stored = signal<CatalogProviderKey | null>(readStored());
  private loadStarted = false;

  readonly options = computed(() => this.providers()?.available ?? []);
  readonly hasChoice = computed(() => this.options().length > 1);

  /** The provider browse pages should use right now. */
  readonly selected = computed<CatalogProviderKey | null>(() => {
    const providers = this.providers();
    const stored = this.stored();
    if (!providers) {
      return stored;
    }
    if (stored && providers.available.some((option) => option.key === stored)) {
      return stored;
    }
    return providers.instance;
  });

  constructor() {
    this.pageProvider.set(this.providerForUrl(this.router.url, null));
    // Provider of the page being left; detail pages inherit it.
    let previousPage = this.pageProvider();
    this.router.events
      .pipe(
        filter(
          (event): event is NavigationStart | NavigationEnd =>
            event instanceof NavigationStart || event instanceof NavigationEnd,
        ),
      )
      .subscribe((event) => {
        if (event instanceof NavigationStart) {
          previousPage = this.pageProvider();
          this.pageProvider.set(this.providerForUrl(event.url, previousPage));
        } else {
          this.pageProvider.set(this.providerForUrl(event.urlAfterRedirects, previousPage));
        }
      });
  }

  /**
   * Provider to send with catalog requests made right now, or null for the
   * instance provider. During a navigation it is worked out for the page being
   * opened, so that page's first requests already use the right provider.
   */
  providerForRequest(): CatalogProviderKey | null {
    const navigation = this.router.getCurrentNavigation();
    const provider = navigation
      ? this.providerForUrl(navigation.extractedUrl.toString(), this.pageProvider())
      : this.pageProvider();
    const instance = this.providers()?.instance ?? null;
    return provider && provider !== instance ? provider : null;
  }

  private providerForUrl(
    url: string,
    previous: CatalogProviderKey | null,
  ): CatalogProviderKey | null {
    const [path, query = ''] = url.split('?', 2);
    const explicit = new URLSearchParams(query).get('provider')?.toUpperCase();
    if (isProviderKey(explicit)) {
      return explicit;
    }
    if (LIST_ROUTE.test(path)) {
      return this.selected();
    }
    if (DETAIL_ROUTE.test(path)) {
      // A scene opened from FansDB browsing stays on FansDB, including the
      // performer and studio pages reached from it; from Home it uses the instance.
      return previous;
    }
    return null;
  }

  ensureLoaded(): void {
    if (this.loadStarted) {
      return;
    }
    this.loadStarted = true;
    this.http.get<CatalogBrowseProviders>('/api/catalog/providers').subscribe({
      next: (providers) => this.providers.set(providers),
      error: () => {
        this.loadStarted = false;
      },
    });
  }

  select(key: CatalogProviderKey): void {
    this.stored.set(key);
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      // Storage unavailable (private mode); the choice lasts for this visit.
    }
  }
}

function readStored(): CatalogProviderKey | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isProviderKey(value) ? value : null;
  } catch {
    return null;
  }
}
