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
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';

export type LocalCollectionKind = 'performer' | 'studio';

interface CollectionHeader {
  id: string;
  name: string;
  subtitle: string | null;
  imageUrl: string | null;
  favorite: boolean;
  sceneCount: number;
  details: string | null;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
}

const SORTS: Array<{ value: LocalSceneSort; label: string }> = [
  { value: 'DATE', label: 'Newest' },
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
  imports: [RouterLink, SceneCardComponent],
  templateUrl: './local-collection-page.component.html',
  styleUrl: './local-collection-page.component.scss',
})
export class LocalCollectionPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly library = inject(LocalLibraryService);
  /** Settings → Playback: off hides Shuffle, which plays a random scene. */
  protected readonly playbackOn = inject(PlaybackSettingsService).playbackEnabled;
  private subscription: Subscription | null = null;
  private loadToken = 0;
  private scenesToken = 0;

  protected readonly sorts = SORTS;
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
    return this.kind() === 'studio'
      ? this.library.studioScenes(this.id(), page, sort, seed)
      : this.library.performerScenes(this.id(), page, sort, seed);
  }

  private toHeader(entity: LocalPerformer | LocalStudio): CollectionHeader {
    if ('gender' in entity) {
      const age = ageFrom(entity.birthdate);
      const subtitle = [
        entity.disambiguation,
        formatGender(entity.gender),
        age !== null ? `${age} years old` : null,
        entity.country,
      ]
        .filter((part): part is string => !!part)
        .join(' · ');
      return {
        id: entity.id,
        name: entity.name,
        subtitle: subtitle || null,
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
