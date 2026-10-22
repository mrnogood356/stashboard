import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { SceneTimeline, TimelineApiService } from '../../core/api/timeline.service';
import { AcquisitionService } from '../../core/api/acquisition.service';
import { OrganizerApiService } from '../../core/api/organizer.service';
import {
  AcquisitionLifecycleFilter,
  AcquisitionSceneItem,
  AcquisitionScenesResponse,
} from '../../core/api/acquisition.types';
import { RuntimeHealthService } from '../../core/api/runtime-health.service';
import { RuntimeHealthResponse } from '../../core/api/runtime-health.types';
import { SetupStatusStore } from '../../core/api/setup-status.store';
import { SetupStatusResponse } from '../../core/api/setup.types';
import { AcquisitionPageComponent } from './acquisition-page.component';

function buildItem(overrides: Partial<AcquisitionSceneItem> = {}): AcquisitionSceneItem {
  return {
    id: 'scene-1',
    title: 'Scene Title',
    description: 'Scene description',
    imageUrl: 'http://cdn.local/image.jpg',
    cardImageUrl: 'http://cdn.local/card.jpg',
    studioId: 'studio-1',
    studio: 'Studio',
    studioImageUrl: 'http://cdn.local/studio.jpg',
    releaseDate: '2026-03-01',
    duration: 720,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'FAILED' },
    queueStatus: 'failed',
    queueState: 'warning',
    errorMessage: null,
    whisparrViewUrl: 'http://whisparr.local/movie/scene-1',
    ...overrides,
  };
}

function buildResponse(
  items: AcquisitionSceneItem[],
  overrides: Partial<AcquisitionScenesResponse> = {},
): AcquisitionScenesResponse {
  return {
    total: items.length,
    page: 1,
    perPage: 24,
    hasMore: false,
    countsByLifecycle: {
      REQUESTED: items.filter((item) => item.status.state === 'REQUESTED').length,
      DOWNLOADING: items.filter((item) => item.status.state === 'DOWNLOADING').length,
      IMPORT_PENDING: items.filter((item) => item.status.state === 'IMPORT_PENDING').length,
      FAILED: items.filter((item) => item.status.state === 'FAILED').length,
    },
    items,
    ...overrides,
  };
}

function buildSetupStatus(
  overrides: Partial<Omit<SetupStatusResponse, 'required'>> & {
    required?: Partial<SetupStatusResponse['required']>;
  } = {},
): SetupStatusResponse {
  return {
    setupComplete: overrides.setupComplete ?? true,
    required: {
      stash: true,
      catalog: true,
      whisparr: true,
      ...(overrides.required ?? {}),
    },
    catalogProvider: overrides.catalogProvider ?? 'STASHDB',
  };
}

const HEALTHY_RUNTIME_HEALTH: RuntimeHealthResponse = {
  degraded: false,
  failureThreshold: 3,
  services: {
    catalog: {
      service: 'CATALOG',
      status: 'HEALTHY',
      degraded: false,
      consecutiveFailures: 0,
      lastHealthyAt: '2026-04-02T00:00:00.000Z',
      lastFailureAt: null,
      lastErrorMessage: null,
      degradedAt: null,
    },
    stash: {
      service: 'STASH',
      status: 'HEALTHY',
      degraded: false,
      consecutiveFailures: 0,
      lastHealthyAt: '2026-04-02T00:00:00.000Z',
      lastFailureAt: null,
      lastErrorMessage: null,
      degradedAt: null,
    },
    whisparr: {
      service: 'WHISPARR',
      status: 'HEALTHY',
      degraded: false,
      consecutiveFailures: 0,
      lastHealthyAt: '2026-04-02T00:00:00.000Z',
      lastFailureAt: null,
      lastErrorMessage: null,
      degradedAt: null,
    },
  },
};

function buildRuntimeHealth(
  overrides: Partial<Omit<RuntimeHealthResponse, 'services'>> & {
    services?: Partial<RuntimeHealthResponse['services']>;
  } = {},
): RuntimeHealthResponse {
  return {
    degraded: overrides.degraded ?? HEALTHY_RUNTIME_HEALTH.degraded,
    failureThreshold: overrides.failureThreshold ?? HEALTHY_RUNTIME_HEALTH.failureThreshold,
    services: {
      catalog: overrides.services?.catalog ?? HEALTHY_RUNTIME_HEALTH.services.catalog,
      stash: overrides.services?.stash ?? HEALTHY_RUNTIME_HEALTH.services.stash,
      whisparr: overrides.services?.whisparr ?? HEALTHY_RUNTIME_HEALTH.services.whisparr,
    },
  };
}

