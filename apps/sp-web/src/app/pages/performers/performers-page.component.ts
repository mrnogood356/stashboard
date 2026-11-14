import { PageTabsComponent, BROWSE_TABS } from '../../shared/page-tabs/page-tabs.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  FilterChipComponent,
  FilterPanelDirective,
} from '../../shared/filter-bar/filter-chip.component';
import {
  FilterOption,
  FilterOptionsComponent,
} from '../../shared/filter-bar/filter-options.component';
import {
  SortChoice,
  sortChoiceId,
  sortChoiceLabel,
  sortChoiceOptions,
} from '../../shared/filter-bar/filter-values';
import { RouterLink } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { ActivatedRoute, Router } from '@angular/router';
import { DiscoverService } from '../../core/api/discover.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LibraryPerformer, LibraryService } from '../../core/api/library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import {
  PerformerFeedItem,
  PerformerGender,
  PerformerSort,
  SortDirection,
} from '../../core/api/discover.types';

type GenderOption = PerformerGender | 'NONE';

import { CatalogProviderSwitchComponent } from '../../shared/catalog-provider-switch/catalog-provider-switch.component';

@Component({
  selector: 'app-performers-page',
  imports: [
    PageTabsComponent,
    SkeletonComponent,
    CatalogProviderSwitchComponent,
    RouterLink,
    Message,
    ButtonDirective,
    FilterChipComponent,
    FilterPanelDirective,
    FilterOptionsComponent,
  ],
  templateUrl: './performers-page.component.html',
  styleUrl: './performers-page.component.scss',
})
export class PerformersPageComponent implements OnInit, AfterViewInit, OnDestroy {
  protected readonly pageTabs = BROWSE_TABS;

  private static readonly PAGE_SIZE = 24;
  private static readonly DEFAULT_SORT: PerformerSort = 'NAME';
  private static readonly DEFAULT_DIRECTION: SortDirection = 'ASC';
  private static readonly DEFAULT_GENDER: GenderOption = 'NONE';

  protected static readonly GENDER_OPTIONS: Array<{
    value: GenderOption;
    label: string;
  }> = [
    { value: 'NONE', label: 'Any Gender' },
    { value: 'FEMALE', label: 'Female' },
    { value: 'MALE', label: 'Male' },
    { value: 'NON_BINARY', label: 'Non-binary' },
    { value: 'TRANSGENDER_FEMALE', label: 'Trans woman' },
    { value: 'TRANSGENDER_MALE', label: 'Trans man' },
    { value: 'INTERSEX', label: 'Intersex' },
    { value: 'UNKNOWN', label: 'Unknown' },
  ];

