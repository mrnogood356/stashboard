import { HiddenContentService } from '../../core/api/hidden-content.service';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Observable, Subject, of } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { DiscoverItem, PerformerDetails, SceneFacets } from '../../core/api/discover.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { PerformerPageComponent } from './performer-page.component';

function buildPerformer(overrides: Partial<PerformerDetails> = {}): PerformerDetails {
  return {
    id: 'performer-1',
    name: 'Performer One',
    disambiguation: null,
    aliases: [],
    gender: 'FEMALE',
    birthDate: null,
    deathDate: null,
    age: 28,
    ethnicity: null,
    country: 'US',
    eyeColor: null,
    hairColor: null,
    height: null,
    cupSize: null,
    bandSize: null,
    waistSize: null,
    hipSize: null,
    breastType: null,
    careerStartYear: null,
    careerEndYear: null,
    deleted: false,
    mergedIds: [],
    mergedIntoId: null,
    isFavorite: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-03-01',
    imageUrl: 'http://cdn.local/performer.jpg',
    images: [],
    ...overrides,
  };
}

function buildScene(overrides: Partial<DiscoverItem> = {}): DiscoverItem {
  return {
    id: 'scene-1',
    title: 'Performer Scene',
    description: 'Scene description',
    imageUrl: 'http://cdn.local/scene.jpg',
    cardImageUrl: 'http://cdn.local/scene-card.jpg',
    studioId: 'studio-1',
    studio: 'Studio One',
    studioImageUrl: 'http://cdn.local/studio.jpg',
    releaseDate: '2026-03-20',
    duration: 1800,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    requestable: true,
    ...overrides,
  };
}

