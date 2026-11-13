import { Injectable, Injector, OnDestroy, computed, inject, signal } from '@angular/core';
import {
  MatchCandidate,
  OrganizerApiService,
  UnmatchedScene,
  UnmatchedScope,
  UnmatchedSort,
} from '../../core/api/organizer.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { fileName } from './explain-rename.util';
import { OrganizeStore } from './organize.store';
import { OrganizeFilesStore } from './organize-files.store';
import { CONFIDENCE, MatchState } from './organize.shared';

/** Match & rename → Review: the scene list, matching scenes one by one, and picking scenes. */
@Injectable()
export class OrganizeListStore implements OnDestroy {
  private readonly api = inject(OrganizerApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly store = inject(OrganizeStore);

  private readonly injector = inject(Injector);
  private get files(): OrganizeFilesStore {
    return this.injector.get(OrganizeFilesStore);
  }

  readonly confidenceLabel = CONFIDENCE;

  readonly scenes = signal<UnmatchedScene[]>([]);
  readonly total = signal<number | null>(null);

  /** The list as searched and filtered; total() is always the unmatched count. */
  readonly listTotal = signal<number | null>(null);
  readonly listQuery = signal('');
  readonly listSort = signal<UnmatchedSort>('added-desc');
  readonly listScope = signal<UnmatchedScope>('unmatched');

  readonly filtered = computed(
    () => this.listQuery().trim() !== '' || this.listScope() !== 'unmatched',
  );

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private listRequest = 0;

  /** Unmatched files not in an Unmatched folder yet: what "Move … now" would move. */
  readonly toMove = signal(0);
  readonly loadingScenes = signal(false);
  readonly hasMore = signal(false);
  readonly matches = signal<Record<string, MatchState>>({});
  readonly lookingUpPage = signal(false);

  /** Bumped when a run ends, so the found-matches list is read again. */
  readonly reviewKey = signal(0);

  readonly withoutFingerprint = computed(
    () => this.scenes().filter((scene) => !scene.hasFingerprint).length,
  );

  private page = 1;

  readonly scraping = signal<ReadonlySet<string>>(new Set());

  tryScrapers(scene: UnmatchedScene): void {
    this.scraping.update((ids) => new Set([...ids, scene.id]));
    this.api.scrape(scene.id).subscribe({
      next: (result) => {
        this.scraping.update((ids) => new Set([...ids].filter((id) => id !== scene.id)));
        if (result.filled) {
          this.files.renameStale = true;
          this.scenes.update((scenes) => scenes.filter((entry) => entry.id !== scene.id));
          this.total.update((total) => (total === null ? total : Math.max(0, total - 1)));
          this.notifications.success(
            'Filled in by a scraper',
            result.renamedTo
              ? `${result.title} — renamed to ${fileName(result.renamedTo)}.`
              : `${result.title ?? 'Scene'} is filled in.`,
          );
        } else {
          this.notifications.info('No luck', 'None of Stash’s scrapers recognised this file.');
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.scraping.update((ids) => new Set([...ids].filter((id) => id !== scene.id)));
        this.notifications.error(
          'Couldn’t ask the scrapers',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  isScraping(id: string): boolean {
    return this.scraping().has(id);
  }

  search(value: string): void {
    this.listQuery.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    // Wait for a pause in typing before asking Stash.
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.loadScenes(1);
    }, 350);
  }

  setSort(value: string): void {
    this.listSort.set(value as UnmatchedSort);
    this.loadScenes(1);
  }

  setScope(value: string): void {
    this.listScope.set(value as UnmatchedScope);
    this.loadScenes(1);
  }

  loadMore(): void {
    this.loadScenes(this.page + 1);
  }

  matchState(id: string): MatchState | null {
    return this.matches()[id] ?? null;
  }

  lookup(scene: UnmatchedScene, query?: string): void {
    const current = this.matchState(scene.id);
    this.setMatch(scene.id, {
      loading: true,
      error: null,
      result: current?.result ?? null,
      query: query ?? current?.query ?? '',
    });
    this.api.lookup([scene.id], query?.trim() || undefined).subscribe({
      next: ([result]) => this.setMatch(scene.id, { loading: false, result: result ?? null }),
      error: (error: { error?: { message?: string } }) =>
        this.setMatch(scene.id, {
          loading: false,
          error: error?.error?.message ?? 'StashDB didn’t answer. Try again.',
        }),
    });
  }

  lookupPage(): void {
    const ids = this.scenes()
      .filter((scene) => !this.matchState(scene.id)?.result)
      .slice(0, 20)
      .map((scene) => scene.id);
    if (ids.length === 0) {
      return;
    }
    this.lookingUpPage.set(true);
    ids.forEach((id) => this.setMatch(id, { loading: true, error: null }));
    this.api.lookup(ids).subscribe({
      next: (results) => {
        this.lookingUpPage.set(false);
        for (const id of ids) {
          this.setMatch(id, {
            loading: false,
            result: results.find((result) => result.sceneId === id) ?? null,
          });
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.lookingUpPage.set(false);
        ids.forEach((id) =>
          this.setMatch(id, {
            loading: false,
            error: error?.error?.message ?? 'StashDB didn’t answer.',
          }),
        );
      },
    });
  }

  searchOwn(scene: UnmatchedScene, value: string): void {
    if (value.trim().length >= 2) {
      this.lookup(scene, value);
    }
  }

  apply(scene: UnmatchedScene, candidate: MatchCandidate): void {
    this.setMatch(scene.id, { applying: candidate.id });
    this.api.apply(scene.id, candidate.id).subscribe({
      next: (result) => {
        // A matched scene can be renamed now, or already was.
        this.files.renameStale = true;
        this.scenes.update((scenes) => scenes.filter((entry) => entry.id !== scene.id));
        this.total.update((total) => (total === null ? total : Math.max(0, total - 1)));
        this.notifications.success(
          'Matched',
          result.sentToWhisparr
            ? `${candidate.title ?? 'Scene'} is filled in and sent to Whisparr.`
            : result.renamedTo
              ? `${candidate.title ?? 'Scene'} is filled in and renamed to ${fileName(result.renamedTo)}.`
              : `${candidate.title ?? 'Scene'} is filled in from ${candidate.source}.`,
        );
        if (!result.sentToWhisparr && result.whisparrNote) {
          this.notifications.info('Not sent to Whisparr', result.whisparrNote);
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.setMatch(scene.id, { applying: null });
        this.notifications.error('Couldn’t save the match', error?.error?.message ?? 'Try again.');
      },
    });
  }

  matchAll(): void {
    this.api.matchAll().subscribe({
      next: (run) => {
        this.store.run.set(run);
        this.store.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error(
          'Couldn’t start',
          error?.error?.message ?? 'Try again in a moment.',
        ),
    });
  }

  readonly selecting = signal(false);
  readonly picked = signal<ReadonlySet<string>>(new Set());
  readonly confirmMovePicked = signal(false);

  startSelecting(): void {
    this.selecting.set(true);
    this.picked.set(new Set());
  }

  stopSelecting(): void {
    this.selecting.set(false);
    this.picked.set(new Set());
    this.confirmMovePicked.set(false);
  }

  isPicked(id: string): boolean {
    return this.picked().has(id);
  }

  togglePick(id: string): void {
    const next = new Set(this.picked());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.picked.set(next);
    this.confirmMovePicked.set(false);
  }

  pickAll(): void {
    this.picked.set(new Set(this.scenes().map((scene) => scene.id)));
  }

  pickNone(): void {
    this.picked.set(new Set());
  }

  /** Saves the sure matches for the picked scenes, in the background. */
  matchPicked(): void {
    const ids = [...this.picked()];
    if (ids.length === 0) {
      return;
    }
    this.stopSelecting();
    this.store.startRun(this.api.matchSelected(ids.slice(0, 500)));
  }

  /** Moves the picked scenes' files to Unmatched (tap twice). */
  movePicked(): void {
    const ids = [...this.picked()];
    if (ids.length === 0) {
      return;
    }
    if (!this.confirmMovePicked()) {
      this.confirmMovePicked.set(true);
      setTimeout(() => this.confirmMovePicked.set(false), 5000);
      return;
    }
    this.stopSelecting();
    this.store.startRun(this.api.moveUnmatched(ids.slice(0, 500)));
  }

  lengthDiff(scene: UnmatchedScene, candidate: MatchCandidate): string | null {
    if (!scene.duration || !candidate.duration) {
      return null;
    }
    const diff = Math.round(candidate.duration - scene.duration);
    if (Math.abs(diff) <= 2) {
      return null;
    }
    return `${diff > 0 ? '+' : '−'}${this.store.duration(Math.abs(diff))} vs file`;
  }

  loadScenes(page: number): void {
    this.loadingScenes.set(true);
    // Only the newest request counts when the search changes mid-flight.
    const request = ++this.listRequest;
    const options = {
      q: this.listQuery(),
      sort: this.listSort(),
      scope: this.listScope(),
    };
    this.api.unmatched(page, options).subscribe({
      next: (result) => {
        if (request !== this.listRequest) {
          return;
        }
        this.page = page;
        this.listTotal.set(result.total);
        if (!this.filtered()) {
          this.total.set(result.total);
        }
        if (result.toMove !== undefined) {
          this.toMove.set(result.toMove);
        }
        this.hasMore.set(result.hasMore);
        this.scenes.update((scenes) => (page === 1 ? result.items : [...scenes, ...result.items]));
        this.loadingScenes.set(false);
      },
      error: (error: { error?: { message?: string } }) => {
        if (request !== this.listRequest) {
          return;
        }
        this.loadingScenes.set(false);
        this.store.error.set(error?.error?.message ?? 'Couldn’t load scenes from Stash.');
      },
    });
  }

  private setMatch(id: string, patch: Partial<MatchState>): void {
    const empty: MatchState = {
      loading: false,
      result: null,
      error: null,
      query: '',
      applying: null,
    };
    this.matches.update((all) => ({ ...all, [id]: { ...empty, ...(all[id] ?? {}), ...patch } }));
  }

  ngOnDestroy(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
  }
}
