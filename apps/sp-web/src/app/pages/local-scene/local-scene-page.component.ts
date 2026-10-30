import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { GlassArtService } from '../../core/theme/glass-art.service';
import { ActivatedRoute, Params, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Subject,
  Subscription,
  catchError,
  combineLatest,
  debounceTime,
  of,
  switchMap,
} from 'rxjs';
import {
  LocalSceneDetails,
  LocalSceneFile,
  PlaybackService,
  SceneMarker,
} from '../../core/api/playback.service';
import {
  LocalLibraryService,
  LocalSceneCard,
  LocalSceneUpdate,
} from '../../core/api/local-library.service';
import { SceneCardComponent } from '../../shared/scene-card/scene-card.component';
import { SceneEvidenceComponent } from '../../shared/scene-evidence/scene-evidence.component';
import { PlaybackSettingsService } from '../../core/playback/playback-settings.service';

const DESCRIPTION_PREVIEW_LENGTH = 280;

/**
 * A scene from your own Stash library: what it is, who is in it, and a Play
 * button for the built-in player. Opened from Library and Home cards.
 */
@Component({
  selector: 'app-local-scene-page',
  imports: [RouterLink, SceneCardComponent, SceneEvidenceComponent],
  templateUrl: './local-scene-page.component.html',
  styleUrl: './local-scene-page.component.scss',
})
export class LocalScenePageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly playback = inject(PlaybackService);
  private readonly library = inject(LocalLibraryService);
  /** Settings → Playback: off hides Play, Resume and chapter links. */
  protected readonly playbackOn = inject(PlaybackSettingsService).playbackEnabled;
  private subscription: Subscription | null = null;
  private tagSearchSubscription: Subscription | null = null;
  private readonly tagQueries = new Subject<string>();
  private sceneId: string | null = null;

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly scene = signal<LocalSceneDetails | null>(null);
  private readonly glassArt = inject(GlassArtService).follow(() => this.scene()?.imageUrl);
  protected readonly descriptionExpanded = signal(false);
  protected readonly backPath = signal('/library');
  protected readonly backQueryParams = signal<Params>({});
  protected readonly backLabel = signal('Back to Library');
  /** Saving an edit (rating, watched, organized, tags). */
  protected readonly saving = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly related = signal<LocalSceneCard[]>([]);
  protected readonly editingTags = signal(false);
  protected readonly tagQuery = signal('');
  protected readonly tagResults = signal<Array<{ id: string; name: string }>>([]);
  protected readonly watched = computed(() => (this.scene()?.playCount ?? 0) > 0);
  protected readonly markers = computed<SceneMarker[]>(() => this.scene()?.markers ?? []);

  protected readonly file = computed<LocalSceneFile | null>(() => this.scene()?.files[0] ?? null);
  protected readonly resumeAt = computed(() => {
    const scene = this.scene();
    if (!scene || scene.resumeTime < 5) {
      return 0;
    }
    // Nearly finished counts as watched; Play starts from the beginning again.
    const duration = scene.duration ?? 0;
    return duration > 0 && scene.resumeTime > duration - 15 ? 0 : scene.resumeTime;
  });
  protected readonly progressPercent = computed(() => {
    const duration = this.scene()?.duration ?? 0;
    const resume = this.resumeAt();
    return duration > 0 && resume > 0 ? Math.min(100, (resume / duration) * 100) : 0;
  });
  protected readonly ratingStars = computed(() => {
    const rating = this.scene()?.rating100;
    return typeof rating === 'number' && rating > 0 ? Math.round(rating / 20) : 0;
  });

  ngOnInit(): void {
    this.tagSearchSubscription = this.tagQueries
      .pipe(
        debounceTime(200),
        switchMap((query) =>
          query.trim().length === 0
            ? of([])
            : this.library.searchTags(query.trim()).pipe(catchError(() => of([]))),
        ),
      )
      .subscribe((tags) => {
        const current = new Set(this.scene()?.tags.map((tag) => tag.id) ?? []);
        this.tagResults.set(tags.filter((tag) => !current.has(tag.id)).slice(0, 8));
      });

    this.subscription = combineLatest([this.route.paramMap, this.route.queryParamMap]).subscribe(
      ([params, query]) => {
        this.applyReturnTo(query.get('returnTo'));
        const sceneId = params.get('sceneId')?.trim() ?? '';
        if (!sceneId) {
          this.error.set('Scene id is missing from the link.');
          this.loading.set(false);
          return;
        }
        if (sceneId !== this.sceneId) {
          this.sceneId = sceneId;
          this.load();
        }
      },
    );
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.tagSearchSubscription?.unsubscribe();
  }

  // ---------- organizing (saved to Stash) ----------

  /** Tapping the current star count clears the rating. */
  protected setRating(stars: number): void {
    const next = this.ratingStars() === stars ? null : stars * 20;
    this.save({ rating100: next }, (scene) => ({ ...scene, rating100: next }));
  }

  protected toggleOrganized(): void {
    const next = !(this.scene()?.organized ?? false);
    this.save({ organized: next }, (scene) => ({ ...scene, organized: next }));
  }

  protected toggleWatched(): void {
    const scene = this.scene();
    if (!scene || this.saving()) {
      return;
    }
    const watched = !this.watched();
    this.applyOptimistic(
      (current) => ({
        ...current,
        playCount: watched ? Math.max(1, current.playCount + 1) : 0,
        resumeTime: 0,
      }),
      this.library.setWatched(scene.id, watched),
    );
  }

  protected toggleTagEditing(): void {
    this.editingTags.update((value) => !value);
    this.tagQuery.set('');
    this.tagResults.set([]);
  }

  protected onTagQuery(value: string): void {
    this.tagQuery.set(value);
    this.tagQueries.next(value);
  }

  protected addTag(tag: { id: string; name: string }): void {
    const scene = this.scene();
    if (!scene || scene.tags.some((existing) => existing.id === tag.id)) {
      return;
    }
    const tags = [...scene.tags, tag];
    this.tagQuery.set('');
    this.tagResults.set([]);
    this.save({ tagIds: tags.map((entry) => entry.id) }, (current) => ({ ...current, tags }));
  }

  protected removeTag(tagId: string): void {
    const scene = this.scene();
    if (!scene) {
      return;
    }
    const tags = scene.tags.filter((tag) => tag.id !== tagId);
    this.save({ tagIds: tags.map((entry) => entry.id) }, (current) => ({ ...current, tags }));
  }

  protected chapterQueryParams(marker: SceneMarker): Params {
    return { returnTo: this.router.url, t: Math.floor(marker.seconds) };
  }

  private save(
    update: LocalSceneUpdate,
    optimistic: (scene: LocalSceneDetails) => LocalSceneDetails,
  ): void {
    const scene = this.scene();
    if (!scene || this.saving()) {
      return;
    }
    this.applyOptimistic(optimistic, this.library.updateScene(scene.id, update));
  }

  /** Shows the change right away, then keeps what Stash saved (or undoes it). */
  private applyOptimistic(
    optimistic: (scene: LocalSceneDetails) => LocalSceneDetails,
    request: ReturnType<LocalLibraryService['updateScene']>,
  ): void {
    const before = this.scene();
    if (!before) {
      return;
    }
    this.saving.set(true);
    this.actionError.set(null);
    this.scene.set(optimistic(before));
    // The page is reused for other scenes: an answer for one you left is not shown.
    const stillHere = () => this.sceneId === before.id;
    request.subscribe({
      next: (saved) => {
        if (!stillHere()) {
          return;
        }
        this.scene.set(saved);
        this.saving.set(false);
      },
      error: (error: unknown) => {
        if (!stillHere()) {
          return;
        }
        this.scene.set(before);
        this.saving.set(false);
        const message =
          error instanceof HttpErrorResponse &&
          typeof (error.error as { message?: unknown } | null)?.message === 'string'
            ? (error.error as { message: string }).message
            : 'Check that Stash is running and try again.';
        this.actionError.set(`Couldn't save that to Stash. ${message}`);
      },
    });
  }

  protected load(): void {
    const sceneId = this.sceneId;
    if (!sceneId) {
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.descriptionExpanded.set(false);
    this.related.set([]);
    this.editingTags.set(false);
    this.actionError.set(null);
    this.saving.set(false);
    this.playback.getSceneDetails(sceneId).subscribe({
      next: (scene) => {
        // Tapping two related scenes quickly: only the last one counts.
        if (this.sceneId !== sceneId) {
          return;
        }
        this.scene.set(scene);
        this.loading.set(false);
        this.library.related(scene.id).subscribe({
          next: (items) => {
            if (this.sceneId === scene.id) {
              this.related.set(items);
            }
          },
          error: () => this.related.set([]),
        });
      },
      error: (error: unknown) => {
        if (this.sceneId !== sceneId) {
          return;
        }
        this.scene.set(null);
        this.error.set(this.describeError(error));
        this.loading.set(false);
      },
    });
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected watchQueryParams(fromStart = false): Params {
    return fromStart ? { returnTo: this.router.url, t: 0 } : { returnTo: this.router.url };
  }

  protected toggleDescription(): void {
    this.descriptionExpanded.update((value) => !value);
  }

  protected displayedDescription(text: string | null): string | null {
    if (!text) {
      return null;
    }
    if (this.descriptionExpanded() || text.length <= DESCRIPTION_PREVIEW_LENGTH) {
      return text;
    }
    return `${text.slice(0, DESCRIPTION_PREVIEW_LENGTH).trimEnd()}…`;
  }

  protected isLongDescription(text: string | null): boolean {
    return (text?.length ?? 0) > DESCRIPTION_PREVIEW_LENGTH;
  }

  protected formatTime(seconds: number | null | undefined): string {
    const total = Math.max(0, Math.floor(seconds ?? 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (value: number) => value.toString().padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
  }

  protected formatDuration(seconds: number | null | undefined): string | null {
    if (!seconds || seconds <= 0) {
      return null;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
      return `${Math.max(1, minutes)} min`;
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours} hr ${rest} min` : `${hours} hr`;
  }

  protected formatDate(value: string | null): string | null {
    if (!value) {
      return null;
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      return value;
    }
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /** "4K", "1080p" and so on, from the file's frame size. */
  protected resolutionLabel(file: LocalSceneFile | null): string | null {
    if (!file?.width || !file.height) {
      return null;
    }
    const lines = Math.min(file.width, file.height);
    if (lines >= 2100) {
      return '4K';
    }
    if (lines >= 1400) {
      return '1440p';
    }
    if (lines >= 1000) {
      return '1080p';
    }
    if (lines >= 700) {
      return '720p';
    }
    return `${lines}p`;
  }

  protected formatSize(bytes: number | null): string | null {
    if (!bytes || bytes <= 0) {
      return null;
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  protected formatBitRate(bitsPerSecond: number | null): string | null {
    if (!bitsPerSecond || bitsPerSecond <= 0) {
      return null;
    }
    const mbps = bitsPerSecond / 1_000_000;
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${Math.round(bitsPerSecond / 1000)} kbps`;
  }

  protected formatFrameRate(fps: number | null): string | null {
    return fps && fps > 0 ? `${Math.round(fps * 100) / 100} fps` : null;
  }

  protected upper(value: string | null): string | null {
    return value ? value.toUpperCase() : null;
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  protected stars(): number[] {
    return [1, 2, 3, 4, 5];
  }

  private describeError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      const message = (error.error as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && message) {
        return message;
      }
      if (error.status === 404) {
        return 'That scene is not in your Stash library.';
      }
    }
    return 'Could not load this scene. Check that Stash is running and try again.';
  }

  private applyReturnTo(raw: string | null): void {
    const fallback = { path: '/library', params: {} as Params };
    let target = fallback;
    const trimmed = raw?.trim() ?? '';
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      try {
        const tree = this.router.parseUrl(trimmed);
        const segments = tree.root.children['primary']?.segments ?? [];
        const path = `/${segments.map((segment) => segment.path).join('/')}`;
        if (path !== '/') {
          target = { path, params: tree.queryParams };
        }
      } catch {
        target = fallback;
      }
    }
    this.backPath.set(target.path);
    this.backQueryParams.set(target.params);
    this.backLabel.set(backLabelFor(target.path));
  }
}

function backLabelFor(path: string): string {
  const labels: Array<[string, string]> = [
    ['/home', 'Back to Home'],
    ['/library', 'Back to Library'],
    ['/scenes', 'Back to Scenes'],
    ['/scene/', 'Back to Scene'],
    ['/performer/', 'Back to Performer'],
    ['/performers', 'Back to Performers'],
    ['/studio/', 'Back to Studio'],
    ['/studios', 'Back to Studios'],
    ['/acquisition', 'Back to Requests'],
    ['/processing', 'Back to Downloads'],
  ];
  return labels.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'Back';
}
