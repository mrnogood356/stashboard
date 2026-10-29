import {
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  Subject,
  catchError,
  debounceTime,
  distinctUntilChanged,
  forkJoin,
  map,
  of,
  switchMap,
} from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { LibraryService } from '../../core/api/library.service';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { HideOwnedService } from '../../core/preferences/hide-owned.service';
import { QuickItem, isEditable, matchPages, startPages } from './quick-search.model';

const MIN_QUERY = 2;
/** Shared with the Search page, so both remember the same searches. */
const RECENT_KEY = 'stashboard.recentSearches';

interface QuickGroup {
  title: string;
  items: QuickItem[];
}

interface Found {
  library: QuickItem[];
  performers: QuickItem[];
  studios: QuickItem[];
  catalog: QuickItem[];
}

const NOTHING: Found = { library: [], performers: [], studios: [], catalog: [] };

/**
 * Search everything from anywhere: Ctrl+K (⌘K on a Mac), or "/" when you're
 * not typing in a box. Pages and settings by name, your library, the catalog,
 * and your recent searches; arrows and Enter to pick one.
 */
@Component({
  selector: 'app-quick-search',
  templateUrl: './quick-search.component.html',
  styleUrl: './quick-search.component.scss',
  host: {
    '(document:keydown)': 'onDocumentKeydown($event)',
  },
})
export class QuickSearchComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly library = inject(LibraryService);
  private readonly local = inject(LocalLibraryService);
  private readonly discover = inject(DiscoverService);
  private readonly playback = inject(PlaybackSettingsService);
  private readonly hideOwned = inject(HideOwnedService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('input');
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly queries = new Subject<string>();
  private returnFocus: HTMLElement | null = null;

  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly found = signal<Found>(NOTHING);
  protected readonly active = signal(0);
  protected readonly isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

  protected readonly groups = computed<QuickGroup[]>(() => {
    const query = this.query().trim();
    const feed = this.playback.feedEnabled();
    if (!query) {
      const recent = readRecent().map((value): QuickItem => ({
        id: `recent:${value}`,
        kind: 'recent',
        label: value,
        icon: 'pi-history',
        url: `/search?q=${encodeURIComponent(value)}`,
      }));
      return [
        { title: 'Recent searches', items: recent.slice(0, 4) },
        { title: 'Go to', items: startPages(feed) },
      ].filter((group) => group.items.length > 0);
    }
    const found = this.found();
    return [
      { title: 'Pages', items: matchPages(query, feed) },
      { title: 'Your library', items: found.library },
      { title: 'Performers', items: found.performers },
      { title: 'Studios', items: found.studios },
      { title: 'From the catalog', items: found.catalog },
      {
        title: '',
        items: [
          {
            id: 'all',
            kind: 'all' as const,
            label: `See all results for “${query}”`,
            icon: 'pi-search',
            url: `/search?q=${encodeURIComponent(query)}`,
          },
        ],
      },
    ].filter((group) => group.items.length > 0);
  });

  protected readonly items = computed(() => this.groups().flatMap((group) => group.items));
  protected readonly activeId = computed(() => this.items()[this.active()]?.id ?? null);

  ngOnInit(): void {
    const subscription = this.queries
      .pipe(
        map((value) => value.trim()),
        debounceTime(200),
        distinctUntilChanged(),
        switchMap((value) => {
          if (value.length < MIN_QUERY) {
            this.searching.set(false);
            return of({ value, found: NOTHING });
          }
          this.searching.set(true);
          return this.search(value).pipe(map((found) => ({ value, found })));
        }),
      )
      .subscribe(({ value, found }) => {
        // An answer for what you typed before doesn't replace what you're typing now.
        if (value === this.query().trim()) {
          this.found.set(found);
          this.searching.set(false);
        }
      });
    this.destroyRef.onDestroy(() => subscription.unsubscribe());
  }

  /** Opens it; also what the sidebar's Search hint calls. */
  show(): void {
    if (this.open()) {
      this.input()?.nativeElement.select();
      return;
    }
    this.returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.open.set(true);
    this.active.set(0);
    setTimeout(() => this.input()?.nativeElement.focus());
  }

  close(): void {
    if (!this.open()) {
      return;
    }
    this.open.set(false);
    this.query.set('');
    this.found.set(NOTHING);
    this.queries.next('');
    this.returnFocus?.focus?.();
    this.returnFocus = null;
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (this.open()) {
        this.close();
      } else {
        this.show();
      }
      return;
    }
    if (
      key === '/' &&
      !this.open() &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !isEditable(event.target)
    ) {
      event.preventDefault();
      this.show();
    }
  }

  protected onInput(value: string): void {
    if (value.trim() !== this.query().trim()) {
      // The rows were for the last words; they'd be wrong to pick from now.
      this.found.set(NOTHING);
    }
    this.query.set(value);
    this.active.set(0);
    this.queries.next(value);
  }

  /** Esc closes from anywhere in the box, and Tab stays inside it. */
  protected onPanelKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(
      this.panel()?.nativeElement.querySelectorAll<HTMLElement>('input, button') ?? [],
    ).filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.items().length;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) {
          this.active.set((this.active() + 1) % count);
          this.scrollActiveIntoView();
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) {
          this.active.set((this.active() - 1 + count) % count);
          this.scrollActiveIntoView();
        }
        break;
      case 'Enter': {
        event.preventDefault();
        const item = this.items()[this.active()];
        if (item) {
          this.choose(item);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
    }
  }

  protected choose(item: QuickItem): void {
    if (item.kind === 'all' || item.kind === 'recent') {
      rememberSearch(item.kind === 'all' ? this.query().trim() : item.label);
    }
    this.close();
    void this.router.navigateByUrl(item.url);
  }

  protected indexOf(item: QuickItem): number {
    return this.items().indexOf(item);
  }

  private scrollActiveIntoView(): void {
    setTimeout(() =>
      document.getElementById(`quick-${this.activeId()}`)?.scrollIntoView?.({ block: 'nearest' }),
    );
  }

  private search(value: string) {
    const safe = <T>(request: import('rxjs').Observable<T>, fallback: T) =>
      request.pipe(catchError(() => of(fallback)));
    return forkJoin({
      library: safe(this.library.getScenesFeed(1, 4, { query: value }), null),
      local: safe(this.local.search(value), { performers: [], studios: [] }),
      catalog: safe(this.discover.searchScenes(value, 1, 4), null),
    }).pipe(
      map((result): Found => ({
        library: (result.library?.items ?? []).map((scene) => ({
          id: `library:${scene.id}`,
          kind: 'library',
          label: scene.title,
          detail: [scene.studio, scene.performerNames.slice(0, 2).join(', ')]
            .filter(Boolean)
            .join(' · '),
          imageUrl: scene.cardImageUrl ?? scene.imageUrl,
          icon: 'pi-video',
          url: `/library/scene/${encodeURIComponent(scene.id)}`,
        })),
        performers: result.local.performers.slice(0, 3).map((performer) => ({
          id: `performer:${performer.id}`,
          kind: 'performer',
          label: performer.name,
          detail: sceneCount(performer.sceneCount),
          imageUrl: performer.imageUrl,
          icon: 'pi-user',
          url: `/library/performer/${encodeURIComponent(performer.id)}`,
        })),
        studios: result.local.studios.slice(0, 3).map((studio) => ({
          id: `studio:${studio.id}`,
          kind: 'studio',
          label: studio.name,
          detail: sceneCount(studio.sceneCount),
          imageUrl: studio.imageUrl,
          icon: 'pi-building',
          url: `/library/studio/${encodeURIComponent(studio.id)}`,
        })),
        // "Hide ones I have" applies here too, as on Scenes and Search.
        catalog: this.hideOwned.filter(result.catalog?.items ?? []).map((scene) => ({
          id: `catalog:${scene.id}`,
          kind: 'catalog',
          label: scene.title,
          detail: [scene.studio, scene.releaseDate?.slice(0, 4)].filter(Boolean).join(' · '),
          imageUrl: scene.cardImageUrl ?? scene.imageUrl,
          icon: 'pi-video',
          url: `/scene/${encodeURIComponent(scene.id)}`,
        })),
      })),
    );
  }
}

function sceneCount(count: number): string {
  return count === 1 ? '1 scene' : `${count.toLocaleString()} scenes`;
}

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function rememberSearch(value: string): void {
  if (!value) {
    return;
  }
  try {
    const next = [value, ...readRecent().filter((entry) => entry !== value)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode: nothing to remember it in.
  }
}
