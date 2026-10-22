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
import { HiddenCountComponent } from '../../shared/hidden-count/hidden-count.component';
import { SceneRequestModalComponent } from '../../shared/scene-request-modal/scene-request-modal.component';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';

interface SearchResults {
  library: LibrarySceneItem[];
  libraryTotal: number;
  local: LocalSearchResults;
  catalogScenes: SceneExplorerItem[];
  /** Catalog scenes Settings → Hidden content left out. */
  catalogHidden: number;
  catalogPerformers: PerformerFeedItem[];
  catalogStudios: StudioFeedItem[];
}

const RECENT_KEY = 'stashboard.recentSearches';
const RECENT_LIMIT = 8;
const MIN_QUERY = 2;

const EMPTY: SearchResults = {
  library: [],
  libraryTotal: 0,
  local: { performers: [], studios: [] },
  catalogScenes: [],
  catalogHidden: 0,
  catalogPerformers: [],
  catalogStudios: [],
};

/**
 * One search box for everything: your library (scenes, performers, studios)
 * and the StashDB/FansDB catalog. Each part loads on its own, so a slow or
 * failing source never blocks the others.
 */
@Component({
  selector: 'app-search-page',
  imports: [RouterLink, SceneCardComponent, SceneRequestModalComponent, HiddenCountComponent],
  templateUrl: './search-page.component.html',
  styleUrl: './search-page.component.scss',
})
export class SearchPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly discover = inject(DiscoverService);
  private readonly library = inject(LibraryService);
  private readonly local = inject(LocalLibraryService);
  /** Settings → Playback: off hides the swipe feed shortcut. */
  protected readonly feedOn = inject(PlaybackSettingsService).feedEnabled;
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
  protected readonly searched = computed(() => this.query().trim().length >= MIN_QUERY);
  protected readonly nothingFound = computed(() => {
    const result = this.results();
    return (
      this.searched() &&
      !this.searching() &&
      result.library.length === 0 &&
      result.local.performers.length === 0 &&
      result.local.studios.length === 0 &&
      result.catalogScenes.length === 0 &&
      result.catalogHidden === 0 &&
      result.catalogPerformers.length === 0 &&
      result.catalogStudios.length === 0
    );
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
            return of(EMPTY);
          }
          this.searching.set(true);
          return this.runSearch(value);
        }),
      )
      .subscribe((results) => {
        this.results.set(results);
        this.searching.set(false);
      });

    const initial = this.route.snapshot.queryParamMap.get('q') ?? '';
    if (initial) {
      this.setQuery(initial);
    }
    setTimeout(() => this.searchInput?.nativeElement.focus(), 50);
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
        if (!response || this.query().trim() !== value) {
          return;
        }
        this.results.update((results) => ({
          ...results,
          catalogScenes: response.items,
          catalogHidden: response.hidden ?? 0,
        }));
      });
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.queries.next(value);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: value.trim() || null },
      replaceUrl: true,
    });
  }

  protected clear(): void {
    this.setQuery('');
    this.searchInput?.nativeElement.focus();
  }

  /** Remembers the search when you act on a result or press Search/Enter. */
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
        catalogHidden: result.catalogScenes?.hidden ?? 0,
        catalogPerformers: result.catalogPerformers?.items ?? [],
        catalogStudios: result.catalogStudios?.items ?? [],
      })),
    );
  }
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
