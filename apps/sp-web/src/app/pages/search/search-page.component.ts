import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  Subject,
  Subscription,
  catchError,
  debounceTime,
  distinctUntilChanged,
  forkJoin,
  map,
  of,
  switchMap,
} from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import {
  PerformerFeedItem,
  SceneExplorerItem,
  SceneRequestContext,
  StudioFeedItem,
} from '../../core/api/discover.types';
import { LibraryService } from '../../core/api/library.service';
import { LibrarySceneItem } from '../../core/api/library.types';
import { LocalLibraryService, LocalSearchResults } from '../../core/api/local-library.service';
import { SceneCardComponent } from '../../shared/scene-card/scene-card.component';
import { HideOwnedService, isOwned } from '../../core/preferences/hide-owned.service';
import { OwnedNoteComponent } from '../../shared/owned-note/owned-note.component';
import { HiddenCountComponent } from '../../shared/hidden-count/hidden-count.component';
import { SceneRequestModalComponent } from '../../shared/scene-request-modal/scene-request-modal.component';
import { OverflowXDirective } from '../../shared/overflow-x/overflow-x.directive';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';
import { CatalogBrowseService } from '../../core/catalog/catalog-browse.service';
import {
  PersonResult,
  addFound,
  catalogPerformers,
  catalogStudios,
  libraryPeople,
  missedNames,
} from './search-merge';

export type SearchFilter = 'all' | 'scenes' | 'performers' | 'studios';
/** Where to look: both, only your library, or only the catalog. */
export type SearchScope = 'all' | 'library' | 'catalog';

interface SearchResults {
  library: LibrarySceneItem[];
  libraryTotal: number;
  local: LocalSearchResults;
  catalogScenes: SceneExplorerItem[];
  /** Every catalog scene that matches, not just the ones shown. */
  catalogScenesTotal: number;
  /** Catalog scenes Settings → Hidden content left out. */
  catalogHidden: number;
  catalogPerformers: PerformerFeedItem[];
  catalogPerformersTotal: number;
  catalogStudios: StudioFeedItem[];
  catalogStudiosTotal: number;
  /** The catalog's scenes couldn't be searched. */
  catalogScenesFailed: boolean;
  /** Its performers or studios couldn't be searched. */
  catalogPeopleFailed: boolean;
}

const RECENT_KEY = 'stashboard.recentSearches';
const RECENT_LIMIT = 8;
const MIN_QUERY = 2;

const EMPTY: SearchResults = {
  library: [],
  libraryTotal: 0,
  local: { performers: [], studios: [] },
  catalogScenes: [],
  catalogScenesTotal: 0,
  catalogHidden: 0,
  catalogPerformers: [],
  catalogPerformersTotal: 0,
  catalogStudios: [],
  catalogStudiosTotal: 0,
  catalogScenesFailed: false,
  catalogPeopleFailed: false,
};

/**
 * One search box for everything: your library (scenes, performers, studios)
 * and the StashDB/FansDB catalog. Each part loads on its own, so a slow or
 * failing source never blocks the others.
 */
/** The last search's results, kept while the app is open, for coming back to them. */
let lastSearch: {
  query: string;
  results: SearchResults;
  filter: SearchFilter;
  scope: SearchScope;
  showHidden: boolean;
} | null = null;

