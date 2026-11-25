import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { LibraryService } from '../../core/api/library.service';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
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
    expect(root.textContent).toContain('Pier Scene');
    expect(root.textContent).toContain('See all 30');
    expect(root.textContent).toContain('Ana Rivers');
    expect(root.textContent).toContain('Ana Catalog');
    // The catalog's scenes failed: said so, not just left out.
    expect(root.querySelector('[data-testid="search-catalog-failed"]')?.textContent).toContain(
      'couldn’t be searched',
    );
    expect(root.querySelector('a.person')?.getAttribute('href')).toContain('/library/performer/p1');
  });

  it('coming back to a search shows its results at once, without searching again or opening the keyboard', async () => {
    vi.useFakeTimers();
    // Every source answers: only then are the results kept for coming back.
    discover['searchScenes'].mockReturnValue(of({ items: [], total: 0, hidden: 0 }));
    const first = await render();
    const input = first.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'pier';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    first.fixture.detectChanges();
    expect(first.root.textContent).toContain('Pier Scene');
    first.fixture.destroy();
    TestBed.resetTestingModule();
    library['getScenesFeed'].mockClear();

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
    await TestBed.inject(Router).navigateByUrl('/?q=pier');
    const fixture = TestBed.createComponent(SearchPageComponent);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Pier Scene');
    vi.advanceTimersByTime(400);
    expect(library['getScenesFeed']).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(root.querySelector('input[type="search"]'));
    (root as HTMLElement).remove();
  });

  it('searches again on coming back when a source failed, and keeps the kind you picked', async () => {
    vi.useFakeTimers();
    // The catalog's scenes fail (the default here): nothing kept for coming back.
    const first = await render();
    const input = first.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'failed words';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    first.fixture.destroy();
    TestBed.resetTestingModule();
    library['getScenesFeed'].mockClear();
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
    await TestBed.inject(Router).navigateByUrl('/?q=failed%20words');
    const again = TestBed.createComponent(SearchPageComponent);
    again.detectChanges();
    vi.advanceTimersByTime(350);
    expect(library['getScenesFeed']).toHaveBeenCalledWith(1, 12, { query: 'failed words' });
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
    expect(root.querySelector('[data-testid="search-scenes"]')).not.toBeNull();
    expect(root.textContent).toContain('Hiding 3 scenes');

    (root.querySelector('[data-testid="hidden-count"] button') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(discover['searchScenes']).toHaveBeenLastCalledWith('ana', 1, 12, true);
    expect(root.textContent).toContain('Showing hidden scenes');
    expect(root.textContent).toContain('Catalog Scene');
  });

  it('says the catalog failed, not that nothing was found, when nothing came back', async () => {
    library['getScenesFeed'] = vi.fn().mockReturnValue(of({ total: 0, items: [] }));
    local['search'] = vi.fn().mockReturnValue(of({ performers: [], studios: [] }));
    discover['getPerformersFeed'] = vi.fn().mockReturnValue(of({ total: 0, items: [] }));
    const { root } = await search('zzz');

    expect(root.querySelector('[data-testid="search-catalog-failed"]')).not.toBeNull();
    expect(root.textContent).not.toContain('Nothing found');
  });

  it('clears or sets the catalog failure when hidden scenes are reloaded', async () => {
    const empty = { total: 3, page: 1, perPage: 12, hasMore: false, hidden: 3, items: [] };
    discover['searchScenes'] = vi
      .fn()
      .mockReturnValueOnce(throwError(() => new Error('down')))
      .mockReturnValueOnce(of(empty))
      .mockReturnValueOnce(throwError(() => new Error('down again')));
    const { fixture, root } = await search('ana');
    const failed = () => root.querySelector('[data-testid="search-catalog-failed"]');
    const component = fixture.componentInstance as unknown as {
      onShowHiddenChanged(show: boolean): void;
    };
    expect(failed()).not.toBeNull();

    component.onShowHiddenChanged(true);
    fixture.detectChanges();
    expect(failed()).toBeNull();

    component.onShowHiddenChanged(false);
    fixture.detectChanges();
    expect(failed()).not.toBeNull();
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

    expect(link('search-see-all-performers-catalog')?.textContent).toContain('See all 40');
    expect(link('search-see-all-performers-catalog')?.getAttribute('href')).toBe(
      '/performers?q=ana%20lee',
    );
    // Your library's performers: the Performers page, In my library.
    expect(link('search-see-all-performers-library')?.textContent?.trim()).toBe('See all');
    expect(link('search-see-all-performers-library')?.getAttribute('href')).toBe(
      '/performers?q=ana%20lee&lib=1',
    );
    // Shown even when every match is already here, so there's always a way on.
    expect(link('search-see-all-studios-catalog')?.textContent).toContain('See all 1');

    // Each list says where it's from, next to its link.
    expect(
      link('search-see-all-catalog')?.closest('.block-head')?.querySelector('h3')?.textContent,
    ).toContain('On StashDB');
    expect(
      link('search-see-all-library')?.closest('.block-head')?.querySelector('h3')?.textContent,
    ).toContain('In your library');
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

  it('lists your library’s and the catalog’s entries apart, each opening its own page', async () => {
    local['search'] = vi.fn().mockReturnValue(
      of({
        performers: [
          {
            id: 'p1',
            name: 'Ana Catalog',
            imageUrl: null,
            sceneCount: 9,
            favorite: false,
            catalogIds: ['c1'],
          },
        ],
        studios: [],
      }),
    );
    const { root } = await search('Ana Catalog');

    const lists = root.querySelectorAll('[data-testid="search-performers"] .source');
    expect(lists[0].querySelector('h3')?.textContent).toContain('In your library');
    expect(lists[0].querySelector('a.person')?.getAttribute('href')).toContain(
      '/library/performer/p1',
    );
    expect(lists[0].querySelector('a.person')?.textContent).toContain('9 scenes');
    expect(lists[1].querySelector('h3')?.textContent).toContain('On StashDB');
    expect(lists[1].querySelector('a.person')?.getAttribute('href')).toContain('/performer/c1');
    expect(lists[1].querySelector('a.person')?.textContent).toContain(
      '3 scenes · 9 in your library',
    );
    // Named exactly: shown first, larger, saying where it opens.
    const top = root.querySelector('[data-testid="search-top-result"]');
    expect(top?.textContent).toContain('Performer · StashDB');
    expect(top?.textContent).toContain('In library');
  });

  it('looks only in your library or only on the catalog, and offers the other when empty', async () => {
    const { fixture, root } = await search('ana');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate');

    (root.querySelector('[data-testid="search-scope-library"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Ana Rivers');
    expect(root.textContent).not.toContain('Ana Catalog');
    expect(root.querySelector('[data-testid="search-catalog-failed"]')).toBeNull();
    expect(navigate).toHaveBeenLastCalledWith(
      [],
      expect.objectContaining({ queryParams: { in: 'library' } }),
    );

    (root.querySelector('[data-testid="search-scope-catalog"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Ana Catalog');
    expect(root.textContent).not.toContain('Ana Rivers');
    expect(root.textContent).not.toContain('Pier Scene');
  });

  it('says nothing is in your library and offers the catalog’s results', async () => {
    library['getScenesFeed'] = vi
      .fn()
      .mockReturnValue(
        of({ total: 0, page: 1, perPage: 12, hasMore: false, latestSyncAt: null, items: [] }),
      );
    local['search'] = vi.fn().mockReturnValue(of({ performers: [], studios: [] }));
    const { fixture, root } = await search('ana');

    (root.querySelector('[data-testid="search-scope-library"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="search-empty"]')?.textContent).toContain(
      'Nothing in your library for “ana”',
    );
    const offer = root.querySelector<HTMLButtonElement>('[data-testid="search-elsewhere"]');
    expect(offer?.textContent).toContain('1 found on StashDB');
    offer!.click();
    fixture.detectChanges();
    expect(root.textContent).toContain('Ana Catalog');
  });

  it('shows only scenes, performers or studios when you pick one', async () => {
    const { fixture, root } = await search('ana');
    const chip = (id: string) =>
      root.querySelector<HTMLButtonElement>(`[data-testid="search-filter-${id}"]`)!;
    expect(chip('performers').textContent).toContain('2');
    expect(chip('studios').disabled).toBe(true);

    chip('performers').click();
    fixture.detectChanges();
    expect(root.querySelector('#search-scenes-title')).toBeNull();
    expect(root.querySelectorAll('[data-testid="search-performer"]').length).toBe(2);
    expect(root.querySelector('.people')?.classList).toContain('expanded');

    chip('scenes').click();
    fixture.detectChanges();
    expect(root.querySelector('#search-performers-title')).toBeNull();
    expect(root.textContent).toContain('Pier Scene');
  });

  it('goes back to All when the kind you picked has nothing for new words', async () => {
    const { fixture, root } = await search('ana');
    root.querySelector<HTMLButtonElement>('[data-testid="search-filter-performers"]')!.click();
    fixture.detectChanges();

    local['search'] = vi.fn().mockReturnValue(of({ performers: [], studios: [] }));
    discover['getPerformersFeed'] = vi.fn().mockReturnValue(of({ total: 0, items: [] }));
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'pier';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(350);
    fixture.detectChanges();

    expect(
      root.querySelector('[data-testid="search-filter-all"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(root.textContent).toContain('Pier Scene');
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
