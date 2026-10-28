import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  Event as RouterEvent,
  NavigationEnd,
  Router,
  Scroll,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { SceneExplorerItem, ScenesFeedResponse } from '../../core/api/discover.types';
import { RuntimeHealthService } from '../../core/api/runtime-health.service';
import { RuntimeHealthResponse } from '../../core/api/runtime-health.types';
import { SetupStatusStore } from '../../core/api/setup-status.store';
import { SetupStatusResponse } from '../../core/api/setup.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { ScenesPageComponent } from './scenes-page.component';
import { ScenesSearchCacheService } from './scenes-search-cache.service';

function buildScene(overrides: Partial<SceneExplorerItem> = {}): SceneExplorerItem {
  return {
    id: 'scene-1',
    title: 'Scene Title',
    description: 'Scene description',
    imageUrl: 'http://cdn.local/image.jpg',
    cardImageUrl: 'http://cdn.local/card.jpg',
    studioId: 'studio-1',
    studio: 'Studio Name',
    studioImageUrl: 'http://cdn.local/studio.jpg',
    releaseDate: '2026-03-01',
    duration: 640,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    requestable: true,
    ...overrides,
  };
}

function buildFeedResponse(
  items: SceneExplorerItem[] = [buildScene()],
  overrides: Partial<ScenesFeedResponse> = {},
): ScenesFeedResponse {
  return {
    total: items.length,
    page: 1,
    perPage: 24,
    hasMore: false,
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

describe('ScenesPageComponent', () => {
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
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function renderPage(
    initialQueryParams: Record<string, string> = {},
    options?: {
      feedResponse?: ScenesFeedResponse;
      runtimeHealth?: RuntimeHealthResponse;
      setupStatus?: SetupStatusResponse;
      searchCache?: ScenesSearchCacheService;
      feedResponseForPage?: (page: number) => ScenesFeedResponse;
    },
  ) {
    const queryParamMap = convertToParamMap(initialQueryParams);
    const queryParamMap$ = new BehaviorSubject(queryParamMap);
    const discoverService = {
      getScenesFeed: vi.fn((page: number) =>
        of(options?.feedResponseForPage?.(page) ?? options?.feedResponse ?? buildFeedResponse()),
      ),
      searchSceneTags: vi.fn().mockReturnValue(of([])),
      searchPerformerStudios: vi.fn().mockReturnValue(of([])),
    };
    const runtimeHealthService = {
      ensureStarted: vi.fn(),
      status: signal(options?.runtimeHealth ?? HEALTHY_RUNTIME_HEALTH).asReadonly(),
    };
    const setupStatusStore = {
      status: signal(options?.setupStatus ?? buildSetupStatus()),
      sync: vi.fn(),
    };
    const activatedRoute = {
      queryParamMap: queryParamMap$.asObservable(),
      snapshot: {
        queryParamMap,
      },
    };

    await TestBed.configureTestingModule({
      imports: [ScenesPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: DiscoverService,
          useValue: discoverService,
        },
        {
          provide: AppNotificationsService,
          useValue: {
            success: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: activatedRoute,
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
          provide: ScenesSearchCacheService,
          useValue: options?.searchCache ?? new ScenesSearchCacheService(),
        },
      ],
    }).compileComponents();

    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    const fixture = TestBed.createComponent(ScenesPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return { fixture, discoverService, navigateSpy, runtimeHealthService, router };
  }

  it('initializes the canonical scenes discovery view with TRENDING sort', async () => {
    const { fixture, discoverService, navigateSpy, runtimeHealthService } = await renderPage();
    const resetButton = fixture.nativeElement.querySelector(
      '.reset-filters-button',
    ) as HTMLButtonElement | null;
    const pageText = fixture.nativeElement.textContent ?? '';

    expect(discoverService.getScenesFeed).toHaveBeenCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      expect.any(Array),
      false,
      '',
    );
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(resetButton?.disabled).toBe(true);
    expect(pageText).not.toContain('Already In library');
    expect(pageText).not.toContain('Missing From Library');
    expect(pageText).not.toContain('Favorite Tags');
    expect(runtimeHealthService.ensureStarted).toHaveBeenCalledTimes(1);
  });

  it('renders discovery results through the shared scene card and forwards request actions', async () => {
    const { fixture } = await renderPage();
    const component = fixture.componentInstance as any;
    const cards = fixture.nativeElement.querySelectorAll('app-scene-card');
    const requestButton = fixture.nativeElement.querySelector(
      '.request-cta',
    ) as HTMLButtonElement | null;

    expect(cards).toHaveLength(1);
    expect(component.requestModalOpen()).toBe(false);

    requestButton?.click();

    expect(component.requestModalOpen()).toBe(true);
    expect(component.requestContext()).toEqual({
      id: 'scene-1',
      title: 'Scene Title',
      imageUrl: 'http://cdn.local/image.jpg',
    });
  });

  it('clears active filters back to the default trending discovery state', async () => {
    const { fixture, discoverService, navigateSpy } = await renderPage({
      sort: 'DATE',
      dir: 'ASC',
      fav: 'ALL',
      mode: 'AND',
      tags: 'tag-1,tag-2',
      tagNames: 'Tag One,Tag Two',
      studios: 'studio-1,studio-2',
      studioNames: 'Studio One,Studio Two',
    });
    const resetButton = fixture.nativeElement.querySelector(
      '.reset-filters-button',
    ) as HTMLButtonElement | null;

    expect(resetButton).toBeTruthy();
    expect(resetButton?.disabled).toBe(false);

    resetButton?.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(discoverService.getScenesFeed).toHaveBeenLastCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      expect.any(Array),
      false,
      '',
    );
    expect(navigateSpy).toHaveBeenCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: {
        sort: null,
        dir: null,
        fav: null,
        availability: null,
        lifecycle: null,
        stashFavPerformers: null,
        stashFavStudios: null,
        stashFavTags: null,
        mode: null,
        tags: null,
        tagNames: null,
        studios: null,
        studioNames: null,
        exclude: null,
        showHidden: null,
        q: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: false,
    });
  });

  it('strips legacy library overlay params from the discovery route', async () => {
    const { discoverService, navigateSpy } = await renderPage({
      availability: 'IN_LIBRARY',
      stashFavPerformers: '1',
      stashFavStudios: '1',
      stashFavTags: '1',
    });

    expect(discoverService.getScenesFeed).toHaveBeenCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      expect.any(Array),
      false,
      '',
    );
    expect(navigateSpy).toHaveBeenCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: {
        sort: null,
        dir: null,
        fav: null,
        availability: null,
        lifecycle: null,
        stashFavPerformers: null,
        stashFavStudios: null,
        stashFavTags: null,
        mode: null,
        tags: null,
        tagNames: null,
        studios: null,
        studioNames: null,
        exclude: null,
        showHidden: null,
        q: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  });

  it('sends excluded words from the URL and counts them as an active filter', async () => {
    const { fixture, discoverService } = await renderPage({ exclude: 'trans,transgender' });
    const input = fixture.nativeElement.querySelector('#scenes-exclude') as HTMLInputElement;
    const resetButton = fixture.nativeElement.querySelector(
      '.reset-filters-button',
    ) as HTMLButtonElement | null;

    expect(discoverService.getScenesFeed).toHaveBeenCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      ['trans', 'transgender'],
      expect.any(Array),
      false,
      '',
    );
    expect(input.value).toBe('trans, transgender');
    expect(resetButton?.disabled).toBe(false);
  });

  it('sends tag names with the tags and says which ones this catalog lacks', async () => {
    const { fixture, discoverService } = await renderPage(
      { tags: 'stashdb-anal,stashdb-pov', tagNames: 'Anal,POV' },
      { feedResponse: { ...buildFeedResponse(), unknownTags: ['POV'] } },
    );

    expect(discoverService.getScenesFeed).toHaveBeenCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      ['stashdb-anal', 'stashdb-pov'],
      'OR',
      undefined,
      [],
      [],
      ['Anal', 'POV'],
      false,
      '',
    );
    expect(
      fixture.nativeElement.querySelector('[data-testid="unknown-tags"]')?.textContent,
    ).toContain('no tag named POV');
  });

  it('applies typed exclude words on Enter and keeps them in the URL', async () => {
    const { fixture, discoverService, navigateSpy } = await renderPage();
    const input = fixture.nativeElement.querySelector('#scenes-exclude') as HTMLInputElement;

    input.value = 'Trans, -transgender  trans';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(discoverService.getScenesFeed).toHaveBeenLastCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      ['trans', 'transgender'],
      expect.any(Array),
      false,
      '',
    );
    expect(navigateSpy).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: expect.objectContaining({ exclude: 'trans,transgender' }),
      }),
    );
  });

  it('says how many scenes the hidden list left out, and shows them on request', async () => {
    const { fixture, discoverService, navigateSpy } = await renderPage(
      {},
      { feedResponse: buildFeedResponse([buildScene()], { hidden: 4 }) },
    );
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="hidden-count"]')?.textContent).toContain(
      'Hiding 4 scenes',
    );
    (root.querySelector('[data-testid="hidden-count"] button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(discoverService.getScenesFeed).toHaveBeenLastCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      [],
      true,
      '',
    );
    expect(navigateSpy).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: expect.objectContaining({ showHidden: '1' }),
      }),
    );
  });

  it('reads showHidden=1 from the URL', async () => {
    const { fixture, discoverService } = await renderPage(
      { showHidden: '1' },
      { feedResponse: buildFeedResponse([buildScene()], { hidden: 0 }) },
    );

    expect(discoverService.getScenesFeed).toHaveBeenCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      [],
      true,
      '',
    );
    expect(fixture.nativeElement.textContent).toContain('Showing hidden scenes');
  });

  it('searches the text from q=… (Search’s "See all") and can drop it', async () => {
    const { fixture, discoverService, navigateSpy } = await renderPage({ q: 'blue studio' });

    expect(discoverService.getScenesFeed).toHaveBeenLastCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      [],
      false,
      'blue studio',
    );
    const chip = fixture.nativeElement.querySelector(
      '[data-testid="scenes-text-query"]',
    ) as HTMLElement;
    expect(chip.textContent).toContain('Matching “blue studio”');
    expect(
      (fixture.nativeElement.querySelector('.reset-filters-button') as HTMLButtonElement).disabled,
    ).toBe(false);

    (chip.querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(discoverService.getScenesFeed).toHaveBeenLastCalledWith(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      [],
      [],
      false,
      '',
    );
    expect(navigateSpy).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({ queryParams: expect.objectContaining({ q: null }) }),
    );
    expect(fixture.nativeElement.querySelector('[data-testid="scenes-text-query"]')).toBeNull();
  });

  it('adds up hidden scenes across the pages it loads', async () => {
    const { fixture } = await renderPage(
      { exclude: 'trans' },
      {
        feedResponseForPage: (page) =>
          buildFeedResponse([], { total: 500, page, hasMore: true, hidden: 2 }),
      },
    );

    // Five empty pages load before it pauses.
    expect(fixture.nativeElement.textContent).toContain('Hiding 10 scenes');
  });

  it('keeps fetching past pages emptied by excluded words, then pauses', async () => {
    const { fixture, discoverService } = await renderPage(
      { exclude: 'trans' },
      {
        feedResponseForPage: (page) => buildFeedResponse([], { total: 500, page, hasMore: true }),
      },
    );
    const component = fixture.componentInstance as any;
    component.loadMoreAfterPause();
    fixture.detectChanges();

    // First visit pauses after 5 empty pages; "Keep looking" fetches 5 more.
    expect(discoverService.getScenesFeed).toHaveBeenCalledTimes(10);
    expect(discoverService.getScenesFeed).toHaveBeenLastCalledWith(
      10,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      ['trans'],
      expect.any(Array),
      false,
      '',
    );
    expect(fixture.nativeElement.textContent).toContain('Keep looking');
  });

  it('links each studio name to its studio page, coming back to this search', async () => {
    const { fixture } = await renderPage({ sort: 'DATE' });
    const studioLink = fixture.nativeElement.querySelector(
      '.studio-badge-link',
    ) as HTMLAnchorElement | null;

    expect(studioLink?.textContent?.trim()).toBe('Studio Name');
    expect(studioLink?.getAttribute('href')).toContain('/studio/studio-1?returnTo=');
  });

  it.each([
    ['a filtered search', { sort: 'DATE' }],
    ['the unfiltered list', {}],
  ])(
    'restores loaded results and scroll position when coming back to %s',
    async (_label, params) => {
      const searchCache = new ScenesSearchCacheService();
      const first = await renderPage(params, {
        searchCache,
        feedResponse: buildFeedResponse(
          [buildScene({ id: 'scene-1' }), buildScene({ id: 'scene-2' })],
          { total: 100, page: 2, hasMore: true },
        ),
      });
      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(1800);
      window.dispatchEvent(new Event('scroll'));
      first.fixture.destroy();
      TestBed.resetTestingModule();

      const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
      const { fixture, discoverService, router } = await renderPage(params, { searchCache });
      const component = fixture.componentInstance as any;

      expect(discoverService.getScenesFeed).not.toHaveBeenCalled();
      expect(fixture.nativeElement.querySelectorAll('app-scene-card')).toHaveLength(2);
      expect(component.page()).toBe(2);
      expect(component.hasMore()).toBe(true);
      expect(scrollTo).not.toHaveBeenCalled();

      // The router's own scroll-to-top comes first; ours follows a frame later.
      (router.events as Subject<RouterEvent>).next(
        new Scroll(new NavigationEnd(1, '/scenes?sort=DATE', '/scenes?sort=DATE'), null, null),
      );
      expect(scrollTo).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(scrollTo).toHaveBeenCalledWith({ top: 1800, behavior: 'instant' });
    },
  );

  it('loads fresh results for a search it has not seen', async () => {
    const searchCache = new ScenesSearchCacheService();
    searchCache.save('sort=TITLE', {
      items: [buildScene({ id: 'cached' })],
      total: 1,
      page: 1,
      hasMore: false,
      scrollY: 0,
    });

    const { discoverService } = await renderPage({ sort: 'DATE' }, { searchCache });

    expect(discoverService.getScenesFeed).toHaveBeenCalledTimes(1);
  });

  it('renders first-use guidance when the catalog feed is empty', async () => {
    const { fixture } = await renderPage(
      {},
      {
        feedResponse: buildFeedResponse([], { total: 0 }),
      },
    );

    const emptyState = fixture.nativeElement.querySelector(
      '[data-testid="scenes-empty-state"]',
    ) as HTMLElement | null;

    expect(emptyState?.textContent).toContain('No catalog scenes are available yet');
    expect(emptyState?.textContent).toContain('Catalog browsing does not depend on local indexing');
    expect(emptyState?.textContent).toContain('Open indexing');
  });

  it('points users to integration repair when catalog discovery is degraded', async () => {
    const { fixture } = await renderPage(
      {},
      {
        feedResponse: buildFeedResponse([], { total: 0 }),
        setupStatus: buildSetupStatus({
          setupComplete: false,
          required: {
            catalog: false,
          },
        }),
      },
    );

    const alert = fixture.nativeElement.querySelector(
      '[data-testid="scenes-readiness-alert"]',
    ) as HTMLElement | null;
    const repairLink = alert?.querySelector('a[href*="/settings/integrations"]');

    expect(alert?.textContent).toContain('Catalog discovery needs attention');
    expect(fixture.nativeElement.textContent).toContain('Repair integrations');
    expect(repairLink).toBeTruthy();
  });
});