@Component({
  selector: 'app-search-page',
  imports: [
    SectionBackComponent,
    RouterLink,
    SceneCardComponent,
    OwnedNoteComponent,
    SceneRequestModalComponent,
    HiddenCountComponent,
    OverflowXDirective,
    NgTemplateOutlet,
  ],
  templateUrl: './search-page.component.html',
  styleUrl: './search-page.component.scss',
})
export class SearchPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly discover = inject(DiscoverService);
  private readonly hideOwned = inject(HideOwnedService);
  private readonly library = inject(LibraryService);
  private readonly local = inject(LocalLibraryService);
  private readonly browse = inject(CatalogBrowseService);
  private readonly queries = new Subject<string>();
  private subscription: Subscription | null = null;
  private showHiddenSubscription: Subscription | null = null;

  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly results = signal<SearchResults>(EMPTY);
  protected readonly recent = signal<string[]>(readRecent());
  protected readonly requestContext = signal<SceneRequestContext | null>(null);
  /** Show catalog scenes Settings → Hidden content leaves out, for this search. */
  protected readonly showHidden = signal(false);
  /** All, or just scenes, performers or studios. */
  protected readonly filter = signal<SearchFilter>('all');
  /** The words the results on the page are for. */
  private answered: string | null = null;
  /** Everywhere, only your library, or only the catalog: from the URL's `in`. */
  protected readonly scope = signal<SearchScope>('all');
  protected readonly showsLibrary = computed(() => this.scope() !== 'catalog');
  protected readonly showsCatalog = computed(() => this.scope() !== 'library');
  /** What the catalog is called here: the one searches go to. */
  protected readonly catalogName = this.browse.instanceLabel;
  /** Your library's performers and studios, each opening its library page. */
  protected readonly libraryPerformers = computed(() =>
    libraryPeople(this.results().local.performers, 'performer', this.query()),
  );
  protected readonly libraryStudios = computed(() =>
    libraryPeople(this.results().local.studios, 'studio', this.query()),
  );
  /** The catalog's, each marked with how many scenes of them you have. */
  protected readonly catalogPerformers = computed(() => {
    const result = this.results();
    return catalogPerformers(result.local.performers, result.catalogPerformers, this.query());
  });
  protected readonly catalogStudios = computed(() => {
    const result = this.results();
    return catalogStudios(result.local.studios, result.catalogStudios, this.query());
  });
  /** Catalog scenes to show: all, or only the ones you don't have. */
  protected readonly catalogScenes = computed(() =>
    this.hideOwned.filter(this.results().catalogScenes),
  );
  /**
   * A performer or studio named exactly what you typed, shown first and
   * larger: the catalog's when it's searched (it says if you have them),
   * else your library's.
   */
  protected readonly topResult = computed((): PersonResult | null => {
    const lists = [
      ...(this.showsCatalog() ? [this.catalogPerformers(), this.catalogStudios()] : []),
      ...(this.showsLibrary() ? [this.libraryPerformers(), this.libraryStudios()] : []),
    ];
    for (const list of lists) {
      const exact = list.find((entry) => entry.exact);
      if (exact) {
        return exact;
      }
    }
    return null;
  });
  /** How many of each kind there are where you're looking. */
  protected readonly counts = computed(() => this.countsIn(this.scope()));
  protected readonly libraryPeopleParams = computed(() => ({ q: this.query().trim(), lib: '1' }));
  /** The sources to list, in order: your library first. */
  protected readonly sources = computed((): Array<'library' | 'catalog'> => [
    ...(this.showsLibrary() ? (['library'] as const) : []),
    ...(this.showsCatalog() ? (['catalog'] as const) : []),
  ]);
  protected readonly peopleKinds = [
    { id: 'performers', label: 'Performers', page: '/performers' },
    { id: 'studios', label: 'Studios', page: '/studios' },
  ] as const;
  /** Query params for the full results pages "See all" opens. */
  protected readonly libraryParams = computed(() => ({ query: this.query().trim() }));
  /**
   * The catalog search used (the instance's): pinned on its "See all", so
   * those pages don't open the other one you last browsed.
   */
  private readonly catalogProvider = computed(() => this.browse.instanceKey());
  protected readonly catalogParams = computed(() => ({
    q: this.query().trim(),
    showHidden: this.showHidden() ? '1' : null,
    provider: this.catalogProvider(),
  }));
  protected readonly nameParams = computed(() => ({
    q: this.query().trim(),
    provider: this.catalogProvider(),
  }));
  protected readonly searched = computed(() => this.query().trim().length >= MIN_QUERY);
  protected readonly catalogFailed = catalogFailed;
  protected readonly nothingFound = computed(() => {
    const result = this.results();
    const counts = this.counts();
    return (
      this.searched() &&
      !this.searching() &&
      counts.scenes + counts.performers + counts.studios === 0 &&
      !(this.showsCatalog() && result.catalogHidden > 0) &&
      // A search that failed didn't find nothing: the page says it failed.
      !(this.showsCatalog() && catalogFailed(result))
    );
  });
  /** Nothing where you're looking, but something in the other place: offered instead. */
  protected readonly elsewhere = computed((): { scope: SearchScope; count: number } | null => {
    const scope = this.scope();
    if (scope === 'all') {
      return null;
    }
    const other: SearchScope = scope === 'library' ? 'catalog' : 'library';
    const counts = this.countsIn(other);
    const count = counts.scenes + counts.performers + counts.studios;
    return count > 0 ? { scope: other, count } : null;
  });

  ngOnInit(): void {
    this.subscription = this.queries
      .pipe(
        map((value) => value.trim()),
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((value) => {
          if (value.length < MIN_QUERY) {
            this.searching.set(false);
            return of({ value, results: EMPTY });
          }
          this.searching.set(true);
          // Carried with the answer: the words in the box may have moved on.
          return this.runSearch(value).pipe(map((results) => ({ value, results })));
        }),
      )
      .subscribe(({ value, results }) => {
        this.results.set(results);
        this.searching.set(false);
        this.answered = value;
        // A kind with nothing for these words would leave the page empty.
        const selected = this.filter();
        if (selected !== 'all' && this.counts()[selected] === 0) {
          this.filter.set('all');
        }
        this.keepForBack();
      });

    this.browse.ensureLoaded();
    this.scope.set(scopeOf(this.route.snapshot.queryParamMap.get('in')));
    const initial = this.route.snapshot.queryParamMap.get('q') ?? '';
    if (initial) {
      // Back from a result: the same results, at once, so Back can put you
      // where you were. Searching again would empty the page first.
      if (lastSearch?.query === initial.trim()) {
        this.query.set(initial);
        this.answered = lastSearch.query;
        this.results.set(lastSearch.results);
        // The scope is the URL's (set above): the same words in another
        // scope reuse the results, but show what the link asked for.
        this.filter.set(lastSearch.filter);
        this.showHidden.set(lastSearch.showHidden);
        const selected = this.filter();
        if (selected !== 'all' && this.counts()[selected] === 0) {
          this.filter.set('all');
        }
      } else {
        this.setQuery(initial);
      }
    } else {
      // Only an empty search takes the cursor: coming back to results, it
      // would open the keyboard and pull the page back to the top on a phone.
      setTimeout(() => this.searchInput?.nativeElement.focus(), 50);
    }
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.showHiddenSubscription?.unsubscribe();
  }

  /** Reloads just the catalog scenes, with or without hidden ones. */
  protected onShowHiddenChanged(showHidden: boolean): void {
    const value = this.query().trim();
    this.showHidden.set(showHidden);
    if (value.length < MIN_QUERY) {
      return;
    }
    this.showHiddenSubscription?.unsubscribe();
    this.showHiddenSubscription = this.discover
      .searchScenes(value, 1, 12, showHidden)
      .pipe(catchError(() => of(null)))
      .subscribe((response) => {
        if (this.query().trim() !== value) {
          return;
        }
        if (!response) {
          this.results.update((results) => ({ ...results, catalogScenesFailed: true }));
          this.keepForBack();
          return;
        }
        this.results.update((results) => ({
          ...results,
          catalogScenesFailed: false,
          catalogScenes: response.items,
          catalogScenesTotal: response.total ?? response.items.length,
          catalogHidden: response.hidden ?? 0,
        }));
        this.keepForBack();
      });
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.queries.next(value);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: value.trim() || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Looks everywhere, only in your library, or only on the catalog; kept in the URL. */
  protected setScope(scope: SearchScope): void {
    this.scope.set(scope);
    const selected = this.filter();
    if (selected !== 'all' && this.counts()[selected] === 0) {
      this.filter.set('all');
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { in: scope === 'all' ? null : scope },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    this.keepForBack();
  }

  protected clear(): void {
    this.setQuery('');
    this.searchInput?.nativeElement.focus();
  }

  /** Remembers the search when you act on a result or press Search/Enter. */
  /** Catalog scenes to show: all, or only the ones you don't have. */
  protected shownCatalog(items: SceneExplorerItem[]): SceneExplorerItem[] {
    return this.hideOwned.filter(items);
  }

  protected ownedIn(items: SceneExplorerItem[]): number {
    return items.filter(isOwned).length;
  }

  protected remember(): void {
    const value = this.query().trim();
    if (value.length < MIN_QUERY) {
      return;
    }
    const next = [
      value,
      ...this.recent().filter((entry) => entry.toLowerCase() !== value.toLowerCase()),
    ].slice(0, RECENT_LIMIT);
    this.recent.set(next);
    writeRecent(next);
  }

  protected removeRecent(value: string): void {
    const next = this.recent().filter((entry) => entry !== value);
    this.recent.set(next);
    writeRecent(next);
  }

  protected clearRecent(): void {
    this.recent.set([]);
    writeRecent([]);
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  /**
   * "See all 57": the total is what the source reported, never fewer than
   * are already shown. Just "See all" when the source doesn't say.
   */
  protected seeAll(total: number | null, shown: number): string {
    if (total === null) {
      return 'See all';
    }
    return `See all ${Math.max(total, shown).toLocaleString('en-US')}`;
  }

  protected showing(kind: Exclude<SearchFilter, 'all'>): boolean {
    return this.filter() === 'all' || this.filter() === kind;
  }

  /**
   * Under a name: a library entry's scene count; a catalog entry's count
   * there, and whether you have them.
   */
  protected personMeta(person: PersonResult): string {
    const scenes = (count: number) => `${count} scene${count === 1 ? '' : 's'}`;
    if (person.key.startsWith('library:')) {
      return person.libraryScenes !== null ? scenes(person.libraryScenes) : '';
    }
    const parts: string[] = [];
    if (person.catalogScenes !== null) {
      parts.push(scenes(person.catalogScenes));
    }
    if (person.libraryScenes !== null) {
      parts.push(`${person.libraryScenes} in your library`);
    }
    return parts.join(' · ');
  }

  /** Performers or studios from one source. */
  protected people(kind: 'performers' | 'studios', source: 'library' | 'catalog'): PersonResult[] {
    if (kind === 'performers') {
      return source === 'library' ? this.libraryPerformers() : this.catalogPerformers();
    }
    return source === 'library' ? this.libraryStudios() : this.catalogStudios();
  }

  /** How many a source reported in all: unknown (null) for your library's. */
  protected peopleTotal(
    kind: 'performers' | 'studios',
    source: 'library' | 'catalog',
  ): number | null {
    if (source === 'library') {
      return null;
    }
    const result = this.results();
    return kind === 'performers' ? result.catalogPerformersTotal : result.catalogStudiosTotal;
  }

  /** Where a result opens: "Your library" or "StashDB". */
  protected sourceOf(person: PersonResult): string {
    return person.key.startsWith('library:') ? 'Your library' : this.catalogName();
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  protected openRequest(context: SceneRequestContext): void {
    this.remember();
    this.requestContext.set(context);
  }

  protected closeRequest(): void {
    this.requestContext.set(null);
  }

  protected onRequested(): void {
    const context = this.requestContext();
    this.requestContext.set(null);
    if (!context) {
      return;
    }
    this.results.update((results) => ({
      ...results,
      catalogScenes: results.catalogScenes.map((scene) =>
        scene.id === context.id
          ? { ...scene, requestable: false, status: { state: 'REQUESTED' } }
          : scene,
      ),
    }));
    this.keepForBack();
  }

  /** Shows only one kind of result, and remembers it for coming back. */
  protected pickFilter(filter: SearchFilter): void {
    this.filter.set(filter);
    this.keepForBack();
  }

  /** How many of each kind a scope has, by what the sources reported. */
  private countsIn(scope: SearchScope): { scenes: number; performers: number; studios: number } {
    const result = this.results();
    const library = scope !== 'catalog';
    const catalog = scope !== 'library';
    return {
      scenes:
        (library ? Math.max(result.libraryTotal, result.library.length) : 0) +
        (catalog ? Math.max(result.catalogScenesTotal, this.catalogScenes().length) : 0),
      performers:
        (library ? result.local.performers.length : 0) +
        (catalog ? Math.max(result.catalogPerformersTotal, result.catalogPerformers.length) : 0),
      studios:
        (library ? result.local.studios.length : 0) +
        (catalog ? Math.max(result.catalogStudiosTotal, result.catalogStudios.length) : 0),
    };
  }

  /**
   * Keeps what's on the page for the search it answers, for coming back to
   * it. Results with a failed source aren't kept, so they're asked again.
   */
  private keepForBack(): void {
    const query = this.answered;
    if (!query || query !== this.query().trim()) {
      return;
    }
    const results = this.results();
    lastSearch = catalogFailed(results)
      ? null
      : {
          query,
          results,
          filter: this.filter(),
          scope: this.scope(),
          showHidden: this.showHidden(),
        };
  }

  private runSearch(value: string) {
    const safe = <T>(request: import('rxjs').Observable<T>, fallback: T) =>
      request.pipe(catchError(() => of(fallback)));
    return forkJoin({
      library: safe(this.library.getScenesFeed(1, 12, { query: value }), null),
      local: safe(this.local.search(value), EMPTY.local),
      catalogScenes: safe(this.discover.searchScenes(value, 1, 12, this.showHidden()), null),
      catalogPerformers: safe(this.discover.getPerformersFeed(1, 12, { name: value }), null),
      catalogStudios: safe(this.discover.getStudiosFeed(1, 12, { name: value }), null),
    }).pipe(
      map((result): SearchResults => ({
        library: result.library?.items ?? [],
        libraryTotal: result.library?.total ?? 0,
        local: result.local,
        catalogScenes: result.catalogScenes?.items ?? [],
        catalogScenesTotal: result.catalogScenes?.total ?? 0,
        catalogHidden: result.catalogScenes?.hidden ?? 0,
        catalogPerformers: result.catalogPerformers?.items ?? [],
        catalogPerformersTotal: result.catalogPerformers?.total ?? 0,
        catalogStudios: result.catalogStudios?.items ?? [],
        catalogStudiosTotal: result.catalogStudios?.total ?? 0,
        catalogScenesFailed: result.catalogScenes === null,
        catalogPeopleFailed: result.catalogPerformers === null || result.catalogStudios === null,
      })),
      switchMap((results) => this.askByLibraryNames(results, value)),
    );
  }

  /**
   * Your library can find a studio or performer the catalog's search
   * doesn't ("blackedraw" for Blacked Raw): ask the catalog again by the
   * library's own name, so it's listed with its catalog page and scenes.
   */
  private askByLibraryNames(results: SearchResults, value: string) {
    if (results.catalogPeopleFailed) {
      return of(results);
    }
    const studios = missedNames(results.local.studios, results.catalogStudios, value);
    const performers = missedNames(results.local.performers, results.catalogPerformers, value);
    if (studios.length === 0 && performers.length === 0) {
      return of(results);
    }
    const quiet = <T>(request: import('rxjs').Observable<{ items: T[] }>) =>
      request.pipe(
        map((page) => page.items),
        catchError(() => of([] as T[])),
      );
    const sceneName = results.catalogScenes.length === 0 ? (studios[0] ?? performers[0]) : null;
    return forkJoin({
      studios: forkJoin([
        of([] as StudioFeedItem[]),
        ...studios.map((name) => quiet(this.discover.getStudiosFeed(1, 5, { name }))),
      ]),
      performers: forkJoin([
        of([] as PerformerFeedItem[]),
        ...performers.map((name) => quiet(this.discover.getPerformersFeed(1, 5, { name }))),
      ]),
      scenes:
        sceneName && !results.catalogScenesFailed
          ? this.discover
              .searchScenes(sceneName, 1, 12, this.showHidden())
              .pipe(catchError(() => of(null)))
          : of(null),
    }).pipe(
      map((found): SearchResults => {
        const catalogStudios = addFound(
          results.catalogStudios,
          found.studios.flat(),
          results.local.studios,
        );
        const catalogPerformers = addFound(
          results.catalogPerformers,
          found.performers.flat(),
          results.local.performers,
        );
        return {
          ...results,
          catalogStudios,
          catalogStudiosTotal:
            results.catalogStudiosTotal + catalogStudios.length - results.catalogStudios.length,
          catalogPerformers,
          catalogPerformersTotal:
            results.catalogPerformersTotal +
            catalogPerformers.length -
            results.catalogPerformers.length,
          ...(found.scenes && found.scenes.items.length > 0
            ? {
                catalogScenes: found.scenes.items,
                catalogScenesTotal: found.scenes.total,
                catalogHidden: found.scenes.hidden ?? 0,
              }
            : {}),
        };
      }),
    );
  }
}

/** The scope a URL's `in` names; anything else is everywhere. */
export function scopeOf(value: string | null): SearchScope {
  return value === 'library' || value === 'catalog' ? value : 'all';
}

/** The catalog couldn't be searched (scenes, performers or studios). */
export function catalogFailed(result: SearchResults): boolean {
  return result.catalogScenesFailed || result.catalogPeopleFailed;
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeRecent(values: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(values));
  } catch {
    // ignore
  }
}
