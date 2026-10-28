import { StageTrackComponent } from '../../shared/stage-track/stage-track.component';
import {
  Stage,
  buildStages,
  stagesForStatus,
  timeLeftText,
} from '../../shared/stage-track/stage-track';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SelectionBarComponent } from '../../shared/selection-bar/selection-bar.component';
import {
  AfterViewInit,
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
import { finalize, Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { Message } from 'primeng/message';
import { Select } from 'primeng/select';
import { AcquisitionService } from '../../core/api/acquisition.service';
import {
  DownloadHandoffApiService,
  ProcessingHandoff,
} from '../../core/api/download-handoff.service';
import { ReleaseSearchService } from '../../core/releases/release-search.service';
import { OrganizerApiService, WaitingCheck } from '../../core/api/organizer.service';
import {
  AcquisitionCountsByLifecycle,
  AcquisitionFeedOptions,
  AcquisitionLifecycleFilter,
  AcquisitionLifecycleState,
  AcquisitionSceneItem,
  AcquisitionSort,
} from '../../core/api/acquisition.types';
import { RuntimeHealthService } from '../../core/api/runtime-health.service';
import { SetupStatusStore } from '../../core/api/setup-status.store';
import { SceneTimelineComponent } from '../../shared/scene-timeline/scene-timeline.component';
import {
  SceneTimeline,
  TimelineAction,
  TimelineApiService,
  timelineTone,
} from '../../core/api/timeline.service';
import {
  buildReadinessPageAlert,
  firstUseEmptyStateCopy,
  initialIndexingGuidance,
} from '../../shared/readiness/first-run-readiness.utils';

type AcquisitionSectionTone = 'attention' | 'pending' | 'active' | 'passive' | 'done' | 'overview';

interface AcquisitionTab {
  lifecycle: AcquisitionLifecycleFilter;
  label: string;
  count: number;
  tone: AcquisitionSectionTone;
}

/** A failed download you started stays on Requests this long. */
const FAILED_HANDOFF_SHOWN_MS = 24 * 3600_000;
/** While something is downloading, the list refreshes itself this often. */
const LIVE_REFRESH_MS = 15_000;
/** The API sends at most 50 at once: up to two pages refresh as one. */
const LIVE_REFRESH_MAX = 48;

interface AcquisitionSectionView {
  /** 'ANY' is the single flat list shown when sorting by date or title. */
  lifecycle: AcquisitionLifecycleFilter;
  label: string;
  description: string;
  tone: AcquisitionSectionTone;
  totalCount: number;
  items: AcquisitionSceneItem[];
}

interface AcquisitionUrlState {
  lifecycle: AcquisitionLifecycleFilter;
  q: string;
  sort: AcquisitionSort;
}

export const ACQUISITION_SORT_OPTIONS: ReadonlyArray<{ value: AcquisitionSort; label: string }> = [
  { value: 'status', label: 'Pipeline order' },
  { value: 'requested-desc', label: 'Newest requested' },
  { value: 'requested-asc', label: 'Oldest requested' },
  { value: 'released-desc', label: 'Newest release' },
  { value: 'released-asc', label: 'Oldest release' },
  { value: 'title', label: 'Title (A–Z)' },
];

const SEARCH_DEBOUNCE_MS = 300;

interface AcquisitionPageAlert {
  eyebrow: string;
  title: string;
  message: string;
}

@Component({
  selector: 'app-acquisition-page',
  imports: [
    StageTrackComponent,
    SkeletonComponent,
    RouterLink,
    FormsModule,
    Message,
    Select,
    SelectionBarComponent,
    SceneTimelineComponent,
  ],
  templateUrl: './acquisition-page.component.html',
  styleUrl: './acquisition-page.component.scss',
})
export class AcquisitionPageComponent implements OnInit, AfterViewInit, OnDestroy {
  private static readonly PAGE_SIZE = 24;
  private static readonly EMPTY_COUNTS: AcquisitionCountsByLifecycle = {
    REQUESTED: 0,
    DOWNLOADING: 0,
    IMPORT_PENDING: 0,
    FAILED: 0,
    AVAILABLE: 0,
  };
  /** The order the API lists them in (and the Home "Still Waiting" rail shows). */
  private static readonly LIFECYCLE_ORDER: AcquisitionLifecycleState[] = [
    'FAILED',
    'DOWNLOADING',
    'IMPORT_PENDING',
    'REQUESTED',
  ];

  private readonly acquisitionService = inject(AcquisitionService);
  private readonly downloadsApi = inject(DownloadHandoffApiService);

  // ---------- downloads you started (Find downloads, Prowlarr) ----------

  /** In flight, or failed in the last day; SABnzbd's, so not in Whisparr's list. */
  protected readonly handoffs = signal<ProcessingHandoff[]>([]);
  private handoffsLoading = false;

  /** Only All and Downloading show them, and not while searching. */
  private showsHandoffs(): boolean {
    const lifecycle = this.selectedLifecycle();
    return !this.hasSearch() && (lifecycle === 'ANY' || lifecycle === 'DOWNLOADING');
  }

  private loadHandoffs(): void {
    if (!this.showsHandoffs()) {
      this.handoffs.set([]);
      return;
    }
    if (this.handoffsLoading) {
      return;
    }
    this.handoffsLoading = true;
    const lifecycle = this.selectedLifecycle();
    this.downloadsApi
      .processing()
      .pipe(finalize(() => (this.handoffsLoading = false)))
      .subscribe({
        next: (processing) => {
          if (this.selectedLifecycle() !== lifecycle || !this.showsHandoffs()) {
            return;
          }
          const since = Date.now() - FAILED_HANDOFF_SHOWN_MS;
          const active = processing.handoffs.filter((handoff) => handoff.stage !== 'ignored');
          const failed = processing.recentHandoffs.filter(
            (handoff) => handoff.stage === 'failed' && Date.parse(handoff.updatedAt) >= since,
          );
          this.handoffs.set(
            lifecycle === 'DOWNLOADING'
              ? active.filter((handoff) =>
                  ['queued', 'downloading', 'unpacking'].includes(handoff.stage),
                )
              : [...active, ...failed],
          );
        },
        // Without SABnzbd the rest of Requests still works.
        error: () => this.handoffs.set([]),
      });
  }

  /** The same four steps as a request, from where SABnzbd and Stashboard are. */
  protected handoffStages(handoff: ProcessingHandoff): Stage[] {
    switch (handoff.stage) {
      case 'queued':
        return buildStages(0);
      case 'downloading':
      case 'unpacking':
        return buildStages(1);
      case 'moving':
      case 'linking':
        return buildStages(2);
      case 'done':
        return buildStages(3, { finished: true });
      default:
        // Failed after it was moved in: it stopped at Waiting for Stash.
        return buildStages(handoff.finalPath ? 2 : 1, { failed: true });
    }
  }

  protected handoffProgressText(handoff: ProcessingHandoff): string | null {
    const left = timeLeftText(handoff.timeLeft);
    const parts = [handoff.progress !== null ? `${handoff.progress}%` : null, left].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  private handoffsActive(): boolean {
    return this.handoffs().some((handoff) =>
      ['queued', 'downloading', 'unpacking', 'moving', 'linking'].includes(handoff.stage),
    );
  }
  private readonly notifications = inject(AppNotificationsService);
  private readonly timelineApi = inject(TimelineApiService);

  // ---------- "where it is now" on each card ----------

  /** The short timeline for each loaded card, by scene; one request per page of cards. */
  protected readonly timelines = signal<ReadonlyMap<string, SceneTimeline>>(new Map());
  /** Cards whose whole timeline is open. */
  protected readonly openTimelines = signal<ReadonlySet<string>>(new Set());
  protected readonly timelineTone = timelineTone;

  protected isTimelineOpen(id: string): boolean {
    return this.openTimelines().has(id);
  }

  protected toggleTimeline(id: string): void {
    const next = new Set(this.openTimelines());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.openTimelines.set(next);
  }

  protected onTimelineAction(item: AcquisitionSceneItem, action: TimelineAction): void {
    if (action.kind === 'pick-release') {
      this.pickRelease(item);
    } else {
      this.openScene(item);
    }
  }

  /** The scene's page, where "Why is it like this?" has the raw facts. */
  protected openScene(item: AcquisitionSceneItem): void {
    void this.router.navigate(['/scene', item.id], {
      queryParams: { returnTo: this.currentRouteUrl() },
    });
  }

  /** Fetches the cards' one-liners in one go; without them the cards still work. */
  private loadTimelines(ids: string[], version: number): void {
    const wanted = ids.filter((id) => !this.timelines().has(id));
    if (wanted.length === 0) {
      return;
    }
    this.timelineApi.scenes(wanted).subscribe({
      next: (items) => {
        if (version !== this.feedVersion) {
          return;
        }
        const next = new Map(this.timelines());
        for (const item of items) {
          next.set(item.stashId, item);
        }
        this.timelines.set(next);
      },
      error: () => undefined,
    });
  }

  // ---------- picking scenes for bulk actions ----------

  protected readonly selecting = signal(false);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly bulkBusy = signal(false);
  protected readonly confirmRemove = signal(false);

  protected startSelecting(): void {
    this.selecting.set(true);
    this.picked.set(new Set());
  }

  protected stopSelecting(): void {
    this.selecting.set(false);
    this.picked.set(new Set());
    this.confirmRemove.set(false);
  }

  protected isPicked(id: string): boolean {
    return this.picked().has(id);
  }

  protected togglePick(id: string): void {
    const next = new Set(this.picked());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.picked.set(next);
    this.confirmRemove.set(false);
  }

  protected pickAll(): void {
    this.picked.set(new Set(this.items().map((item) => item.id)));
  }

  protected pickNone(): void {
    this.picked.set(new Set());
  }

  /** Searches again for, or removes, the picked scenes; removing needs a second tap. */
  protected runBulk(action: 'search' | 'remove'): void {
    const ids = [...this.picked()];
    if (ids.length === 0 || this.bulkBusy()) {
      return;
    }
    if (action === 'remove' && !this.confirmRemove()) {
      this.confirmRemove.set(true);
      setTimeout(() => this.confirmRemove.set(false), 5000);
      return;
    }
    this.confirmRemove.set(false);
    this.bulkBusy.set(true);
    this.acquisitionService.bulk(action, ids.slice(0, 100)).subscribe({
      next: (result) => {
        this.bulkBusy.set(false);
        const what =
          action === 'search'
            ? `Searching again for ${result.done}`
            : `Removed ${result.done} from Whisparr`;
        if (result.failed.length) {
          this.notifications.error(
            `${what}, ${result.failed.length} didn’t work`,
            result.failed[0].reason,
          );
        } else {
          this.notifications.success(
            what,
            result.done === 1 ? '1 scene.' : `${result.done} scenes.`,
          );
        }
        this.stopSelecting();
        if (action === 'remove') {
          this.resetFeedAndReload();
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.bulkBusy.set(false);
        this.notifications.error('That didn’t work', error?.error?.message ?? 'Try again.');
      },
    });
  }
  private readonly organizerService = inject(OrganizerApiService);
  private readonly releaseSearch = inject(ReleaseSearchService);
  private grabbedSubscription?: Subscription;
  private readonly runtimeHealthService = inject(RuntimeHealthService);
  private readonly setupStatusStore = inject(SetupStatusStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private queryParamSubscription: Subscription | null = null;
  private observer: IntersectionObserver | null = null;
  private sentinelElement: HTMLDivElement | null = null;
  private sentinelIntersecting = false;
  private feedVersion = 0;
  private pendingReload = false;
  private hasHydratedFromUrl = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private liveRefreshing = false;

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
  protected readonly checkingWaiting = signal(false);
  protected readonly waitingCheck = signal<WaitingCheck | null>(null);
  protected readonly waitingCheckError = signal<string | null>(null);
  /** Why each scene waits for import, by scene, from the last check. */
  protected readonly waitingReasons = computed(
    () => new Map((this.waitingCheck()?.left ?? []).map((scene) => [scene.stashId, scene])),
  );
  /** Waiting scenes the check explained that aren't among the cards loaded. */
  protected readonly waitingNotShown = computed(() => {
    const shown = new Set(this.items().map((item) => item.id));
    return (this.waitingCheck()?.left ?? []).filter((scene) => !shown.has(scene.stashId));
  });
  /** The page checks "Waiting for Stash" by itself once, so every card says why. */
  private waitingAutoChecked = false;
  protected readonly loadingMore = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly loadMoreError = signal<string | null>(null);
  protected readonly total = signal(0);
  protected readonly page = signal(0);
  protected readonly hasMore = signal(true);
  protected readonly inFlight = signal(false);
  protected readonly items = signal<AcquisitionSceneItem[]>([]);
  protected readonly runtimeHealth = this.runtimeHealthService.status;
  protected readonly selectedLifecycle = signal<AcquisitionLifecycleFilter>('ANY');
  protected readonly sortOptions = [...ACQUISITION_SORT_OPTIONS];
  /** The search the list is showing; `searchDraft` is what is typed so far. */
  protected readonly searchQuery = signal('');
  protected readonly searchDraft = signal('');
  protected readonly selectedSort = signal<AcquisitionSort>('status');
  protected readonly countsByLifecycle = signal<AcquisitionCountsByLifecycle>(
    AcquisitionPageComponent.EMPTY_COUNTS,
  );
  protected readonly tabs = computed<AcquisitionTab[]>(() =>
    (['ANY', 'REQUESTED', 'DOWNLOADING', 'IMPORT_PENDING', 'FAILED', 'AVAILABLE'] as const).map(
      (lifecycle) => ({
        lifecycle,
        label: this.filterLabel(lifecycle),
        count: this.countForLifecycle(lifecycle),
        tone: lifecycle === 'ANY' ? 'overview' : this.lifecycleTone(lifecycle),
      }),
    ),
  );
  protected readonly visibleSections = computed<AcquisitionSectionView[]>(() => {
    const items = this.items();
    const selectedLifecycle = this.selectedLifecycle();

    // Sorted by date or title: one list in that order, not grouped by stage.
    if (selectedLifecycle === 'ANY' && this.selectedSort() !== 'status') {
      return [
        {
          lifecycle: 'ANY',
          label: 'All tracked',
          description: `Sorted by ${this.sortLabel(this.selectedSort()).toLowerCase()}.`,
          tone: 'overview',
          totalCount: this.total(),
          items,
        },
      ];
    }

    if (selectedLifecycle !== 'ANY') {
      return [
        this.buildSection(selectedLifecycle, items, this.countForLifecycle(selectedLifecycle)),
      ];
    }

    return AcquisitionPageComponent.LIFECYCLE_ORDER.map((lifecycle) =>
      this.buildSection(
        lifecycle,
        items.filter((item) => item.status.state === lifecycle),
        this.countForLifecycle(lifecycle),
      ),
    ).filter((section) => section.items.length > 0);
  });
  protected readonly pageAlert = computed<AcquisitionPageAlert | null>(() => {
    return buildReadinessPageAlert(
      'acquisition',
      this.setupStatusStore.status(),
      this.runtimeHealth(),
    );
  });

  ngOnInit(): void {
    this.runtimeHealthService.ensureStarted();
    this.setupUrlStateSync();
    this.liveTimer = setInterval(() => this.liveRefresh(), LIVE_REFRESH_MS);
    // A release picked from a card is downloading now: show it moving.
    this.grabbedSubscription = this.releaseSearch.grabbed.subscribe(() =>
      this.resetFeedAndReload(),
    );
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
    this.grabbedSubscription?.unsubscribe();
    this.cancelSearchTimer();
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
    }
  }

  protected hasSearch(): boolean {
    return this.searchQuery().length > 0;
  }

  protected onSearchInput(value: string): void {
    this.searchDraft.set(value);
    this.cancelSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.applySearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Enter searches right away instead of waiting for the pause. */
  protected submitSearch(): void {
    this.cancelSearchTimer();
    this.applySearch(this.searchDraft());
  }

  protected clearSearch(): void {
    this.cancelSearchTimer();
    this.searchDraft.set('');
    this.applySearch('');
  }

  protected selectSort(value: string): void {
    const next = this.readSort(value);
    if (this.selectedSort() === next) {
      return;
    }

    this.selectedSort.set(next);
    this.syncUrlWithCurrentFilter(false);
    this.resetFeedAndReload();
  }

  private applySearch(value: string): void {
    const next = value.trim();
    if (this.searchQuery() === next) {
      return;
    }

    this.searchQuery.set(next);
    this.syncUrlWithCurrentFilter(true);
    this.resetFeedAndReload();
  }

  private cancelSearchTimer(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private sortLabel(sort: AcquisitionSort): string {
    return this.sortOptions.find((option) => option.value === sort)?.label ?? 'Pipeline order';
  }

  private feedOptions(): AcquisitionFeedOptions {
    return { q: this.searchQuery(), sort: this.selectedSort() };
  }

  protected hasItems(): boolean {
    return this.items().length > 0;
  }

  protected retryInitialLoad(): void {
    if (this.inFlight()) {
      return;
    }

    this.runtimeHealthService.requestRefresh();
    this.error.set(null);
    this.loadNextPage();
  }

  /** Whisparr's interactive search for this scene, right from the list. */
  protected pickRelease(item: AcquisitionSceneItem): void {
    this.releaseSearch.open({ stashId: item.id, title: item.title, source: 'whisparr' });
  }

  /** Fixes what it can for "waiting for import" and says why the rest wait. */
  protected checkWaiting(): void {
    if (this.checkingWaiting()) {
      return;
    }
    this.checkingWaiting.set(true);
    this.waitingCheckError.set(null);
    this.organizerService
      .checkWaiting()
      .pipe(finalize(() => this.checkingWaiting.set(false)))
      .subscribe({
        next: (result) => {
          this.waitingCheck.set(result);
          if (result.fixed > 0) {
            this.resetFeedAndReload();
          }
        },
        error: () => this.waitingCheckError.set('Couldn’t check these scenes. Try again.'),
      });
  }

  /** Counts Whisparr's scene as the one Stash has, so it stops waiting. */
  protected markSameScene(stashId: string): void {
    if (this.checkingWaiting()) {
      return;
    }
    this.checkingWaiting.set(true);
    this.waitingCheckError.set(null);
    this.organizerService
      .markSameScene(stashId)
      .pipe(finalize(() => this.checkingWaiting.set(false)))
      .subscribe({
        next: (result) => {
          this.waitingCheck.set(result);
          this.resetFeedAndReload();
        },
        error: (error: { error?: { message?: unknown } }) => {
          const message = error?.error?.message;
          this.waitingCheckError.set(
            typeof message === 'string' && message
              ? message
              : 'Couldn’t link that scene. Try again.',
          );
        },
      });
  }

  protected retryLoadMore(): void {
    if (this.inFlight() || !this.hasMore()) {
      return;
    }

    this.loadMoreError.set(null);
    this.loadNextPage();
  }

  protected selectLifecycle(next: AcquisitionLifecycleFilter): void {
    if (this.selectedLifecycle() === next) {
      return;
    }

    this.selectedLifecycle.set(next);
    this.syncUrlWithCurrentFilter(false);
    this.resetFeedAndReload();
  }

  protected countForLifecycle(lifecycle: AcquisitionLifecycleFilter): number {
    const counts = this.countsByLifecycle();

    switch (lifecycle) {
      case 'REQUESTED':
        return counts.REQUESTED;
      case 'DOWNLOADING':
        return counts.DOWNLOADING;
      case 'IMPORT_PENDING':
        return counts.IMPORT_PENDING;
      case 'FAILED':
        return counts.FAILED;
      case 'AVAILABLE':
        return counts.AVAILABLE ?? 0;
      case 'ANY':
      default:
        return counts.REQUESTED + counts.DOWNLOADING + counts.IMPORT_PENDING + counts.FAILED;
    }
  }

  protected pageSummaryText(): string {
    if (this.hasSearch()) {
      return `${this.countLabel(this.total(), 'scene')} match “${this.searchQuery()}”.`;
    }

    const totalTracked = this.countForLifecycle('ANY');
    const failedCount = this.countForLifecycle('FAILED');
    const selectedLifecycle = this.selectedLifecycle();

    if (selectedLifecycle === 'ANY') {
      if (totalTracked === 0) {
        return 'Nothing is active right now. New requests begin in Scenes and completed imports continue in Library.';
      }

      if (failedCount > 0) {
        return `${this.countLabel(failedCount, 'scene')} need attention first. The remaining sections show what is still progressing normally.`;
      }

      return `${this.countLabel(totalTracked, 'scene')} are moving through Whisparr and toward your library right now.`;
    }

    return `${this.total()} ${this.filterLabel(selectedLifecycle).toLowerCase()} scenes match the current focus.`;
  }

  /** Requested → Downloading → Waiting for Stash → In library, with where it is now. */
  protected stages(item: AcquisitionSceneItem): Stage[] {
    return stagesForStatus(item.status.state, item.queueState);
  }

  /** "45% · 6 min left", or null when Whisparr hasn't said. */
  protected downloadText(item: AcquisitionSceneItem): string | null {
    const download = item.download;
    if (!download || (download.progress === null && !download.timeLeft)) {
      return null;
    }
    const left = timeLeftText(download.timeLeft);
    return [download.progress !== null ? `${download.progress}%` : null, left]
      .filter(Boolean)
      .join(' · ');
  }

  /** "May 14, 2026 · Velvet Films": the release date and studio on one line. */
  protected cardMeta(releaseDate: string | null, studio: string | null): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(releaseDate ?? '');
    const date = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString(
          undefined,
          { year: 'numeric', month: 'short', day: 'numeric' },
        )
      : releaseDate;
    const line = [date, studio].filter(Boolean).join(' · ');
    return line || null;
  }

  /** "Added today", "Added yesterday", "Added 3 days ago". */
  protected addedText(item: AcquisitionSceneItem): string | null {
    const added = item.addedAt ? new Date(item.addedAt) : null;
    if (!added || Number.isNaN(added.getTime())) {
      return null;
    }
    const startOfDay = (date: Date) =>
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((startOfDay(new Date()) - startOfDay(added)) / 86_400_000);
    if (days <= 0) {
      return 'Added today';
    }
    return days === 1 ? 'Added yesterday' : `Added ${days} days ago`;
  }

  /** The track says where it is; only a failure with no reason needs words. */
  protected lifecycleHelperText(item: AcquisitionSceneItem): string {
    return item.status.state === 'FAILED' && !this.operationalDetail(item)
      ? 'This stopped and needs a look.'
      : '';
  }

  protected operationalDetail(item: AcquisitionSceneItem): string | null {
    if (item.status.state === 'FAILED') {
      if (item.errorMessage?.trim()) {
        return `Whisparr reported: ${item.errorMessage.trim()}`;
      }

      // Downloaded but Whisparr won't import it: the file isn't in the library.
      if (/^import\s*(blocked|failed)$/i.test(item.queueState?.trim() ?? '')) {
        return 'Whisparr downloaded it but couldn’t import it. Import it by hand in Whisparr.';
      }

      if (item.queueStatus?.trim()) {
        return `Whisparr marked this item as ${this.humanizeStatus(item.queueStatus)}.`;
      }

      return 'Open Whisparr to inspect the failed queue item and retry or repair it there.';
    }

    if (item.status.state === 'IMPORT_PENDING') {
      if (item.queueState?.trim()) {
        return `Whisparr is in ${this.humanizeStatus(item.queueState)} while Stash catches up.`;
      }

      return null;
    }

    if (item.status.state === 'DOWNLOADING') {
      if (item.queueStatus?.trim() && item.queueStatus.trim().toLowerCase() !== 'downloading') {
        return `Whisparr currently reports ${this.humanizeStatus(item.queueStatus)}.`;
      }

      return null;
    }

    if (item.status.state === 'REQUESTED' && item.queueStatus?.trim()) {
      return `Whisparr currently reports ${this.humanizeStatus(item.queueStatus)}.`;
    }

    return null;
  }

  protected emptyStateTitle(): string {
    if (this.hasSearch()) {
      return `Nothing matches “${this.searchQuery()}”`;
    }

    switch (this.selectedLifecycle()) {
      case 'FAILED':
        return 'No failed scenes right now';
      case 'IMPORT_PENDING':
        return 'Nothing is waiting on import';
      case 'DOWNLOADING':
        return 'Nothing is downloading right now';
      case 'REQUESTED':
        return 'No queued requests are waiting to start';
      case 'AVAILABLE':
        return 'Nothing new in the last two weeks';
      case 'ANY':
      default:
        return firstUseEmptyStateCopy('acquisition').title;
    }
  }

  protected emptyStateMessage(): string {
    if (this.hasSearch()) {
      return 'Search looks at scene titles and studio names. Try fewer words, or clear the search.';
    }

    if (this.selectedLifecycle() === 'ANY' && this.pageAlert()) {
      return 'Acquisition may look empty because Whisparr or Stash is degraded. Repair integrations, then run Sync All from Indexing & Sync if tracked requests still do not appear.';
    }

    switch (this.selectedLifecycle()) {
      case 'FAILED':
        return 'There is nothing to recover in Whisparr at the moment. Switch back to the full pipeline or request something new from Scenes.';
      case 'IMPORT_PENDING':
        return 'Downloads are not waiting on the final Stash handoff right now.';
      case 'DOWNLOADING':
        return 'Whisparr does not have any active acquisition work in progress right now.';
      case 'REQUESTED':
        return 'Whisparr is not holding any queued requests that have not started yet.';
      case 'AVAILABLE':
        return 'Requests show up here for two weeks once they’re in your library.';
      case 'ANY':
      default:
        return firstUseEmptyStateCopy('acquisition').message;
    }
  }

  protected indexingGuidance(): string {
    return initialIndexingGuidance();
  }

  protected currentRouteUrl(): string {
    return this.router.url;
  }

  protected countLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  protected sectionVisibleCountLabel(section: AcquisitionSectionView): string {
    if (section.totalCount === section.items.length) {
      return this.countLabel(section.totalCount, 'scene');
    }

    return `${this.countLabel(section.items.length, 'scene')} shown of ${section.totalCount}`;
  }

  private buildSection(
    lifecycle: Exclude<AcquisitionLifecycleFilter, 'ANY'>,
    items: AcquisitionSceneItem[],
    totalCount: number,
  ): AcquisitionSectionView {
    return {
      lifecycle,
      label: this.filterLabel(lifecycle),
      description: this.lifecycleDescription(lifecycle),
      tone: this.lifecycleTone(lifecycle),
      totalCount,
      items,
    };
  }

  private filterLabel(lifecycle: AcquisitionLifecycleFilter): string {
    switch (lifecycle) {
      case 'REQUESTED':
        return 'Requested';
      case 'DOWNLOADING':
        return 'Downloading';
      case 'IMPORT_PENDING':
        return 'Waiting for Stash';
      case 'FAILED':
        return 'Failed';
      case 'AVAILABLE':
        return 'Added';
      case 'ANY':
      default:
        return 'All';
    }
  }

  private lifecycleDescription(lifecycle: Exclude<AcquisitionLifecycleFilter, 'ANY'>): string {
    switch (lifecycle) {
      case 'AVAILABLE':
        return 'In your library now. From the last two weeks.';
      case 'FAILED':
        return 'These stopped. Check them in Whisparr and retry.';
      case 'IMPORT_PENDING':
        return 'Downloaded, and waiting to show up in Stash.';
      case 'DOWNLOADING':
        return 'Downloading now.';
      case 'REQUESTED':
      default:
        return 'Waiting for Whisparr to start them.';
    }
  }

  private lifecycleTone(
    lifecycle: Exclude<AcquisitionLifecycleFilter, 'ANY'>,
  ): Exclude<AcquisitionSectionTone, 'overview'> {
    switch (lifecycle) {
      case 'AVAILABLE':
        return 'done';
      case 'FAILED':
        return 'attention';
      case 'IMPORT_PENDING':
        return 'pending';
      case 'DOWNLOADING':
        return 'active';
      case 'REQUESTED':
      default:
        return 'passive';
    }
  }

  private humanizeStatus(value: string): string {
    return value
      .trim()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
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

    this.acquisitionService
      .getScenesFeed(
        nextPage,
        AcquisitionPageComponent.PAGE_SIZE,
        this.selectedLifecycle(),
        this.feedOptions(),
      )
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

          if (this.sentinelIntersecting && this.hasMore()) {
            this.loadNextPage();
          }
        }),
      )
      .subscribe({
        next: (response) => {
          if (requestVersion !== this.feedVersion) {
            return;
          }

          this.countsByLifecycle.set(response.countsByLifecycle);
          if (!this.waitingAutoChecked && response.countsByLifecycle.IMPORT_PENDING > 0) {
            this.waitingAutoChecked = true;
            this.checkWaiting();
          }
          this.total.set(response.total);
          this.page.set(response.page);
          this.hasMore.set(response.hasMore);
          this.items.update((current) =>
            isInitialPage ? response.items : [...current, ...response.items],
          );
          this.loadTimelines(
            response.items.map((item) => item.id),
            requestVersion,
          );
        },
        error: () => {
          if (requestVersion !== this.feedVersion) {
            return;
          }

          if (isInitialPage) {
            this.error.set('Failed to load acquisition feed from the API.');
          } else {
            this.loadMoreError.set('Failed to load more acquisition scenes.');
          }
        },
      });
  }

  /**
   * While something on screen is downloading, quietly fetch the list again so
   * the bars move and finished ones move on. Up to two pages are replaced
   * outright; past that the loaded cards are updated where they are.
   */
  private liveRefresh(): void {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (visible && this.handoffsActive()) {
      this.loadHandoffs();
    }
    if (
      this.liveRefreshing ||
      this.inFlight() ||
      this.loading() ||
      this.selecting() ||
      this.selectedLifecycle() === 'AVAILABLE' ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden') ||
      !this.items().some((item) => item.status.state === 'DOWNLOADING')
    ) {
      return;
    }

    const pageAtStart = this.page();
    const loaded = pageAtStart * AcquisitionPageComponent.PAGE_SIZE;
    const replace = loaded <= LIVE_REFRESH_MAX;
    const version = this.feedVersion;
    this.liveRefreshing = true;
    this.acquisitionService
      .getScenesFeed(
        1,
        replace ? loaded : LIVE_REFRESH_MAX,
        this.selectedLifecycle(),
        this.feedOptions(),
      )
      .pipe(finalize(() => (this.liveRefreshing = false)))
      .subscribe({
        next: (response) => {
          // A filter, search, reload or another page loaded since then wins:
          // replacing the list now would drop the newer cards.
          if (version !== this.feedVersion || this.inFlight() || this.page() !== pageAtStart) {
            return;
          }
          this.countsByLifecycle.set(response.countsByLifecycle);
          if (replace) {
            this.total.set(response.total);
            this.hasMore.set(response.hasMore);
            this.items.set(response.items);
          } else {
            const fresh = new Map(response.items.map((item) => [item.id, item]));
            this.items.update((current) => current.map((item) => fresh.get(item.id) ?? item));
          }
          this.loadTimelines(
            response.items.map((item) => item.id),
            version,
          );
        },
        error: () => undefined,
      });
  }

  private setupUrlStateSync(): void {
    this.queryParamSubscription = this.route.queryParamMap.subscribe((queryParamMap) => {
      const lifecycle = this.readUrlState(queryParamMap);
      const changed = this.applyUrlState(lifecycle);

      if (!this.hasHydratedFromUrl || changed) {
        this.hasHydratedFromUrl = true;
        this.resetFeedAndReload();
        return;
      }

      this.hasHydratedFromUrl = true;
    });
  }

  private readUrlState(queryParamMap: import('@angular/router').ParamMap): AcquisitionUrlState {
    const lifecycle = queryParamMap.get('lifecycle');

    return {
      lifecycle:
        lifecycle === 'REQUESTED' ||
        lifecycle === 'DOWNLOADING' ||
        lifecycle === 'IMPORT_PENDING' ||
        lifecycle === 'FAILED' ||
        lifecycle === 'AVAILABLE'
          ? lifecycle
          : 'ANY',
      q: (queryParamMap.get('q') ?? '').trim(),
      sort: this.readSort(queryParamMap.get('sort')),
    };
  }

  private readSort(value: string | null): AcquisitionSort {
    return this.sortOptions.find((option) => option.value === value)?.value ?? 'status';
  }

  private applyUrlState(state: AcquisitionUrlState): boolean {
    if (state.q !== this.searchQuery()) {
      this.cancelSearchTimer();
      this.searchDraft.set(state.q);
    }

    if (
      this.selectedLifecycle() === state.lifecycle &&
      this.searchQuery() === state.q &&
      this.selectedSort() === state.sort
    ) {
      return false;
    }

    this.selectedLifecycle.set(state.lifecycle);
    this.searchQuery.set(state.q);
    this.selectedSort.set(state.sort);
    return true;
  }

  private syncUrlWithCurrentFilter(replaceUrl: boolean): void {
    const next = {
      lifecycle: this.selectedLifecycle() === 'ANY' ? null : this.selectedLifecycle(),
      q: this.searchQuery() || null,
      sort: this.selectedSort() === 'status' ? null : this.selectedSort(),
    };
    const current = this.route.snapshot.queryParamMap;

    if (
      (current.get('lifecycle') ?? null) === next.lifecycle &&
      (current.get('q') ?? null) === next.q &&
      (current.get('sort') ?? null) === next.sort
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
    // Things have moved on: ask again rather than show old answers.
    this.timelines.set(new Map());
    this.loading.set(false);
    this.loadingMore.set(false);
    this.error.set(null);
    this.loadMoreError.set(null);
    this.loadHandoffs();

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

          if (this.inFlight() || !this.hasMore()) {
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
}
