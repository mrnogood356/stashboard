import { HiddenContentService } from '../../core/api/hidden-content.service';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { DiscoverItem, StudioDetails } from '../../core/api/discover.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { StudioPageComponent } from './studio-page.component';

function buildStudio(overrides: Partial<StudioDetails> = {}): StudioDetails {
  return {
    id: 'studio-1',
    name: 'Studio One',
    aliases: [],
    deleted: false,
    isFavorite: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-03-01',
    imageUrl: 'http://cdn.local/studio.jpg',
    images: [],
    urls: [],
    parentStudio: null,
    childStudios: [],
    ...overrides,
  };
}

function buildScene(overrides: Partial<DiscoverItem> = {}): DiscoverItem {
  return {
    id: 'scene-1',
    title: 'Studio Scene',
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

describe('StudioPageComponent', () => {
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

  async function renderPage(scene: DiscoverItem = buildScene()) {
    const paramMap$ = new BehaviorSubject(convertToParamMap({ studioId: 'studio-1' }));
    const queryParamMap$ = new BehaviorSubject(convertToParamMap({}));
    const discoverService = {
      getStudioDetails: vi.fn().mockReturnValue(of(buildStudio())),
      getScenesFeed: vi.fn().mockReturnValue(
        of({
          total: 1,
          page: 1,
          perPage: 24,
          hasMore: false,
          hidden: 2,
          items: [scene],
        }),
      ),
      searchSceneTags: vi.fn().mockReturnValue(of([])),
    };

    await TestBed.configureTestingModule({
      imports: [StudioPageComponent],
      providers: [
        provideRouter([]),
        {
          provide: HiddenContentService,
          useValue: {
            ensureLoaded: vi.fn(),
            isHidden: vi.fn(() => false),
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

    const fixture = TestBed.createComponent(StudioPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return { fixture, discoverService };
  }

  it('renders studio scenes with the shared scene card and keeps request handling on the page', async () => {
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
      title: 'Studio Scene',
      imageUrl: 'http://cdn.local/scene.jpg',
    });
  });

  it('offers no Request button for a scene from a browse-only provider', async () => {
    const { fixture } = await renderPage(buildScene({ requestable: false }));

    expect(fixture.nativeElement.querySelectorAll('app-scene-card')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.request-cta')).toBeNull();
  });

  it('says how many scenes the hidden list left out, and shows them on request', async () => {
    const { fixture, discoverService } = await renderPage();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Hiding 2 scenes');
    expect(discoverService.getScenesFeed.mock.calls[0][10]).toBe(false);

    (root.querySelector('[data-testid="hidden-count"] button') as HTMLButtonElement).click();
    fixture.detectChanges();

    const lastCall = discoverService.getScenesFeed.mock.calls.at(-1)!;
    expect(lastCall[7]).toEqual(['studio-1']);
    expect(lastCall[10]).toBe(true);
  });
});
