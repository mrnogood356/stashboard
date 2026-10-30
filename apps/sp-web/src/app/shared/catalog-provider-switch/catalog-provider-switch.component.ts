import { Component, OnInit, inject } from '@angular/core';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import {
  CatalogBrowseService,
  CatalogProviderKey,
} from '../../core/catalog/catalog-browse.service';

/**
 * Catalog switch (StashDB, FansDB, ThePornDB) for browse pages. Only shows up when a second
 * provider is configured. Switching reloads the page, keeping tags (looked up
 * by name in the other catalog), sort and words; studios belong to one
 * catalog, so they're dropped.
 */
@Component({
  selector: 'app-catalog-provider-switch',
  template: `
    @if (browse.hasChoice()) {
      <div class="provider-switch" role="group" aria-label="Catalog provider">
        @for (option of browse.options(); track option.key) {
          <button
            type="button"
            [class.active]="browse.selected() === option.key"
            [attr.aria-pressed]="browse.selected() === option.key"
            [attr.title]="option.browseOnly ? option.label + ' (browse only)' : option.label"
            (click)="choose(option.key)"
          >
            {{ option.label }}
          </button>
        }
      </div>
    }
  `,
  styles: `
    .provider-switch {
      display: inline-flex;
      padding: 0.2rem;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--border-strong) 45%, transparent);
      background: color-mix(in srgb, var(--surface-elevated) 70%, transparent);
    }
    button {
      height: 1.85rem;
      padding: 0 0.8rem;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--text-muted);
      font: inherit;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
    }
    button.active {
      background: color-mix(in srgb, var(--focus-ring) 22%, var(--surface-elevated));
      color: var(--text-primary);
    }
  `,
})
export class CatalogProviderSwitchComponent implements OnInit {
  protected readonly browse = inject(CatalogBrowseService);
  private readonly appLock = inject(AppLockService);

  ngOnInit(): void {
    this.browse.ensureLoaded();
  }

  protected choose(key: CatalogProviderKey): void {
    if (this.browse.selected() === key) {
      return;
    }
    this.browse.select(key);
    // A reload of our own: App Lock mustn't take it for leaving the app.
    this.appLock.reloadTo(keptAcrossCatalogs(window.location.pathname, window.location.search));
  }
}

/** Filters that mean the same in both catalogs. */
const KEPT_PARAMS = ['tags', 'tagNames', 'mode', 'sort', 'dir', 'exclude', 'query', 'fav'];

export function keptAcrossCatalogs(pathname: string, search: string): string {
  const current = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const name of KEPT_PARAMS) {
    const value = current.get(name);
    if (value) {
      kept.set(name, value);
    }
  }
  // Tag ids only make sense with their names, which the other catalog looks up.
  if (!kept.get('tagNames')) {
    kept.delete('tags');
    kept.delete('mode');
  }
  const query = kept.toString();
  return query ? `${pathname}?${query}` : pathname;
}
