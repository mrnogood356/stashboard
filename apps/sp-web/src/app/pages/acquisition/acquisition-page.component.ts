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
import { ProgressSpinner } from 'primeng/progressspinner';
import { AcquisitionService } from '../../core/api/acquisition.service';
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
import { SceneStatusBadgeComponent } from '../../shared/scene-status-badge/scene-status-badge.component';
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

type AcquisitionSectionTone = 'attention' | 'pending' | 'active' | 'passive' | 'overview';

interface AcquisitionSummaryCard {
  lifecycle: AcquisitionLifecycleFilter;
  label: string;
  count: number;
  description: string;
  tone: AcquisitionSectionTone;
}

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
    RouterLink,
    FormsModule,
    Message,
    Select,
    ProgressSpinner,
    SceneStatusBadgeComponent,
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
  };
  /** The order the API lists them in (and the Home "Still Waiting" rail shows). */
  private static readonly LIFECYCLE_ORDER: AcquisitionLifecycleState[] = [
    'FAILED',
    'DOWNLOADING',
    'IMPORT_PENDING',
    'REQUESTED',
  ];

  private readonly acquisitionService = inject(AcquisitionService);
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
  protected readonly summaryCards = computed<AcquisitionSummaryCard[]>(() => {
    const totalTracked = this.countForLifecycle('ANY');
    const failedCount = this.countForLifecycle('FAILED');

    return [
      {
        lifecycle: 'ANY',
        label: 'All',
        count: totalTracked,
        description:
          totalTracked === 0
            ? 'Nothing on its way right now.'
            : failedCount > 0
              ? `${this.countLabel(failedCount, 'scene')} need a look.`
              : 'Once in Stash, they move to Library.',
        tone: 'overview',
      },
      {
        lifecycle: 'FAILED',
        label: 'Failed',
        count: this.countForLifecycle('FAILED'),
        description: 'Stopped; need a retry.',
        tone: 'attention',
      },
      {
        lifecycle: 'IMPORT_PENDING',
        label: 'Waiting for Stash',
        count: this.countForLifecycle('IMPORT_PENDING'),
        description: 'Downloaded, not in Stash yet.',
        tone: 'pending',
      },
      {
        lifecycle: 'DOWNLOADING',
        label: 'Downloading',
        count: this.countForLifecycle('DOWNLOADING'),
        description: 'In progress now.',
        tone: 'active',
      },
      {
        lifecycle: 'REQUESTED',
        label: 'Requested',
        count: this.countForLifecycle('REQUESTED'),
        description: 'Waiting to start.',
        tone: 'passive',
      },
    ];
  });
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

  protected lifecycleHelperText(item: AcquisitionSceneItem): string {
    switch (item.status.state) {
      case 'REQUESTED':
        return 'Waiting for Whisparr to pick up this request.';
      case 'DOWNLOADING':
        return 'Whisparr is actively pulling this scene right now.';
      case 'IMPORT_PENDING':
        return 'Whisparr has the file. It isn’t in your Stash library yet.';
      case 'FAILED':
        return 'This item stopped progressing and needs manual attention.';
      default:
        return '';
    }
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
    lifecycle: AcquisitionLifecycleState,
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
      case 'ANY':
      default:
        return 'All';
    }
  }

  private lifecycleDescription(lifecycle: AcquisitionLifecycleState): string {
    switch (lifecycle) {
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
    lifecycle: AcquisitionLifecycleState,
  ): Exclude<AcquisitionSectionTone, 'overview'> {
    switch (lifecycle) {
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
    return value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
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
        lifecycle === 'FAILED'
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
