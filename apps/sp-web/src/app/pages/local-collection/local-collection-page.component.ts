import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { Observable, Subscription, combineLatest } from 'rxjs';
import {
  LocalLibraryService,
  LocalPerformer,
  LocalSceneCard,
  LocalScenePage,
  LocalSceneSort,
  LocalStudio,
} from '../../core/api/local-library.service';
import { SceneCardComponent } from '../../shared/scene-card/scene-card.component';
import { LibraryService } from '../../core/api/library.service';
import {
  FilterChipComponent,
  FilterPanelDirective,
} from '../../shared/filter-bar/filter-chip.component';
import {
  FilterOption,
  FilterOptionsComponent,
} from '../../shared/filter-bar/filter-options.component';
import { facetOptions, pickedLabel } from '../../shared/filter-bar/filter-values';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';
import { PerformerFact, readableCountry, readableDate } from '../performer/performer-facts';

export type LocalCollectionKind = 'performer' | 'studio';

interface CollectionHeader {
  id: string;
  name: string;
  subtitle: string | null;
  /** A performer's details, in the same grid as the catalog performer page. */
  facts: PerformerFact[];
  imageUrl: string | null;
  favorite: boolean;
  sceneCount: number;
  details: string | null;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
}

const SORTS: Array<{ value: LocalSceneSort; label: string }> = [
  { value: 'DATE', label: 'Newest' },
  { value: 'PRODUCED', label: 'Filmed (newest)' },
  { value: 'ADDED', label: 'Recently added' },
  { value: 'PLAYS', label: 'Most played' },
  { value: 'TITLE', label: 'A–Z' },
];

/**
 * A performer or studio from your Stash library: who they are and every scene
 * you have of theirs, with Play, Shuffle and a favorite toggle.
 */
