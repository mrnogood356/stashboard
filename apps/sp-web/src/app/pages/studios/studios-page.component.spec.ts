import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { LibraryService } from '../../core/api/library.service';
import { DiscoverService } from '../../core/api/discover.service';
import { StudioFeedItem } from '../../core/api/discover.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { StudiosPageComponent } from './studios-page.component';

function studio(overrides: Partial<StudioFeedItem> = {}): StudioFeedItem {
  return {
    id: 'studio-1',
    name: 'Studio One',
    isFavorite: false,
    imageUrl: null,
    cardImageUrl: null,
    parentStudio: null,
    childStudios: [],
    ...overrides,
  };
}

describe('StudiosPageComponent', () => {
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

  async function render(
    options: {
      query?: Record<string, string>;
      feed?: ReturnType<typeof vi.fn>;
      favorite?: ReturnType<typeof vi.fn>;
      listStudios?: ReturnType<typeof vi.fn>;
      queryParamMap?: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    } = {},
  ) {
    const library = {
      listStudios:
        options.listStudios ??
        vi.fn().mockReturnValue(
          of({
            total: 1,
            page: 1,
            perPage: 48,
            hasMore: false,
            items: [{ id: '9', name: 'My Studio', count: 4, imageUrl: '/logo' }],
          }),
        ),
    };
    const discover = {
      getStudiosFeed:
        options.feed ??
        vi.fn().mockReturnValue(
          of({
            total: 2,
            page: 1,
            perPage: 24,
            hasMore: false,
            items: [
              studio(),
              studio({
                id: 'studio-2',
                name: 'Network',
                childStudios: ['A', 'B', 'C', 'D', 'E'].map((name) => ({
                  id: name,
                  name: `Child ${name}`,
                })) as StudioFeedItem['childStudios'],
              }),
            ],
          }),
        ),
      favoriteStudio: options.favorite ?? vi.fn().mockReturnValue(of({ alreadyFavorited: false })),
    };
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [StudiosPageComponent],
      providers: [
        provideRouter([]),
        { provide: DiscoverService, useValue: discover },
        { provide: LibraryService, useValue: library },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap:
              options.queryParamMap ?? new BehaviorSubject(convertToParamMap(options.query ?? {})),
          },
        },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(StudiosPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      discover,
      notifications,
      library,
    };
  }

  it('lists studios with a preview of their child studios', async () => {
    const { root, discover } = await render();

    expect(discover.getStudiosFeed).toHaveBeenCalledWith(1, expect.any(Number), {
      name: undefined,
      sort: expect.any(String),
      direction: expect.any(String),
      favoritesOnly: false,
    });
    expect(root.textContent).toContain('Studio One');
    expect(root.textContent).toContain('Child A');
    expect(root.textContent).not.toContain('Child D');
  });

  it('shows only studios with scenes of yours under In my library, searched by name', async () => {
    const { root, library, discover } = await render({ query: { lib: '1', q: 'my' } });

    expect(library.listStudios).toHaveBeenCalledWith('my', 1);
    const list = root.querySelector('[data-testid="library-studios"]');
    expect(list?.textContent).toContain('My Studio');
    expect(list?.textContent).toContain('4 scenes of yours');
    expect(list?.querySelector('a')?.getAttribute('href')).toContain('/library/studio/9/all');
    expect(root.textContent).toContain('1 in your library');
    expect(
      root.querySelector('[data-testid="studios-in-library"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    // The catalog's own filters are put away meanwhile, and its list isn't asked for.
    expect(root.querySelector('[data-testid="studios-favorites"]')).toBeNull();
    expect(discover.getStudiosFeed).not.toHaveBeenCalled();
  });

  it('loads the catalog on the way back from In my library, and shows a logo that fails as its initial', async () => {
    const queryParamMap = new BehaviorSubject(convertToParamMap({ lib: '1' }));
    const { fixture, root, discover } = await render({ queryParamMap });
    const logo = root.querySelector<HTMLImageElement>('[data-testid="library-studios"] img')!;
    logo.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(
      root.querySelector('[data-testid="library-studios"] .placeholder')?.textContent,
    ).toContain('M');

    queryParamMap.next(convertToParamMap({}));
    fixture.detectChanges();
    expect(discover.getStudiosFeed).toHaveBeenCalledTimes(1);
  });

  it('says nothing about the count until the first library page comes back', async () => {
    const { root } = await render({
      query: { lib: '1' },
      listStudios: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    expect(root.textContent).not.toMatch(/\d in your library/);
    expect(root.querySelector('[data-testid="library-studios-retry"]')).not.toBeNull();
  });

  it('reads search, sort and favorites from the address bar', async () => {
    const { discover } = await render({ query: { q: ' net ', fav: 'true' } });

    expect(discover.getStudiosFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ name: 'net', favoritesOnly: true }),
    );
  });

  it('favorites a studio in place', async () => {
    const { fixture, root, discover, notifications } = await render();
    const toggle = root.querySelector<HTMLButtonElement>('[aria-label="Favorite studio"]')!;
    toggle.click();
    fixture.detectChanges();

    expect(discover.favoriteStudio).toHaveBeenCalledWith('studio-1', true);
    expect(notifications.success).toHaveBeenCalledWith('Studio favorited');
    expect(root.querySelector('[aria-label="Unfavorite studio"]')).not.toBeNull();
  });

  it('says so when favoriting fails, and leaves the studio as it was', async () => {
    const { fixture, root, notifications } = await render({
      favorite: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    root.querySelector<HTMLButtonElement>('[aria-label="Favorite studio"]')!.click();
    fixture.detectChanges();

    expect(notifications.error).toHaveBeenCalledWith('Failed to favorite studio');
    expect(root.querySelectorAll('[aria-label="Unfavorite studio"]')).toHaveLength(0);
  });

  it('offers a retry when the feed fails to load', async () => {
    const feed = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValue(of({ total: 1, page: 1, perPage: 24, hasMore: false, items: [studio()] }));
    const { fixture, root } = await render({ feed });
    const retry = root.querySelector<HTMLButtonElement>('.retry-button');
    expect(retry).not.toBeNull();

    retry!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(feed).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain('Studio One');
  });
});