function buildWhisparrDegradedRuntimeHealth(): RuntimeHealthResponse {
  return buildRuntimeHealth({
    degraded: true,
    services: {
      whisparr: {
        service: 'WHISPARR',
        status: 'DEGRADED',
        degraded: true,
        consecutiveFailures: 4,
        lastHealthyAt: '2026-04-01T23:50:00.000Z',
        lastFailureAt: '2026-04-02T00:01:00.000Z',
        lastErrorMessage: 'Failed to reach Whisparr provider endpoint.',
        degradedAt: '2026-04-02T00:01:00.000Z',
      },
    },
  });
}

describe('AcquisitionPageComponent', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  async function renderPage(options?: {
    responses?: Partial<Record<AcquisitionLifecycleFilter, AcquisitionScenesResponse>>;
    runtimeHealth?: RuntimeHealthResponse;
    setupStatus?: SetupStatusResponse;
    queryParams?: Record<string, string>;
  }) {
    const allResponse =
      options?.responses?.ANY ??
      buildResponse([
        buildItem({
          id: 'scene-failed',
          title: 'Failed Scene',
          status: { state: 'FAILED' },
          errorMessage: 'The download is stalled with no connections',
          whisparrViewUrl: 'http://whisparr.local/movie/failed',
        }),
        buildItem({
          id: 'scene-downloading',
          title: 'Downloading Scene',
          status: { state: 'DOWNLOADING' },
          queueStatus: 'downloading',
          queueState: null,
          errorMessage: null,
          whisparrViewUrl: 'http://whisparr.local/movie/downloading',
        }),
        buildItem({
          id: 'scene-requested',
          title: 'Requested Scene',
          status: { state: 'REQUESTED' },
          queueStatus: 'queued',
          queueState: null,
          errorMessage: null,
          whisparrViewUrl: 'http://whisparr.local/movie/requested',
        }),
      ]);
    const responses: Record<AcquisitionLifecycleFilter, AcquisitionScenesResponse> = {
      ANY: allResponse,
      FAILED:
        options?.responses?.FAILED ??
        buildResponse(allResponse.items.filter((item) => item.status.state === 'FAILED')),
      DOWNLOADING:
        options?.responses?.DOWNLOADING ??
        buildResponse(allResponse.items.filter((item) => item.status.state === 'DOWNLOADING')),
      IMPORT_PENDING:
        options?.responses?.IMPORT_PENDING ??
        buildResponse(allResponse.items.filter((item) => item.status.state === 'IMPORT_PENDING')),
      REQUESTED:
        options?.responses?.REQUESTED ??
        buildResponse(allResponse.items.filter((item) => item.status.state === 'REQUESTED')),
    };

    const acquisitionService = {
      getScenesFeed: vi.fn((page: number, perPage: number, lifecycle = 'ANY') =>
        of(responses[lifecycle as AcquisitionLifecycleFilter] ?? responses.ANY),
      ),
      bulk: vi.fn(() => of({ action: 'search', done: 2, failed: [] })),
    };
    const organizerService = {
      checkWaiting: vi.fn(() =>
        of({
          checked: 2,
          fixed: 1,
          left: [
            {
              stashId: 'scene-waiting',
              title: 'Waiting Scene',
              path: '/data/a/a.mp4',
              linkedTo: 'other-scene',
              reason: 'Stash links this file to a different StashDB scene.',
            },
          ],
        }),
      ),
      markSameScene: vi.fn(() => of({ checked: 1, fixed: 1, left: [] })),
    };
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    const timelineApi = {
      scenes: vi.fn((ids: string[]) =>
        of(
          ids.map((id): SceneTimeline => ({
            stashId: id,
            route: 'whisparr',
            now: id === 'scene-failed' ? 'Download failed' : 'Searching for a release',
            unknown: [],
            checkedAt: '2026-10-21T12:00:00.000Z',
            steps: [
              {
                step: 'downloading',
                label: 'Downloading',
                at: null,
                status: id === 'scene-failed' ? 'failed' : 'current',
                detail: null,
                progress: null,
                action: null,
              },
            ],
          })),
        ),
      ),
      scene: vi.fn((id: string) =>
        of({
          stashId: id,
          route: 'whisparr',
          now: 'Download failed',
          unknown: [],
          checkedAt: '2026-10-21T12:00:00.000Z',
          steps: [
            {
              step: 'downloading',
              label: 'Downloading',
              at: null,
              status: 'failed',
              detail: 'Whisparr says: Unpacking failed',
              progress: null,
              action: { kind: 'pick-release', label: 'Pick another release' },
            },
          ],
        } satisfies SceneTimeline),
      ),
    };
    const runtimeHealthState = signal(options?.runtimeHealth ?? HEALTHY_RUNTIME_HEALTH);
    const runtimeHealthService = {
      ensureStarted: vi.fn(),
      requestRefresh: vi.fn(),
      status: runtimeHealthState.asReadonly(),
    };
    const setupStatusStore = {
      status: signal(options?.setupStatus ?? buildSetupStatus()),
      sync: vi.fn(),
    };
    const activatedRoute = {
      queryParamMap: of(convertToParamMap(options?.queryParams ?? {})),
      snapshot: {
        queryParamMap: convertToParamMap(options?.queryParams ?? {}),
      },
    };

    await TestBed.configureTestingModule({
      imports: [AcquisitionPageComponent],
      providers: [
        provideRouter([]),
        { provide: AppNotificationsService, useValue: notifications },
        { provide: TimelineApiService, useValue: timelineApi },
        {
          provide: AcquisitionService,
          useValue: acquisitionService,
        },
        {
          provide: OrganizerApiService,
          useValue: organizerService,
        },
        {
          provide: RuntimeHealthService,
          useValue: runtimeHealthService,
        },
        {
          provide: SetupStatusStore,
          useValue: setupStatusStore,
        },
        {
          provide: ActivatedRoute,
          useValue: activatedRoute,
        },
      ],
    }).compileComponents();

    const router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const fixture = TestBed.createComponent(AcquisitionPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return {
      fixture,
      router,
      acquisitionService,
      organizerService,
      runtimeHealthService,
      setRuntimeHealth: (next: RuntimeHealthResponse) => runtimeHealthState.set(next),
      notifications,
      timelineApi,
    };
  }

  it('says where each card is now from one batched request, and opens the whole story on tap', async () => {
    const { fixture, timelineApi } = await renderPage();
    const root = fixture.nativeElement as HTMLElement;

    expect(timelineApi.scenes).toHaveBeenCalledTimes(1);
    expect(timelineApi.scenes).toHaveBeenCalledWith([
      'scene-failed',
      'scene-downloading',
      'scene-requested',
    ]);
    const line = root.querySelector<HTMLButtonElement>('[data-testid="where-now-scene-failed"]')!;
    expect(line.textContent).toContain('Where it is now');
    expect(line.textContent).toContain('Download failed');
    expect(line.getAttribute('data-tone')).toBe('failed');
    expect(root.querySelector('app-scene-timeline')).toBeNull();

    line.click();
    fixture.detectChanges();

    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(timelineApi.scene).toHaveBeenCalledWith('scene-failed');
    expect(root.querySelector('app-scene-timeline')?.textContent).toContain(
      'Whisparr says: Unpacking failed',
    );
  });

  it('still shows the cards when the timelines can’t be had', async () => {
    TestBed.overrideProvider(TimelineApiService, {
      useValue: { scenes: () => throwError(() => new Error('offline')), scene: vi.fn() },
    });
    const { fixture } = await renderPage();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelectorAll('.acquisition-card').length).toBe(3);
    expect(root.querySelector('.where-now')).toBeNull();
  });

  it('picks waiting scenes and searches again for all of them', async () => {
    const { fixture, acquisitionService, notifications } = await renderPage();
    const root = fixture.nativeElement as HTMLElement;
    const click = (label: string) => {
      Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim().startsWith(label))!
        .click();
      fixture.detectChanges();
    };

    click('Select');
    click('Select all');
    click('Search again');

    expect(acquisitionService.bulk).toHaveBeenCalledWith(
      'search',
      expect.arrayContaining([expect.any(String)]),
    );
    expect(notifications.success).toHaveBeenCalled();
    expect(root.querySelector('app-selection-bar')).toBeNull();
  });

  it('renders summary cards, prioritizes failed sections, and exposes scene plus Whisparr actions', async () => {
    const { fixture, acquisitionService, runtimeHealthService } = await renderPage();
    const text = fixture.nativeElement.textContent;
    const failedSummaryCard = fixture.nativeElement.querySelector(
      '[data-testid="summary-card-FAILED"]',
    ) as HTMLElement | null;
    const lifecycleHeadings = Array.from(
      fixture.nativeElement.querySelectorAll('.lifecycle-section h3') as NodeListOf<HTMLElement>,
    ).map((element) => element.textContent?.trim());

    expect(runtimeHealthService.ensureStarted).toHaveBeenCalledTimes(1);
    expect(acquisitionService.getScenesFeed).toHaveBeenCalledWith(1, 24, 'ANY', {
      q: '',
      sort: 'status',
    });
    expect(failedSummaryCard?.textContent).toContain('1');
    expect(lifecycleHeadings).toEqual(['Failed', 'Downloading', 'Requested']);
    expect(text).toContain('Whisparr reported: The download is stalled with no connections');
    expect(
      fixture.nativeElement.querySelector('a[href="http://whisparr.local/movie/failed"]')
        ?.textContent,
    ).toContain('View in Whisparr');
    expect(
      fixture.nativeElement.querySelector('.card-actions a[href*="/scene/scene-failed"]'),
    ).toBeTruthy();
  });

  it('says a download Whisparr can’t import has failed, not that the file is coming', async () => {
    const { fixture } = await renderPage({
      responses: {
        ANY: buildResponse([
          buildItem({
            id: 'scene-blocked',
            title: 'Blocked Scene',
            status: { state: 'FAILED' },
            queueStatus: 'completed',
            queueState: 'importBlocked',
            errorMessage: null,
          }),
        ]),
      },
    });
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Whisparr downloaded it but couldn’t import it.');
    expect(text).not.toContain('Whisparr marked this item as completed');
  });

  it('checks waiting scenes by itself and says on each card why it waits', async () => {
    const waiting = buildItem({
      id: 'scene-waiting',
      title: 'Waiting Scene',
      status: { state: 'IMPORT_PENDING' },
      queueStatus: null,
      queueState: null,
    });
    const { fixture, organizerService } = await renderPage({
      responses: { ANY: buildResponse([waiting]) },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Once, on its own: no button press, and no loop after the reload.
    expect(organizerService.checkWaiting).toHaveBeenCalledTimes(1);
    const panel = fixture.nativeElement.querySelector('[data-testid="waiting-check"]');
    expect(panel?.textContent).toContain('1 is no longer waiting');
    const card = fixture.nativeElement.querySelector('[data-state="IMPORT_PENDING"]');
    expect(card?.textContent).toContain('different StashDB scene');
    expect(card?.textContent).toContain('/data/a/a.mp4');

    (
      fixture.nativeElement.querySelector(
        '[data-testid="card-same-scene-scene-waiting"]',
      ) as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(organizerService.markSameScene).toHaveBeenCalledWith('scene-waiting');
    expect(fixture.nativeElement.textContent).toContain('Nothing is left waiting.');
  });

  it('reloads the feed when a summary card lifecycle focus is selected', async () => {
    const { fixture, acquisitionService } = await renderPage();
    const failedSummaryCard = fixture.nativeElement.querySelector(
      '[data-testid="summary-card-FAILED"]',
    ) as HTMLButtonElement | null;

    expect(failedSummaryCard).toBeTruthy();

    failedSummaryCard?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(acquisitionService.getScenesFeed).toHaveBeenLastCalledWith(1, 24, 'FAILED', {
      q: '',
      sort: 'status',
    });
    expect(fixture.nativeElement.textContent).toContain('Failed Scene');
    expect(fixture.nativeElement.textContent).not.toContain('Downloading Scene');
    expect(
      fixture.nativeElement.querySelector('[data-testid="lifecycle-section-FAILED"]'),
    ).toBeTruthy();
  });

  it('renders acquisition-specific degraded messaging and a strong empty state', async () => {
    const emptyResponse = buildResponse([]);
    const { fixture } = await renderPage({
      responses: {
        ANY: emptyResponse,
      },
      runtimeHealth: buildWhisparrDegradedRuntimeHealth(),
    });

    const degradedState = fixture.nativeElement.querySelector(
      '[data-testid="acquisition-degraded-state"]',
    ) as HTMLElement | null;
    const emptyState = fixture.nativeElement.querySelector(
      '[data-testid="acquisition-empty-state"]',
    ) as HTMLElement | null;

    expect(degradedState?.textContent).toContain('Whisparr needs attention');
    expect(degradedState?.textContent).toContain(
      'Queue state, failures, and request progression may be stale',
    );
    expect(degradedState?.querySelector('a[href*="/settings/integrations"]')).toBeTruthy();
    expect(emptyState?.textContent).toContain('No acquisition activity is indexed yet');
    expect(emptyState?.textContent).toContain('run Sync All');
    expect(emptyState?.textContent).toContain('Open Scenes');
    expect(emptyState?.textContent).toContain('Open Indexing');
    expect(emptyState?.textContent).toContain('Open Library');
  });

  it('shows the acquisition degraded alert when shared runtime health reports a new Whisparr outage', async () => {
    const { fixture, setRuntimeHealth } = await renderPage();

    expect(
      fixture.nativeElement.querySelector('[data-testid="acquisition-degraded-state"]'),
    ).toBeNull();

    setRuntimeHealth(buildWhisparrDegradedRuntimeHealth());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const degradedState = fixture.nativeElement.querySelector(
      '[data-testid="acquisition-degraded-state"]',
    ) as HTMLElement | null;

    expect(degradedState?.textContent).toContain('Whisparr needs attention');
    expect(degradedState?.textContent).toContain(
      'Queue state, failures, and request progression may be stale',
    );
  });

  it('clears the acquisition degraded alert when shared runtime health reports recovery', async () => {
    const { fixture, setRuntimeHealth } = await renderPage({
      runtimeHealth: buildWhisparrDegradedRuntimeHealth(),
    });

    expect(
      fixture.nativeElement.querySelector('[data-testid="acquisition-degraded-state"]'),
    ).toBeTruthy();

    setRuntimeHealth(buildRuntimeHealth());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[data-testid="acquisition-degraded-state"]'),
    ).toBeNull();
  });

  it('keeps setup degradation ahead of refreshed runtime outage messaging', async () => {
    const { fixture, setRuntimeHealth } = await renderPage({
      setupStatus: buildSetupStatus({
        setupComplete: false,
        required: {
          stash: true,
          catalog: true,
          whisparr: false,
        },
      }),
    });

    setRuntimeHealth(
      buildRuntimeHealth({
        degraded: true,
        services: {
          stash: {
            service: 'STASH',
            status: 'DEGRADED',
            degraded: true,
            consecutiveFailures: 2,
            lastHealthyAt: '2026-04-02T00:00:00.000Z',
            lastFailureAt: '2026-04-02T00:01:00.000Z',
            lastErrorMessage: 'Failed to reach Stash provider endpoint.',
            degradedAt: '2026-04-02T00:01:00.000Z',
          },
        },
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const degradedState = fixture.nativeElement.querySelector(
      '[data-testid="acquisition-degraded-state"]',
    ) as HTMLElement | null;

    expect(degradedState?.textContent).toContain('Repair Required');
    expect(degradedState?.textContent).toContain('Whisparr needs attention');
    expect(degradedState?.textContent).not.toContain('Stash import visibility is degraded');
  });

  it('renders a filter-specific empty state when a focused lifecycle has no items', async () => {
    const { fixture, acquisitionService } = await renderPage({
      responses: {
        ANY: buildResponse([
          buildItem({
            id: 'scene-downloading',
            title: 'Downloading Scene',
            status: { state: 'DOWNLOADING' },
            queueStatus: 'downloading',
            queueState: null,
            errorMessage: null,
            whisparrViewUrl: 'http://whisparr.local/movie/downloading',
          }),
        ]),
        FAILED: buildResponse([]),
      },
    });

    const failedSummaryCard = fixture.nativeElement.querySelector(
      '[data-testid="summary-card-FAILED"]',
    ) as HTMLButtonElement | null;

    failedSummaryCard?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(acquisitionService.getScenesFeed).toHaveBeenLastCalledWith(1, 24, 'FAILED', {
      q: '',
      sort: 'status',
    });
    expect(fixture.nativeElement.textContent).toContain('No failed scenes right now');
    expect(fixture.nativeElement.textContent).toContain('Show all tracked');
  });

  it('lists sections in the same order as the API and the Home rail', async () => {
    const { fixture } = await renderPage({
      responses: {
        ANY: buildResponse([
          buildItem({ id: 'f', title: 'F', status: { state: 'FAILED' } }),
          buildItem({ id: 'd', title: 'D', status: { state: 'DOWNLOADING' } }),
          buildItem({ id: 'i', title: 'I', status: { state: 'IMPORT_PENDING' } }),
          buildItem({ id: 'r', title: 'R', status: { state: 'REQUESTED' } }),
        ]),
      },
    });

    const headings = Array.from(
      fixture.nativeElement.querySelectorAll('.lifecycle-section h3') as NodeListOf<HTMLElement>,
    ).map((element) => element.textContent?.trim());
    expect(headings).toEqual(['Failed', 'Downloading', 'Awaiting Import', 'Requested']);
  });

  it('searches after a pause and keeps the search in the address', async () => {
    vi.useFakeTimers();
    try {
      const { fixture, router, acquisitionService } = await renderPage();
      const input = fixture.nativeElement.querySelector(
        '[data-testid="acquisition-search"]',
      ) as HTMLInputElement;

      input.value = 'blue';
      input.dispatchEvent(new Event('input'));
      input.value = 'blue studio';
      input.dispatchEvent(new Event('input'));
      expect(acquisitionService.getScenesFeed).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(300);
      fixture.detectChanges();

      expect(acquisitionService.getScenesFeed).toHaveBeenCalledTimes(2);
      expect(acquisitionService.getScenesFeed).toHaveBeenLastCalledWith(1, 24, 'ANY', {
        q: 'blue studio',
        sort: 'status',
      });
      expect(router.navigate).toHaveBeenLastCalledWith(
        [],
        expect.objectContaining({
          queryParams: { lifecycle: null, q: 'blue studio', sort: null },
          replaceUrl: true,
        }),
      );
      // The search box stays put while the list reloads.
      expect(fixture.nativeElement.querySelector('[data-testid="acquisition-search"]')).toBe(input);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a clear-search empty state when nothing matches', async () => {
    const { fixture, acquisitionService } = await renderPage({
      queryParams: { q: 'nothing' },
      responses: { ANY: buildResponse([]) },
    });

    expect(acquisitionService.getScenesFeed).toHaveBeenCalledWith(1, 24, 'ANY', {
      q: 'nothing',
      sort: 'status',
    });
    expect(
      (
        fixture.nativeElement.querySelector(
          '[data-testid="acquisition-search"]',
        ) as HTMLInputElement
      ).value,
    ).toBe('nothing');
    expect(fixture.nativeElement.textContent).toContain('Nothing matches “nothing”');

    const clear = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.includes('Clear search'));
    clear?.click();
    fixture.detectChanges();

    expect(acquisitionService.getScenesFeed).toHaveBeenLastCalledWith(1, 24, 'ANY', {
      q: '',
      sort: 'status',
    });
  });

  it('sorts by date as one list instead of grouping by stage', async () => {
    const { fixture, router, acquisitionService } = await renderPage();
    const select = fixture.nativeElement.querySelector(
      '[data-testid="acquisition-sort"]',
    ) as HTMLSelectElement;

    select.value = 'requested-desc';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(acquisitionService.getScenesFeed).toHaveBeenLastCalledWith(1, 24, 'ANY', {
      q: '',
      sort: 'requested-desc',
    });
    expect(router.navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({
        queryParams: { lifecycle: null, q: null, sort: 'requested-desc' },
      }),
    );
    const sections = fixture.nativeElement.querySelectorAll('.lifecycle-section');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.querySelector('h3')?.textContent).toContain('All tracked');
    expect(sections[0]?.textContent).toContain('Sorted by newest requested');
  });

  it('reads the sort from the address', async () => {
    const { fixture, acquisitionService } = await renderPage({
      queryParams: { sort: 'released-asc', lifecycle: 'FAILED' },
    });

    expect(acquisitionService.getScenesFeed).toHaveBeenCalledWith(1, 24, 'FAILED', {
      q: '',
      sort: 'released-asc',
    });
    expect(
      (fixture.nativeElement.querySelector('[data-testid="acquisition-sort"]') as HTMLSelectElement)
        .value,
    ).toBe('released-asc');
  });
});
