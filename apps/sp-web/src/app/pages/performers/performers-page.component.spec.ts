import { LibraryService } from '../../core/api/library.service';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { PerformerFeedItem } from '../../core/api/discover.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { PerformersPageComponent } from './performers-page.component';

function performer(overrides: Partial<PerformerFeedItem> = {}): PerformerFeedItem {
  return {
    id: 'performer-1',
    name: 'Ana Rivers',
    gender: 'FEMALE',
    sceneCount: 12,
    isFavorite: false,
    imageUrl: null,
    cardImageUrl: null,
    ...overrides,
  };
}

const feedOf = (items: PerformerFeedItem[]) =>
  of({ total: items.length, page: 1, perPage: 24, hasMore: false, items });

describe('PerformersPageComponent', () => {
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
      library?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const library = {
      listPerformers:
        options.library ??
        vi.fn().mockReturnValue(
          of({
            total: 1,
            page: 1,
            perPage: 48,
            hasMore: false,
            items: [{ id: '7', name: 'Lena Moss', count: 12, imageUrl: '/img/7' }],
          }),
        ),
    };
    const discover = {
      getPerformersFeed: options.feed ?? vi.fn().mockReturnValue(feedOf([performer()])),
      favoritePerformer:
        options.favorite ?? vi.fn().mockReturnValue(of({ alreadyFavorited: false })),
    };
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    const route = {
      queryParamMap: new BehaviorSubject(convertToParamMap(options.query ?? {})),
      snapshot: { queryParamMap: convertToParamMap(options.query ?? {}) },
    };
    /** The address changes to these query parameters. */
    const goTo = (query: Record<string, string>) => {
      route.snapshot.queryParamMap = convertToParamMap(query);
      route.queryParamMap.next(convertToParamMap(query));
    };
    await TestBed.configureTestingModule({
      imports: [PerformersPageComponent],
      providers: [
        provideRouter([]),
        { provide: DiscoverService, useValue: discover },
        { provide: LibraryService, useValue: library },
        { provide: ActivatedRoute, useValue: route },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(PerformersPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      discover,
      notifications,
      library,
      goTo,
    };
  }

  it('lists only people in your own scenes with In my library, searched by name', async () => {
    const { root, library } = await render({ query: { lib: '1', q: 'lena' } });
    expect(library.listPerformers).toHaveBeenCalledWith('lena', 1);
    const grid = root.querySelector('[data-testid="library-performers"]');
    expect(grid?.textContent).toContain('Lena Moss');
    expect(grid?.textContent).toContain('12 scenes of yours');
    expect(grid?.querySelector('a')?.getAttribute('href')).toContain('/library/performer/7/all');
    expect(
      root.querySelector('[data-testid="performers-in-library"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('leaves the hidden catalog list alone in library mode, and loads it on the way back', async () => {
    const feed = vi.fn().mockReturnValue(feedOf([performer()]));
    const { fixture, goTo } = await render({ query: { lib: '1', q: 'lena' }, feed });
    expect(feed).not.toHaveBeenCalled();

    // A new search while the library list is shown.
    goTo({ lib: '1', q: 'mia' });
    fixture.detectChanges();
    expect(feed).not.toHaveBeenCalled();

    // Back to the catalog: it loads once, with the current search.
    goTo({ q: 'mia' });
    fixture.detectChanges();
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it('holds a reload queued behind a slow catalog page until library mode is left', async () => {
    const slow = new Subject<never>();
    const feed = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockReturnValue(feedOf([performer()]));
    const { fixture, goTo } = await render({ feed });
    expect(feed).toHaveBeenCalledTimes(1);

    // A new search while the first page is still loading, then In my library.
    goTo({ q: 'mia' });
    goTo({ lib: '1', q: 'mia' });
    fixture.detectChanges();
    slow.complete();
    fixture.detectChanges();
    expect(feed).toHaveBeenCalledTimes(1);

    goTo({ q: 'mia' });
    fixture.detectChanges();
    expect(feed).toHaveBeenCalledTimes(2);
  });

  it('keeps the people already shown when the next page fails, with Try again', async () => {
    const page = (n: number, id: string) =>
      of({
        total: 2,
        page: n,
        perPage: 1,
        hasMore: n === 1,
        items: [{ id, name: `Person ${id}`, count: 3, imageUrl: `/img/${id}` }],
      });
    const listPerformers = vi
      .fn()
      .mockReturnValueOnce(page(1, '1'))
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValueOnce(page(2, '2'));
    const { root, fixture } = await render({ query: { lib: '1' }, library: listPerformers });

    (root.querySelector('.show-more-library') as HTMLButtonElement).click();
    fixture.detectChanges();
    const grid = () => root.querySelector('[data-testid="library-performers"]')?.textContent ?? '';
    expect(grid()).toContain('Person 1');
    (root.querySelector('[data-testid="library-performers-retry"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(listPerformers).toHaveBeenLastCalledWith('', 2);
    expect(grid()).toContain('Person 1');
    expect(grid()).toContain('Person 2');
  });

  it('sorts and filters from the filter bar, like Scenes', async () => {
    const { fixture, root, discover } = await render();
    const open = (id: string) => {
      (root.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click();
      fixture.detectChanges();
    };

    open('performers-sort');
    open('performers-sort-option-SCENE_COUNT:DESC');
    expect(discover.getPerformersFeed).toHaveBeenLastCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ sort: 'SCENE_COUNT', direction: 'DESC' }),
    );

    open('performers-gender');
    open('performers-gender-option-FEMALE');
    expect(discover.getPerformersFeed).toHaveBeenLastCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ gender: 'FEMALE' }),
    );

    open('performers-favorites');
    expect(discover.getPerformersFeed).toHaveBeenLastCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ favoritesOnly: true }),
    );
    expect(root.querySelector('p-select')).toBeNull();
  });

  it('lists performers', async () => {
    const { root, discover } = await render();

    expect(discover.getPerformersFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ favoritesOnly: false }),
    );
    expect(root.textContent).toContain('Ana Rivers');
  });

  it('reads search, gender and favorites from the address bar, ignoring unknown values', async () => {
    const { discover } = await render({ query: { q: ' ana ', gender: 'FEMALE', fav: '1' } });
    expect(discover.getPerformersFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.objectContaining({ name: 'ana', gender: 'FEMALE', favoritesOnly: true }),
    );
    TestBed.resetTestingModule();

    const bogus = await render({ query: { gender: 'NOT_A_GENDER' } });
    expect(bogus.discover.getPerformersFeed).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.not.objectContaining({ gender: 'NOT_A_GENDER' }),
    );
  });

  it('favorites a performer in place', async () => {
    const { fixture, root, discover, notifications } = await render();
    root.querySelector<HTMLButtonElement>('[aria-label="Favorite performer"]')!.click();
    fixture.detectChanges();

    expect(discover.favoritePerformer).toHaveBeenCalledWith('performer-1', true);
    expect(notifications.success).toHaveBeenCalledWith('Performer favorited');
    expect(root.querySelector('[aria-label="Unfavorite performer"]')).not.toBeNull();
  });

  it('removes an unfavorited performer from the favorites-only list', async () => {
    const feed = vi
      .fn()
      .mockReturnValueOnce(feedOf([performer({ isFavorite: true })]))
      .mockReturnValue(feedOf([]));
    const { fixture, root } = await render({ query: { fav: 'true' }, feed });
    root.querySelector<HTMLButtonElement>('[aria-label="Unfavorite performer"]')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(feed).toHaveBeenCalledTimes(2);
    expect(root.textContent).not.toContain('Ana Rivers');
  });

  it('says so when favoriting fails', async () => {
    const { fixture, root, notifications } = await render({
      favorite: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    root.querySelector<HTMLButtonElement>('[aria-label="Favorite performer"]')!.click();
    fixture.detectChanges();

    expect(notifications.error).toHaveBeenCalledWith('Failed to favorite performer');
  });

  it('offers a retry when the feed fails to load', async () => {
    const feed = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValue(feedOf([performer()]));
    const { fixture, root } = await render({ feed });

    root.querySelector<HTMLButtonElement>('.retry-button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.textContent).toContain('Ana Rivers');
  });
});
