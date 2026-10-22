import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { LibraryService } from '../../core/api/library.service';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { OverflowXDirective } from '../../shared/overflow-x/overflow-x.directive';
import { SearchPageComponent } from './search-page.component';

describe('SearchPageComponent', () => {
  let discover: Record<string, ReturnType<typeof vi.fn>>;
  let library: Record<string, ReturnType<typeof vi.fn>>;
  let local: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    localStorage.removeItem('stashboard.recentSearches');
    discover = {
      searchScenes: vi.fn().mockReturnValue(throwError(() => new Error('catalog down'))),
      getPerformersFeed: vi.fn().mockReturnValue(
        of({
          total: 1,
          page: 1,
          perPage: 12,
          hasMore: false,
          items: [
            {
              id: 'c1',
              name: 'Ana Catalog',
              gender: null,
              sceneCount: 3,
              isFavorite: false,
              imageUrl: null,
              cardImageUrl: null,
            },
          ],
        }),
      ),
      getStudiosFeed: vi
        .fn()
        .mockReturnValue(of({ total: 0, page: 1, perPage: 12, hasMore: false, items: [] })),
    };
    library = {
      getScenesFeed: vi.fn().mockReturnValue(
        of({
          total: 30,
          page: 1,
          perPage: 12,
          hasMore: true,
          latestSyncAt: null,
          items: [
            {
              id: '5',
              activeCatalogSceneId: null,
              title: 'Pier Scene',
              description: null,
              imageUrl: null,
              cardImageUrl: null,
              studioId: null,
              studio: null,
              studioImageUrl: null,
              performerNames: [],
              releaseDate: null,
              duration: null,
              localCreatedAt: null,
              type: 'SCENE',
              source: 'STASH',
              viewUrl: '',
            },
          ],
        }),
      ),
    };
    local = {
      search: vi.fn().mockReturnValue(
        of({
          performers: [
            { id: 'p1', name: 'Ana Rivers', imageUrl: null, sceneCount: 9, favorite: true },
          ],
          studios: [],
        }),
      ),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  async function render() {
    await TestBed.configureTestingModule({
      imports: [SearchPageComponent],
      providers: [
        provideRouter([]),
        { provide: DiscoverService, useValue: discover },
        { provide: LibraryService, useValue: library },
        { provide: LocalLibraryService, useValue: local },
        {
          provide: AppNotificationsService,
          useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchPageComponent);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('searches the library and catalog together, and a failing source does not block the rest', async () => {
    vi.useFakeTimers();
    const { fixture, root } = await render();

    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'ana';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    fixture.detectChanges();

    expect(library['getScenesFeed']).toHaveBeenCalledWith(1, 12, { query: 'ana' });
    expect(discover['searchScenes']).toHaveBeenCalledWith('ana', 1, 12, false);
    expect(root.textContent).toContain('In your library');
    expect(root.textContent).toContain('See all 30');
    expect(root.textContent).toContain('Ana Rivers');
    expect(root.textContent).toContain('Ana Catalog');
    expect(root.textContent).not.toContain('On the catalog');
    expect(root.querySelector('a.person')?.getAttribute('href')).toContain('/library/performer/p1');
  });

  it('says when the hidden list left catalog scenes out, and shows them on request', async () => {
    vi.useFakeTimers();
    const scene = {
      id: 'cat-1',
      title: 'Catalog Scene',
      description: null,
      imageUrl: null,
      cardImageUrl: null,
      studioId: null,
      studio: null,
      studioImageUrl: null,
      releaseDate: null,
      duration: null,
      type: 'SCENE',
      source: 'STASHDB',
      status: { state: 'NOT_REQUESTED' },
      requestable: true,
      localSceneId: null,
    };
    discover['searchScenes'] = vi.fn(
      (_query: string, _page: number, _perPage: number, showHidden: boolean) =>
        of(
          showHidden
            ? { total: 3, page: 1, perPage: 12, hasMore: false, hidden: 0, items: [scene, scene] }
            : { total: 3, page: 1, perPage: 12, hasMore: false, hidden: 3, items: [] },
        ),
    );
    const { fixture, root } = await render();

    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'ana';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    fixture.detectChanges();

    // Everything from the catalog was hidden: say so instead of hiding the section.
    expect(root.textContent).toContain('On the catalog');
    expect(root.textContent).toContain('Hiding 3 scenes');

    (root.querySelector('[data-testid="hidden-count"] button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(discover['searchScenes']).toHaveBeenLastCalledWith('ana', 1, 12, true);
    expect(root.textContent).toContain('Showing hidden scenes');
    expect(root.textContent).toContain('Catalog Scene');
  });

  async function search(text: string) {
    vi.useFakeTimers();
    const rendered = await render();
    const input = rendered.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    rendered.fixture.detectChanges();
    return rendered;
  }

  const catalogScene = (id: string) => ({
    id,
    title: `Catalog ${id}`,
    description: null,
    imageUrl: null,
    cardImageUrl: null,
    studioId: null,
    studio: null,
    studioImageUrl: null,
    releaseDate: null,
    duration: null,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    requestable: true,
    localSceneId: null,
  });

  it('links each section that has more results to the full list, with the query', async () => {
    discover['searchScenes'] = vi.fn(() =>
      of({
        total: 1234,
        page: 1,
        perPage: 12,
        hasMore: true,
        hidden: 0,
        items: [catalogScene('a'), catalogScene('b')],
      }),
    );
    discover['getPerformersFeed'] = vi.fn(() =>
      of({
        total: 40,
        page: 1,
        perPage: 12,
        hasMore: true,
        items: [
          {
            id: 'c1',
            name: 'Ana Catalog',
            gender: null,
            sceneCount: 3,
            isFavorite: false,
            imageUrl: null,
            cardImageUrl: null,
          },
        ],
      }),
    );
    discover['getStudiosFeed'] = vi.fn(() =>
      of({
        total: 1,
        page: 1,
        perPage: 12,
        hasMore: false,
        items: [{ id: 'st1', name: 'Ana Studio', imageUrl: null }],
      }),
    );
    const { root } = await search('ana lee');
    const link = (id: string) => root.querySelector<HTMLAnchorElement>(`[data-testid="${id}"]`);

    expect(link('search-see-all-library')?.textContent).toContain('See all 30');
    expect(link('search-see-all-library')?.getAttribute('href')).toBe('/library?query=ana%20lee');

    expect(link('search-see-all-catalog')?.textContent).toContain('See all 1,234');
    expect(link('search-see-all-catalog')?.getAttribute('href')).toBe('/scenes?q=ana%20lee');

    expect(link('search-see-all-performers')?.textContent).toContain('All 40 performers');
    expect(link('search-see-all-performers')?.getAttribute('href')).toBe('/performers?q=ana%20lee');
    // Every matching studio is already shown.
    expect(link('search-see-all-studios')).toBeNull();
    // Your own performers fit on screen: nothing to expand.
    expect(link('search-see-all-local-people')).toBeNull();

    // The link sits in the section header, next to the title.
    expect(link('search-see-all-catalog')?.parentElement?.querySelector('h2')?.textContent).toBe(
      'On the catalog',
    );
  });

  it('keeps hidden scenes showing when the catalog "See all" opens Scenes', async () => {
    discover['searchScenes'] = vi.fn(() =>
      of({ total: 50, page: 1, perPage: 12, hasMore: true, hidden: 2, items: [catalogScene('a')] }),
    );
    const { fixture, root } = await search('ana');
    (root.querySelector('[data-testid="hidden-count"] button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(root.querySelector('[data-testid="search-see-all-catalog"]')?.getAttribute('href')).toBe(
      '/scenes?q=ana&showHidden=1',
    );
  });

  it('offers "See all" when a rail is cut off even if every result is loaded', async () => {
    library['getScenesFeed'] = vi.fn(() =>
      of({ total: 1, page: 1, perPage: 12, hasMore: false, latestSyncAt: null, items: [] }),
    );
    discover['searchScenes'] = vi.fn(() =>
      of({
        total: 2,
        page: 1,
        perPage: 12,
        hasMore: false,
        hidden: 0,
        items: [catalogScene('a'), catalogScene('b')],
      }),
    );
    const { fixture, root } = await search('ana');
    expect(root.querySelector('[data-testid="search-see-all-catalog"]')).toBeNull();

    const rail = fixture.debugElement.query(By.css('.rail'));
    Object.defineProperty(rail.nativeElement, 'scrollWidth', { value: 900 });
    Object.defineProperty(rail.nativeElement, 'clientWidth', { value: 375 });
    rail.injector.get(OverflowXDirective).check();
    fixture.detectChanges();

    expect(root.querySelector('[data-testid="search-see-all-catalog"]')?.textContent).toContain(
      'See all 2',
    );
  });

  it('expands your performers and studios in place when the row is cut off', async () => {
    const { fixture, root } = await search('ana');
    const row = fixture.debugElement.query(By.css('#search-local-people'));
    Object.defineProperty(row.nativeElement, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(row.nativeElement, 'clientWidth', { value: 375, configurable: true });
    row.injector.get(OverflowXDirective).check();
    fixture.detectChanges();

    const toggle = () =>
      root.querySelector<HTMLButtonElement>('[data-testid="search-see-all-local-people"]')!;
    expect(toggle().textContent).toContain('Show all 1');
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(toggle().getAttribute('aria-controls')).toBe('search-local-people');

    toggle().click();
    // Wrapped, nothing is cut off any more; the button stays to fold it back.
    Object.defineProperty(row.nativeElement, 'scrollWidth', { value: 375 });
    row.injector.get(OverflowXDirective).check();
    fixture.detectChanges();

    expect(row.nativeElement.classList).toContain('expanded');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().textContent).toContain('Show less');

    toggle().click();
    fixture.detectChanges();
    expect(row.nativeElement.classList).not.toContain('expanded');
  });

  it('remembers searches you act on and lets you clear them', async () => {
    vi.useFakeTimers();
    const { fixture, root } = await render();
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'pier';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    expect(JSON.parse(localStorage.getItem('stashboard.recentSearches') ?? '[]')).toEqual(['pier']);

    (fixture.componentInstance as unknown as { clear(): void }).clear();
    vi.advanceTimersByTime(350);
    fixture.detectChanges();
    expect(root.textContent).toContain('Recent');
    expect(root.textContent).toContain('pier');
  });
});