@Component({
  selector: 'app-local-collection-page',
  imports: [
    RouterLink,
    SceneCardComponent,
    FilterChipComponent,
    FilterPanelDirective,
    FilterOptionsComponent,
  ],
  templateUrl: './local-collection-page.component.html',
  styleUrl: './local-collection-page.component.scss',
})
export class LocalCollectionPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly library = inject(LocalLibraryService);
  private readonly libraryOptions = inject(LibraryService);
  /** Settings → Playback: off hides Shuffle, which plays a random scene. */
  protected readonly playbackOn = inject(PlaybackSettingsService).playbackEnabled;
  private subscription: Subscription | null = null;
  private loadToken = 0;
  private scenesToken = 0;

  protected readonly kind = signal<LocalCollectionKind>('performer');
  protected readonly id = signal('');
  protected readonly header = signal<CollectionHeader | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly items = signal<LocalSceneCard[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly hasMore = signal(false);
  protected readonly loadingScenes = signal(false);
  protected readonly sort = signal<LocalSceneSort>('DATE');
  protected readonly favoriteBusy = signal(false);
  protected readonly shuffling = signal(false);
  protected readonly detailsExpanded = signal(false);
  protected readonly backPath = signal('/library');
  protected readonly backQueryParams = signal<Params>({});

  /** Their own categories and studios in your library, the most used first. */
  private readonly tagFacets = signal<Array<{ id: string; name: string; count: number }>>([]);
  private readonly studioFacets = signal<Array<{ id: string; name: string; count: number }>>([]);
  protected readonly optionsLoading = signal(false);
  protected readonly pickedTags = signal<Array<{ id: string; name: string }>>([]);
  protected readonly pickedStudios = signal<Array<{ id: string; name: string }>>([]);
  protected readonly categoryChoices = computed<FilterOption[]>(() =>
    facetOptions(this.tagFacets(), this.pickedTags()),
  );
  protected readonly studioChoices = computed<FilterOption[]>(() =>
    facetOptions(this.studioFacets(), this.pickedStudios()),
  );
  protected readonly categoryValue = computed(() =>
    pickedLabel(this.pickedTags().map((tag) => tag.name)),
  );
  protected readonly studioValue = computed(() =>
    pickedLabel(this.pickedStudios().map((studio) => studio.name)),
  );
  protected readonly pickedTagIds = computed(() => this.pickedTags().map((tag) => tag.id));
  protected readonly pickedStudioIds = computed(() =>
    this.pickedStudios().map((studio) => studio.id),
  );
  /** Studios to pick from on a performer's page with more than one. */
  protected readonly offersStudios = computed(
    () => this.kind() === 'performer' && this.studioFacets().length > 1,
  );
  protected readonly sortChoices: FilterOption[] = SORTS.map((sort) => ({
    id: sort.value,
    label: sort.label,
  }));
  protected readonly sortValue = computed(
    () => SORTS.find((sort) => sort.value === this.sort())?.label ?? 'Sort',
  );
  protected readonly sortPicked = computed(() => [this.sort()]);
  protected readonly narrowed = computed(
    () => this.pickedTags().length > 0 || this.pickedStudios().length > 0,
  );

  protected readonly unwatchedCount = computed(
    () => this.items().filter((item) => item.playCount === 0).length,
  );

  ngOnInit(): void {
    this.subscription = combineLatest([
      this.route.data,
      this.route.paramMap,
      this.route.queryParamMap,
    ]).subscribe(([data, params, query]) => {
      this.applyReturnTo(query.get('returnTo'));
      const kind: LocalCollectionKind = data['kind'] === 'studio' ? 'studio' : 'performer';
      const id = params.get('id')?.trim() ?? '';
      if (kind !== this.kind() || id !== this.id() || this.header() === null) {
        this.kind.set(kind);
        this.id.set(id);
        this.load();
      }
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  protected load(): void {
    const id = this.id();
    if (!id) {
      this.error.set('This link is missing an id.');
      this.loading.set(false);
      return;
    }
    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set(null);
    this.header.set(null);
    this.detailsExpanded.set(false);
    this.pickedTags.set([]);
    this.pickedStudios.set([]);
    this.loadOptions(id);
    const request: Observable<LocalPerformer | LocalStudio> =
      this.kind() === 'studio' ? this.library.studio(id) : this.library.performer(id);
    request.subscribe({
      next: (entity) => {
        if (token !== this.loadToken) {
          return;
        }
        this.header.set(this.toHeader(entity));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        if (token !== this.loadToken) {
          return;
        }
        this.error.set(this.describe(error));
        this.loading.set(false);
      },
    });
    this.loadScenes(1);
  }

  protected onCategoriesPicked(ids: string[]): void {
    const names = new Map(
      [...this.tagFacets(), ...this.pickedTags()].map((tag) => [tag.id, tag.name]),
    );
    this.pickedTags.set(ids.map((id) => ({ id, name: names.get(id) ?? id })));
    this.loadScenes(1);
  }

  protected onStudiosPicked(ids: string[]): void {
    const names = new Map(
      [...this.studioFacets(), ...this.pickedStudios()].map((studio) => [studio.id, studio.name]),
    );
    this.pickedStudios.set(ids.map((id) => ({ id, name: names.get(id) ?? id })));
    this.loadScenes(1);
  }

  protected onSortPicked(ids: string[]): void {
    const sort = SORTS.find((option) => option.value === ids[0]);
    if (sort) {
      this.setSort(sort.value);
    }
  }

  protected clearFilters(): void {
    this.pickedTags.set([]);
    this.pickedStudios.set([]);
    this.loadScenes(1);
  }

  private loadOptions(id: string): void {
    const scope = this.kind() === 'studio' ? { studioId: id } : { performerId: id };
    this.tagFacets.set([]);
    this.studioFacets.set([]);
    this.optionsLoading.set(true);
    this.libraryOptions.searchTags('', scope).subscribe({
      next: (tags) => {
        if (id === this.id()) {
          this.tagFacets.set(tags.map((tag) => ({ ...tag, count: tag.count ?? 0 })));
        }
        this.optionsLoading.set(false);
      },
      error: () => this.optionsLoading.set(false),
    });
    if (this.kind() === 'performer') {
      this.libraryOptions.searchStudios('', scope).subscribe({
        next: (studios) => {
          if (id === this.id()) {
            this.studioFacets.set(
              studios.map((studio) => ({ ...studio, count: studio.count ?? 0 })),
            );
          }
        },
        error: () => undefined,
      });
    }
  }

  protected setSort(sort: LocalSceneSort): void {
    if (sort !== this.sort()) {
      this.sort.set(sort);
      this.loadScenes(1);
    }
  }

  protected loadMore(): void {
    if (this.hasMore() && !this.loadingScenes()) {
      this.loadScenes(this.page() + 1);
    }
  }

  protected toggleFavorite(): void {
    const header = this.header();
    if (!header || this.favoriteBusy()) {
      return;
    }
    const favorite = !header.favorite;
    this.favoriteBusy.set(true);
    this.header.set({ ...header, favorite });
    const request: Observable<LocalPerformer | LocalStudio> =
      this.kind() === 'studio'
        ? this.library.setStudioFavorite(header.id, favorite)
        : this.library.setPerformerFavorite(header.id, favorite);
    request.subscribe({
      next: (entity) => {
        this.header.set(this.toHeader(entity));
        this.favoriteBusy.set(false);
      },
      error: () => {
        this.header.set(header);
        this.favoriteBusy.set(false);
      },
    });
  }

  /** Plays a random scene, preferring ones you haven't watched. */
  protected shuffle(): void {
    if (this.shuffling()) {
      return;
    }
    this.shuffling.set(true);
    const seed = Math.floor(Math.random() * 2_000_000_000) + 1;
    this.scenesRequest(1, 'RANDOM', seed).subscribe({
      next: (page) => {
        this.shuffling.set(false);
        const pick = page.items.find((item) => item.playCount === 0) ?? page.items[0];
        if (pick) {
          void this.router.navigate(['/watch', pick.id], {
            queryParams: { returnTo: this.router.url },
          });
        }
      },
      error: () => this.shuffling.set(false),
    });
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  protected displayedDetails(text: string | null): string | null {
    if (!text) {
      return null;
    }
    return this.detailsExpanded() || text.length <= 240 ? text : `${text.slice(0, 240).trimEnd()}…`;
  }

  protected toggleDetails(): void {
    this.detailsExpanded.update((value) => !value);
  }

  private loadScenes(page: number): void {
    // A new first page (another sort, another collection) makes every older
    // scenes request stale, including a "load more" still on its way.
    if (page === 1) {
      this.scenesToken += 1;
    }
    const token = this.loadToken;
    const scenesToken = this.scenesToken;
    const current = () => token === this.loadToken && scenesToken === this.scenesToken;
    this.loadingScenes.set(true);
    if (page === 1) {
      this.items.set([]);
    }
    this.scenesRequest(page, this.sort()).subscribe({
      next: (result) => {
        if (!current()) {
          return;
        }
        this.items.update((items) => (page === 1 ? result.items : [...items, ...result.items]));
        this.total.set(result.total);
        this.page.set(page);
        this.hasMore.set(result.hasMore);
        this.loadingScenes.set(false);
      },
      error: () => {
        if (!current()) {
          return;
        }
        this.loadingScenes.set(false);
        this.hasMore.set(false);
      },
    });
  }

  private scenesRequest(page: number, sort: LocalSceneSort, seed = 0): Observable<LocalScenePage> {
    const narrow = { tagIds: this.pickedTagIds(), studioIds: this.pickedStudioIds() };
    return this.kind() === 'studio'
      ? this.library.studioScenes(this.id(), page, sort, seed, { tagIds: narrow.tagIds })
      : this.library.performerScenes(this.id(), page, sort, seed, narrow);
  }

  private toHeader(entity: LocalPerformer | LocalStudio): CollectionHeader {
    if ('gender' in entity) {
      const age = entity.deathDate ? null : ageFrom(entity.birthdate);
      const born = readableDate(entity.birthdate);
      const facts: PerformerFact[] = [
        { label: 'Gender', value: formatGender(entity.gender) },
        born
          ? { label: 'Born', value: age !== null ? `${born} (${age})` : born }
          : { label: 'Age', value: age !== null ? String(age) : null },
        { label: 'Died', value: readableDate(entity.deathDate ?? null) },
        { label: 'Country', value: readableCountry(entity.country) },
      ].filter((fact): fact is PerformerFact => !!fact.value);
      return {
        id: entity.id,
        name: entity.name,
        subtitle: entity.disambiguation || null,
        facts,
        imageUrl: entity.imageUrl,
        favorite: entity.favorite,
        sceneCount: entity.sceneCount,
        details: entity.details,
        parent: null,
        children: [],
      };
    }
    return {
      id: entity.id,
      name: entity.name,
      subtitle: null,
      facts: [],
      imageUrl: entity.imageUrl,
      favorite: entity.favorite,
      sceneCount: entity.sceneCount,
      details: null,
      parent: entity.parent,
      children: entity.children,
    };
  }

  private describe(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const message = (error.error as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && message) {
        return message;
      }
    }
    return `Couldn't load this ${this.kind()}. Check that Stash is running and try again.`;
  }

  private applyReturnTo(raw: string | null): void {
    const trimmed = raw?.trim() ?? '';
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      try {
        const tree = this.router.parseUrl(trimmed);
        const segments = tree.root.children['primary']?.segments ?? [];
        const path = `/${segments.map((segment) => segment.path).join('/')}`;
        if (path !== '/') {
          this.backPath.set(path);
          this.backQueryParams.set(tree.queryParams);
          return;
        }
      } catch {
        // fall through
      }
    }
    this.backPath.set('/library');
    this.backQueryParams.set({});
  }
}

function formatGender(gender: string | null): string | null {
  if (!gender) {
    return null;
  }
  const words = gender.toLowerCase().split('_');
  return words
    .map((word, index) => (index === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function ageFrom(birthdate: string | null): number | null {
  const match = birthdate ? /^(\d{4})-(\d{2})-(\d{2})/.exec(birthdate) : null;
  if (!match) {
    return null;
  }
  const now = new Date();
  let age = now.getFullYear() - Number(match[1]);
  const beforeBirthday =
    now.getMonth() + 1 < Number(match[2]) ||
    (now.getMonth() + 1 === Number(match[2]) && now.getDate() < Number(match[3]));
  if (beforeBirthday) {
    age -= 1;
  }
  return age >= 0 && age < 130 ? age : null;
}