describe('PerformerPageComponent', () => {
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

  async function renderPage(
    scene: DiscoverItem = buildScene(),
    performer: PerformerDetails = buildPerformer(),
    details?: (id: string) => Observable<PerformerDetails>,
  ) {
    const paramMap$ = new BehaviorSubject(convertToParamMap({ performerId: 'performer-1' }));
    const queryParamMap$ = new BehaviorSubject(convertToParamMap({}));
    const discoverService = {
      getPerformerFacets: vi.fn(() =>
        of<SceneFacets>({ total: 0, scanned: 0, tags: [], studios: [] }),
      ),
      getPerformerDetails: details ? vi.fn(details) : vi.fn().mockReturnValue(of(performer)),
      getPerformerScenesFeed: vi.fn().mockReturnValue(
        of({
          total: 1,
          page: 1,
          perPage: 24,
          hasMore: false,
          hidden: 2,
          items: [scene],
        }),
      ),
      searchPerformerStudios: vi.fn().mockReturnValue(of([])),
      searchSceneTags: vi.fn().mockReturnValue(of([])),
    };

    await TestBed.configureTestingModule({
      imports: [PerformerPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: HiddenContentService,
          useValue: {
            ensureLoaded: vi.fn(),
            isHidden: vi.fn(() => false),
            settings: () => null,
            hide: vi.fn(),
            unhide: vi.fn(),
          },
        },
        {
          provide: DiscoverService,
          useValue: discoverService,
        },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: paramMap$.asObservable(),
            queryParamMap: queryParamMap$.asObservable(),
            snapshot: { queryParamMap: convertToParamMap({}) },
          },
        },
        {
          provide: AppNotificationsService,
          useValue: {
            success: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
          },
        },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(PerformerPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return { fixture, discoverService, paramMap$ };
  }

  it('shows one photo at a time, with arrows and a swipe to the others', async () => {
    const images = ['a', 'b', 'c'].map((id) => ({ id, url: `http://cdn.local/${id}.jpg` }));
    const { fixture } = await renderPage(buildScene(), buildPerformer({ images } as never));
    const root = fixture.nativeElement as HTMLElement;
    const photo = () =>
      root.querySelector<HTMLImageElement>('[data-testid="performer-photo"] img')!.src;
    const count = () => root.querySelector('[data-testid="photo-count"]')!.textContent?.trim();

    expect(root.querySelectorAll('[data-testid="performer-photo"] img')).toHaveLength(1);
    expect(photo()).toContain('/a.jpg');
    expect(count()).toBe('1 / 3');

    (root.querySelector('[data-testid="photo-next"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(photo()).toContain('/b.jpg');
    (root.querySelector('[data-testid="photo-prev"]') as HTMLButtonElement).click();
    (root.querySelector('[data-testid="photo-prev"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    // Back from the first wraps round to the last.
    expect(photo()).toContain('/c.jpg');
    expect(count()).toBe('3 / 3');

    const swipe = (fromX: number, toX: number) => {
      const target = root.querySelector('[data-testid="performer-photo"]')!;
      for (const [type, x] of [
        ['pointerdown', fromX],
        ['pointerup', toX],
      ] as const) {
        const event = new Event(type) as PointerEvent;
        Object.defineProperties(event, {
          pointerType: { value: 'touch' },
          clientX: { value: x },
          clientY: { value: 100 },
        });
        target.dispatchEvent(event);
      }
      fixture.detectChanges();
    };
    swipe(200, 100);
    expect(photo()).toContain('/a.jpg');
    // A small move is a tap, not a swipe.
    swipe(200, 190);
    expect(photo()).toContain('/a.jpg');
  });

  it('carries on in the catalog the performer is in, when the link didn’t say', async () => {
    const navigate = vi.spyOn(Router.prototype, 'navigate').mockResolvedValue(true);
    const { fixture, discoverService } = await renderPage(buildScene(), {
      ...buildPerformer(),
      provider: 'FANSDB',
      fromOtherCatalog: true,
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { provider: 'FANSDB' },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      }),
    );
    // The scenes and their filters are asked again, now of FansDB.
    expect(discoverService.getPerformerScenesFeed).toHaveBeenCalledTimes(2);
    expect(discoverService.getPerformerFacets).toHaveBeenCalledTimes(2);
    expect(fixture.nativeElement.textContent).toContain(buildPerformer().name);
    navigate.mockRestore();
  });

  it('ignores a late answer for the performer it has moved on from', async () => {
    const navigate = vi.spyOn(Router.prototype, 'navigate').mockResolvedValue(true);
    const answers = new Map<string, Subject<PerformerDetails>>();
    const { fixture, paramMap$ } = await renderPage(buildScene(), buildPerformer(), (id) => {
      const answer = new Subject<PerformerDetails>();
      answers.set(id, answer);
      return answer;
    });
    // On to performer 2 before performer 1's details arrive.
    paramMap$.next(convertToParamMap({ performerId: 'performer-2' }));
    fixture.detectChanges();
    answers.get('performer-1')?.next({
      ...buildPerformer(),
      name: 'Old Performer',
      provider: 'FANSDB',
      fromOtherCatalog: true,
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain('Old Performer');
    navigate.mockRestore();
  });

  it('does nothing more once closed while the catalog switch finishes', async () => {
    let finishSwitch: (done: boolean) => void = () => {};
    const navigate = vi
      .spyOn(Router.prototype, 'navigate')
      .mockReturnValue(new Promise<boolean>((resolve) => (finishSwitch = resolve)));
    const { fixture, discoverService } = await renderPage(buildScene(), {
      ...buildPerformer(),
      provider: 'FANSDB',
      fromOtherCatalog: true,
    });
    expect(navigate).toHaveBeenCalled();
    const scenesAsked = discoverService.getPerformerScenesFeed.mock.calls.length;
    const facetsAsked = discoverService.getPerformerFacets.mock.calls.length;

    fixture.destroy();
    finishSwitch(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(discoverService.getPerformerScenesFeed).toHaveBeenCalledTimes(scenesAsked);
    expect(discoverService.getPerformerFacets).toHaveBeenCalledTimes(facetsAsked);
    navigate.mockRestore();
  });

  it('stays in the catalog it asked when the performer is there', async () => {
    const navigate = vi.spyOn(Router.prototype, 'navigate');
    const { discoverService } = await renderPage();

    expect(navigate).not.toHaveBeenCalled();
    expect(discoverService.getPerformerScenesFeed).toHaveBeenCalledTimes(1);
    navigate.mockRestore();
  });

  it('shows no arrows for a performer with a single photo', async () => {
    const { fixture } = await renderPage(
      buildScene(),
      buildPerformer({ images: [{ id: 'a', url: 'http://cdn.local/a.jpg' }] } as never),
    );
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="photo-next"]')).toBeNull();
    expect(root.querySelector('[data-testid="photo-count"]')).toBeNull();
  });

  it('renders performer scenes with the shared scene card and keeps request handling on the page', async () => {
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
      title: 'Performer Scene',
      imageUrl: 'http://cdn.local/scene.jpg',
    });
  });

  it('offers no Request button for a scene from a browse-only provider', async () => {
    const { fixture } = await renderPage(buildScene({ requestable: false }));

    expect(fixture.nativeElement.querySelectorAll('app-scene-card')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.request-cta')).toBeNull();
  });

  it("lists the performer's own categories with counts, ready to pick", async () => {
    const { fixture, discoverService } = await renderPage();
    discoverService.getPerformerFacets.mockReturnValue(
      of({
        total: 40,
        scanned: 40,
        tags: [
          { id: 't1', name: 'Outdoor', count: 30 },
          { id: 't2', name: 'POV', count: 12 },
        ],
        studios: [],
      }),
    );
    // Facets load with the performer: load it again with the counted ones.
    (fixture.componentInstance as any).loadFacets('performer-1');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('[data-testid="performer-category"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(
      Array.from(root.querySelectorAll('.filter-option')).map((row) =>
        row.textContent?.replace(/\s+/g, ''),
      ),
    ).toEqual(['Outdoor30', 'POV12']);

    (
      root.querySelector('[data-testid="performer-category-option-t2"]') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    expect(discoverService.getPerformerScenesFeed).toHaveBeenLastCalledWith(
      'performer-1',
      1,
      24,
      expect.objectContaining({ tagIds: ['t2'] }),
    );
    expect(root.querySelector('[data-testid="performer-category"]')?.textContent).toContain('POV');
  });

  it('says how many scenes the hidden list left out, and shows them on request', async () => {
    const { fixture, discoverService } = await renderPage();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Hiding 2 scenes');
    expect(discoverService.getPerformerScenesFeed.mock.calls[0][3]).toEqual(
      expect.objectContaining({ showHidden: false }),
    );

    (root.querySelector('[data-testid="hidden-count"] button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(discoverService.getPerformerScenesFeed).toHaveBeenLastCalledWith(
      'performer-1',
      1,
      24,
      expect.objectContaining({ showHidden: true }),
    );
  });
});