  private readonly discoverService = inject(DiscoverService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly libraryApi = inject(LibraryService);
  private readonly destroyRef = inject(DestroyRef);

  /** "In my library" ("lib=1" in the URL): only people in your own scenes. */
  protected readonly inLibrary = signal(false);
  protected readonly libItems = signal<LibraryPerformer[]>([]);
  protected readonly libTotal = signal(0);
  protected readonly libHasMore = signal(false);
  protected readonly libLoading = signal(false);
  protected readonly libFailed = signal(false);
  private libPage = 1;
  protected libQuery: string | null = null;
  private libRequest: Subscription | null = null;
  private queryParamSubscription: Subscription | null = null;
  private observer: IntersectionObserver | null = null;
  private sentinelElement: HTMLDivElement | null = null;
  private sentinelIntersecting = false;
  private feedVersion = 0;
  private pendingReload = false;
  private hasHydratedFromUrl = false;

  @ViewChild('loadMoreSentinel')
  set loadMoreSentinel(elementRef: ElementRef<HTMLDivElement> | undefined) {
    const nextElement = elementRef?.nativeElement ?? null;
    if (this.sentinelElement === nextElement) {
      return;
    }

    if (this.observer && this.sentinelElement) {
      this.observer.unobserve(this.sentinelElement);
    }

    this.sentinelElement = nextElement;

    if (this.observer && this.sentinelElement) {
      this.observer.observe(this.sentinelElement);
    }
  }

  protected readonly loading = signal(false);
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly loadMoreError = signal<string | null>(null);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly hasMore = signal(true);
  protected readonly inFlight = signal(false);
  protected readonly items = signal<PerformerFeedItem[]>([]);
  protected readonly nameFilter = signal('');
  protected readonly selectedGender = signal<GenderOption>(PerformersPageComponent.DEFAULT_GENDER);
  protected readonly selectedSort = signal<PerformerSort>(PerformersPageComponent.DEFAULT_SORT);
  protected readonly selectedDirection = signal<SortDirection>(
    PerformersPageComponent.DEFAULT_DIRECTION,
  );
  protected readonly favoritesOnly = signal(false);
  protected readonly favoriteInFlightById = signal<Record<string, boolean>>({});
  /** Sort and direction as one plain choice, for the filter bar. */
  private static readonly SORT_CHOICES: SortChoice<PerformerSort>[] = [
    { label: 'Name A–Z', sort: 'NAME', direction: 'ASC' },
    { label: 'Name Z–A', sort: 'NAME', direction: 'DESC' },
    { label: 'Most scenes', sort: 'SCENE_COUNT', direction: 'DESC' },
    { label: 'Latest scene', sort: 'LAST_SCENE', direction: 'DESC' },
    { label: 'Newest debut', sort: 'DEBUT', direction: 'DESC' },
    { label: 'Started most recently', sort: 'CAREER_START_YEAR', direction: 'DESC' },
    { label: 'Youngest', sort: 'BIRTHDATE', direction: 'DESC' },
    { label: 'Oldest', sort: 'BIRTHDATE', direction: 'ASC' },
    { label: 'Recently added', sort: 'CREATED_AT', direction: 'DESC' },
    { label: 'Recently updated', sort: 'UPDATED_AT', direction: 'DESC' },
  ];
  protected readonly sortChoices = sortChoiceOptions(PerformersPageComponent.SORT_CHOICES);
  protected readonly sortValue = computed(() =>
    sortChoiceLabel(
      PerformersPageComponent.SORT_CHOICES,
      this.selectedSort(),
      this.selectedDirection(),
    ),
  );
  protected readonly sortPicked = computed(() => [
    sortChoiceId(this.selectedSort(), this.selectedDirection()),
  ]);
  protected readonly genderChoices: FilterOption[] = PerformersPageComponent.GENDER_OPTIONS.filter(
    (option) => option.value !== 'NONE',
  ).map((option) => ({ id: option.value, label: option.label }));
  protected readonly genderPicked = computed(() =>
    this.selectedGender() === 'NONE' ? [] : [this.selectedGender()],
  );
  protected readonly genderValue = computed(
    () =>
      PerformersPageComponent.GENDER_OPTIONS.find(
        (option) => option.value === this.selectedGender() && option.value !== 'NONE',
      )?.label ?? null,
  );

  protected onGenderPicked(ids: string[]): void {
    this.onGenderChanged(ids[0] ?? 'NONE');
  }

  protected onSortPicked(ids: string[]): void {
    const choice = PerformersPageComponent.SORT_CHOICES.find(
      (option) => sortChoiceId(option.sort, option.direction) === ids[0],
    );
    if (
      !choice ||
      (choice.sort === this.selectedSort() && choice.direction === this.selectedDirection())
    ) {
      return;
    }
    this.selectedSort.set(choice.sort);
    this.selectedDirection.set(choice.direction);
    this.syncUrlWithCurrentFilters(false);
    this.resetFeedAndReload();
  }

  ngOnInit(): void {
    this.setupUrlStateSync();
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const on = params.get('lib') === '1';
      const query = (params.get('q') ?? '').trim();
      this.inLibrary.set(on);
      if (on) {
        // The catalog list is hidden: its sentinel no longer asks for pages.
        this.sentinelIntersecting = false;
      }
      if (on && query !== this.libQuery) {
        this.libQuery = query;
        this.loadLibrary(true);
      }
      if (!on) {
        this.libQuery = null;
      }
    });
  }

  protected toggleInLibrary(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { lib: this.inLibrary() ? null : '1' },
      queryParamsHandling: 'merge',
    });
  }

  protected showMoreLibrary(): void {
    this.loadLibrary(false);
  }

  /** After a failed page: the first page again, or the one that failed. */
  protected retryLibrary(): void {
    this.loadLibrary(this.libItems().length === 0);
  }

  private loadLibrary(reset: boolean): void {
    if (reset) {
      this.libPage = 1;
      this.libItems.set([]);
    }
    this.libRequest?.unsubscribe();
    this.libLoading.set(true);
    this.libFailed.set(false);
    this.libRequest = this.libraryApi
      .listPerformers(this.libQuery ?? '', this.libPage)
      .pipe(finalize(() => this.libLoading.set(false)))
      .subscribe({
        next: (result) => {
          this.libItems.update((items) => (reset ? result.items : [...items, ...result.items]));
          this.libTotal.set(result.total);
          this.libHasMore.set(result.hasMore);
          this.libPage = result.page + 1;
        },
        error: () => this.libFailed.set(true),
      });
  }

  ngAfterViewInit(): void {
    this.setupIntersectionObserver();
  }

  ngOnDestroy(): void {
    if (this.observer && this.sentinelElement) {
      this.observer.unobserve(this.sentinelElement);
    }
    this.observer?.disconnect();
    this.queryParamSubscription?.unsubscribe();
  }

  protected hasItems(): boolean {
    return this.items().length > 0;
  }

  protected retryInitialLoad(): void {
    if (this.inFlight()) {
      return;
    }

    this.error.set(null);
    this.loadNextPage();
  }

  protected retryLoadMore(): void {
    if (this.inFlight() || !this.hasMore()) {
      return;
    }

    this.loadMoreError.set(null);
    this.loadNextPage();
  }

  protected onGenderChanged(nextValue: string): void {
    if (
      nextValue === 'NONE' ||
      nextValue === 'MALE' ||
      nextValue === 'FEMALE' ||
      nextValue === 'UNKNOWN' ||
      nextValue === 'TRANSGENDER_MALE' ||
      nextValue === 'TRANSGENDER_FEMALE' ||
      nextValue === 'INTERSEX' ||
      nextValue === 'NON_BINARY'
    ) {
      if (this.selectedGender() === nextValue) {
        return;
      }

      this.selectedGender.set(nextValue);
      this.syncUrlWithCurrentFilters(false);
      this.resetFeedAndReload();
    }
  }

  protected onFavoritesOnlyChanged(nextValue: boolean): void {
    if (this.favoritesOnly() === nextValue) {
      return;
    }

    this.favoritesOnly.set(nextValue);
    this.syncUrlWithCurrentFilters(false);
    this.resetFeedAndReload();
  }

  protected performerInitial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  protected formattedGender(gender: PerformerGender | null): string | null {
    if (!gender) {
      return null;
    }

    return gender
      .split('_')
      .map((token) => token.charAt(0) + token.slice(1).toLowerCase())
      .join(' ');
  }

  protected favoriteToggleLabel(isFavorite: boolean): string {
    return isFavorite ? 'Unfavorite performer' : 'Favorite performer';
  }

  protected favoriteToggleBusy(performerId: string): boolean {
    return this.favoriteInFlightById()[performerId] === true;
  }

  protected togglePerformerFavorite(event: Event, performer: PerformerFeedItem): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.favoriteToggleBusy(performer.id)) {
      return;
    }

    const nextFavorite = !performer.isFavorite;
    this.setFavoriteToggleBusy(performer.id, true);

    this.discoverService
      .favoritePerformer(performer.id, nextFavorite)
      .pipe(
        finalize(() => {
          this.setFavoriteToggleBusy(performer.id, false);
        }),
      )
      .subscribe({
        next: (result) => {
          if (this.favoritesOnly() && !nextFavorite) {
            this.resetFeedAndReload();
          } else {
            this.items.update((current) =>
              current.map((item) =>
                item.id === performer.id ? { ...item, isFavorite: nextFavorite } : item,
              ),
            );
          }

          if (nextFavorite && result.alreadyFavorited) {
            this.notifications.info('Performer already favorited');
            return;
          }

          this.notifications.success(
            nextFavorite ? 'Performer favorited' : 'Performer unfavorited',
          );
        },
        error: () => {
          this.notifications.error(
            nextFavorite ? 'Failed to favorite performer' : 'Failed to unfavorite performer',
          );
        },
      });
  }

  protected currentRouteUrl(): string {
    return this.router.url;
  }

  private loadNextPage(): void {
    if (this.inFlight() || !this.hasMore()) {
      return;
    }

    const nextPage = this.page() + 1;
    const isInitialPage = nextPage === 1;
    const requestVersion = this.feedVersion;
    this.inFlight.set(true);

    if (isInitialPage) {
      this.loading.set(true);
      this.error.set(null);
    } else {
      this.loadingMore.set(true);
      this.loadMoreError.set(null);
    }

    this.discoverService
      .getPerformersFeed(nextPage, PerformersPageComponent.PAGE_SIZE, {
        name: this.normalizedNameFilter(),
        gender: this.selectedGenderFilter(),
        sort: this.selectedSort(),
        direction: this.selectedDirection(),
        favoritesOnly: this.favoritesOnly(),
      })
      .pipe(
        finalize(() => {
          this.inFlight.set(false);

          if (requestVersion !== this.feedVersion) {
            if (this.pendingReload) {
              this.pendingReload = false;
              this.loadNextPage();
            }
            return;
          }

          if (isInitialPage) {
            this.loading.set(false);
          } else {
            this.loadingMore.set(false);
          }

          if (this.sentinelIntersecting && this.hasMore() && !this.inLibrary()) {
            this.loadNextPage();
          }
        }),
      )
      .subscribe({
        next: (response) => {
          if (requestVersion !== this.feedVersion) {
            return;
          }

          this.total.set(response.total);
          this.page.set(response.page);
          this.hasMore.set(response.hasMore);
          this.items.update((current) =>
            isInitialPage ? response.items : [...current, ...response.items],
          );
        },
        error: () => {
          if (requestVersion !== this.feedVersion) {
            return;
          }

          if (isInitialPage) {
            this.error.set('Failed to load performers feed from the API.');
          } else {
            this.loadMoreError.set('Failed to load more performers.');
          }
        },
      });
  }

  private normalizedNameFilter(): string | undefined {
    const normalizedName = this.nameFilter().trim();
    return normalizedName.length > 0 ? normalizedName : undefined;
  }

  private selectedGenderFilter(): PerformerGender | undefined {
    const gender = this.selectedGender();
    return gender === 'NONE' ? undefined : gender;
  }

  private setupUrlStateSync(): void {
    this.queryParamSubscription = this.route.queryParamMap.subscribe((queryParamMap) => {
      const urlState = this.readUrlState(queryParamMap);
      const changed = this.applyUrlState(urlState);
      if (!this.hasHydratedFromUrl || changed) {
        this.hasHydratedFromUrl = true;
        this.resetFeedAndReload();
        return;
      }

      this.hasHydratedFromUrl = true;
    });
  }

  private readUrlState(queryParamMap: import('@angular/router').ParamMap): {
    name: string;
    gender: GenderOption;
    sort: PerformerSort;
    direction: SortDirection;
    favoritesOnly: boolean;
  } {
    const name = (queryParamMap.get('q') ?? '').trim();

    const genderParam = queryParamMap.get('gender');
    const gender: GenderOption =
      genderParam === 'NONE' ||
      genderParam === 'MALE' ||
      genderParam === 'FEMALE' ||
      genderParam === 'UNKNOWN' ||
      genderParam === 'TRANSGENDER_MALE' ||
      genderParam === 'TRANSGENDER_FEMALE' ||
      genderParam === 'INTERSEX' ||
      genderParam === 'NON_BINARY'
        ? genderParam
        : PerformersPageComponent.DEFAULT_GENDER;

    const sortParam = queryParamMap.get('sort');
    const sort: PerformerSort =
      sortParam === 'NAME' ||
      sortParam === 'BIRTHDATE' ||
      sortParam === 'SCENE_COUNT' ||
      sortParam === 'CAREER_START_YEAR' ||
      sortParam === 'DEBUT' ||
      sortParam === 'LAST_SCENE' ||
      sortParam === 'CREATED_AT' ||
      sortParam === 'UPDATED_AT'
        ? sortParam
        : PerformersPageComponent.DEFAULT_SORT;

    const favoritesOnlyParam = queryParamMap.get('fav');
    const favoritesOnly = favoritesOnlyParam === '1' || favoritesOnlyParam === 'true';
    const directionParam = queryParamMap.get('dir');
    const direction: SortDirection =
      directionParam === 'ASC' || directionParam === 'DESC'
        ? directionParam
        : PerformersPageComponent.DEFAULT_DIRECTION;

    return {
      name,
      gender,
      sort,
      direction,
      favoritesOnly,
    };
  }

  private applyUrlState(state: {
    name: string;
    gender: GenderOption;
    sort: PerformerSort;
    direction: SortDirection;
    favoritesOnly: boolean;
  }): boolean {
    const changed =
      this.nameFilter() !== state.name ||
      this.selectedGender() !== state.gender ||
      this.selectedSort() !== state.sort ||
      this.selectedDirection() !== state.direction ||
      this.favoritesOnly() !== state.favoritesOnly;

    if (!changed) {
      return false;
    }

    this.nameFilter.set(state.name);
    this.selectedGender.set(state.gender);
    this.selectedSort.set(state.sort);
    this.selectedDirection.set(state.direction);
    this.favoritesOnly.set(state.favoritesOnly);
    return true;
  }

  private syncUrlWithCurrentFilters(replaceUrl: boolean): void {
    const normalizedName = this.nameFilter().trim();
    const next = {
      q: normalizedName.length > 0 ? normalizedName : null,
      gender:
        this.selectedGender() === PerformersPageComponent.DEFAULT_GENDER
          ? null
          : this.selectedGender(),
      sort:
        this.selectedSort() === PerformersPageComponent.DEFAULT_SORT ? null : this.selectedSort(),
      dir:
        this.selectedDirection() === PerformersPageComponent.DEFAULT_DIRECTION
          ? null
          : this.selectedDirection(),
      fav: this.favoritesOnly() ? '1' : null,
    };

    const current = this.route.snapshot.queryParamMap;
    if (
      (current.get('q') ?? null) === next.q &&
      (current.get('gender') ?? null) === next.gender &&
      (current.get('sort') ?? null) === next.sort &&
      (current.get('dir') ?? null) === next.dir &&
      (current.get('fav') ?? null) === next.fav
    ) {
      return;
    }

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: next,
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  private resetFeedAndReload(): void {
    this.feedVersion += 1;
    this.pendingReload = false;
    this.page.set(0);
    this.total.set(0);
    this.hasMore.set(true);
    this.items.set([]);
    this.loading.set(false);
    this.loadingMore.set(false);
    this.error.set(null);
    this.loadMoreError.set(null);

    if (this.inFlight()) {
      this.pendingReload = true;
      return;
    }

    this.loadNextPage();
  }

  private setupIntersectionObserver(): void {
    if (!this.observer) {
      this.observer = new IntersectionObserver(
        (entries) => {
          const [entry] = entries;
          if (!entry) {
            return;
          }

          this.sentinelIntersecting = entry.isIntersecting;
          if (!entry.isIntersecting) {
            return;
          }

          if (this.inFlight() || !this.hasMore() || this.inLibrary()) {
            return;
          }

          this.loadNextPage();
        },
        {
          root: null,
          rootMargin: '300px 0px',
          threshold: 0.01,
        },
      );
    }

    if (this.sentinelElement) {
      this.observer.observe(this.sentinelElement);
    }
  }

  private setFavoriteToggleBusy(performerId: string, busy: boolean): void {
    this.favoriteInFlightById.update((current) => {
      if (busy) {
        return {
          ...current,
          [performerId]: true,
        };
      }

      const next = { ...current };
      delete next[performerId];
      return next;
    });
  }
}
