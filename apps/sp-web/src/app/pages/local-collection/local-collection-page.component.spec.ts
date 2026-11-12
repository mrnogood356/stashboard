import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryService } from '../../core/api/library.service';
import { LocalLibraryService, LocalSceneCard } from '../../core/api/local-library.service';
import { LocalCollectionPageComponent } from './local-collection-page.component';

function card(id: string, playCount = 0): LocalSceneCard {
  return {
    id,
    title: `Scene ${id}`,
    imageUrl: null,
    cardImageUrl: null,
    studioId: null,
    studio: null,
    studioImageUrl: null,
    releaseDate: '2025-01-01',
    duration: 600,
    playCount,
    progress: null,
    type: 'SCENE',
    source: 'STASH',
  };
}

const NO_NARROWING = { tagIds: [], studioIds: [] };

/** Opens the Sort chip's list and picks a sort by its name. */
function pickSort(fixture: { detectChanges(): void }, root: HTMLElement, label: string): void {
  root.querySelector<HTMLButtonElement>('[data-testid="collection-sort"]')!.click();
  fixture.detectChanges();
  Array.from(root.querySelectorAll<HTMLButtonElement>('.filter-option'))
    .find((button) => button.textContent?.includes(label))!
    .click();
  fixture.detectChanges();
}

describe('LocalCollectionPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(kind: 'performer' | 'studio') {
    const libraryOptions = {
      searchTags: vi.fn().mockReturnValue(
        of([
          { id: 't1', name: 'Outdoor', count: 12 },
          { id: 't2', name: 'POV', count: 5 },
        ]),
      ),
      searchStudios: vi.fn().mockReturnValue(
        of([
          { id: 's1', name: 'Harbor Light', count: 20 },
          { id: 's3', name: 'Low Tide', count: 10 },
        ]),
      ),
    };
    const library = {
      performer: vi.fn().mockReturnValue(
        of({
          id: 'p1',
          name: 'Ana Rivers',
          disambiguation: null,
          gender: 'FEMALE',
          birthdate: null,
          country: 'US',
          details: null,
          favorite: false,
          imageUrl: '/img',
          sceneCount: 30,
        }),
      ),
      studio: vi.fn().mockReturnValue(
        of({
          id: 's1',
          name: 'Harbor Light',
          favorite: true,
          imageUrl: null,
          sceneCount: 3,
          parent: null,
          children: [{ id: 's2', name: 'Harbor Nights' }],
        }),
      ),
      performerScenes: vi.fn((_id: string, page: number) =>
        of({
          total: 30,
          page,
          hasMore: page === 1,
          items: page === 1 ? [card('1', 2), card('2')] : [card('3')],
        }),
      ),
      studioScenes: vi
        .fn()
        .mockReturnValue(of({ total: 3, page: 1, hasMore: false, items: [card('7')] })),
      setPerformerFavorite: vi.fn().mockReturnValue(
        of({
          id: 'p1',
          name: 'Ana Rivers',
          gender: 'FEMALE',
          favorite: true,
          imageUrl: null,
          sceneCount: 30,
        }),
      ),
      setStudioFavorite: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [LocalCollectionPageComponent],
      providers: [
        provideRouter([]),
        { provide: LocalLibraryService, useValue: library },
        { provide: LibraryService, useValue: libraryOptions },
        {
          provide: ActivatedRoute,
          useValue: {
            data: new BehaviorSubject({ kind }),
            paramMap: new BehaviorSubject(
              convertToParamMap({ id: kind === 'studio' ? 's1' : 'p1' }),
            ),
            queryParamMap: new BehaviorSubject(convertToParamMap({})),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LocalCollectionPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, library, libraryOptions };
  }

  it('shows the performer with their scenes and loads more', async () => {
    const { fixture, root, library } = await render('performer');

    expect(root.querySelector('h1')?.textContent).toContain('Ana Rivers');
    const facts = root.querySelector('[data-testid="performer-facts"]')?.textContent ?? '';
    expect(facts).toContain('Female');
    expect(facts).toContain('United States');
    expect(root.textContent).toContain('30 scenes');
    expect(root.querySelectorAll('app-scene-card').length).toBe(2);

    root.querySelector<HTMLButtonElement>('.more button')!.click();
    fixture.detectChanges();
    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 2, 'DATE', 0, NO_NARROWING);
    expect(root.querySelectorAll('app-scene-card').length).toBe(3);
  });

  it('changes the sort', async () => {
    const { fixture, root, library } = await render('performer');

    pickSort(fixture, root, 'Most played');

    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 1, 'PLAYS', 0, NO_NARROWING);
  });

  it('favorites the performer in Stash', async () => {
    const { fixture, root, library } = await render('performer');

    root.querySelector<HTMLButtonElement>('.action.favorite')!.click();
    fixture.detectChanges();

    expect(library.setPerformerFavorite).toHaveBeenCalledWith('p1', true);
    expect(root.querySelector('.action.favorite')?.textContent).toContain('Favorite');
  });

  it('shuffle plays an unwatched scene', async () => {
    const { root, library } = await render('performer');
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);

    root.querySelector<HTMLButtonElement>('.action.primary')!.click();

    expect(library.performerScenes).toHaveBeenLastCalledWith(
      'p1',
      1,
      'RANDOM',
      expect.any(Number),
      NO_NARROWING,
    );
    expect(navigate).toHaveBeenCalledWith(['/watch', '2'], expect.anything());
  });

  it("filters to the performer's own categories and studios, counted", async () => {
    const { fixture, root, library, libraryOptions } = await render('performer');
    expect(libraryOptions.searchTags).toHaveBeenCalledWith('', { performerId: 'p1' });

    root.querySelector<HTMLButtonElement>('[data-testid="collection-category"]')!.click();
    fixture.detectChanges();
    const rows = Array.from(root.querySelectorAll('.filter-option')).map((row) =>
      row.textContent?.replace(/\s+/g, ''),
    );
    expect(rows).toEqual(['Outdoor12', 'POV5']);

    root.querySelector<HTMLButtonElement>('[data-testid="collection-category-option-t1"]')!.click();
    fixture.detectChanges();
    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 1, 'DATE', 0, {
      tagIds: ['t1'],
      studioIds: [],
    });
    expect(root.querySelector('[data-testid="collection-category"]')?.textContent).toContain(
      'Outdoor',
    );
    // Several at once: the list stays open until Done.
    root.querySelector<HTMLButtonElement>('.filter-foot__done')!.click();
    fixture.detectChanges();

    root.querySelector<HTMLButtonElement>('[data-testid="collection-studio"]')!.click();
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[data-testid="collection-studio-option-s3"]')!.click();
    fixture.detectChanges();
    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 1, 'DATE', 0, {
      tagIds: ['t1'],
      studioIds: ['s3'],
    });
  });

  it('shows a studio with its sub-studios', async () => {
    const { root, library } = await render('studio');

    expect(library.studio).toHaveBeenCalledWith('s1');
    expect(root.querySelector('h1')?.textContent).toContain('Harbor Light');
    expect(root.querySelector('.children a')?.getAttribute('href')).toContain('/library/studio/s2');
    expect(root.querySelectorAll('app-scene-card').length).toBe(1);
  });

  it('drops a "load more" page that arrives after the sort changed', async () => {
    const { fixture, root, library } = await render('performer');
    const morePage = new Subject<unknown>();
    (library.performerScenes as ReturnType<typeof vi.fn>).mockImplementation(
      (_id: string, page: number, sort: string) =>
        page === 2
          ? morePage
          : of({ total: 1, page: 1, hasMore: false, items: [card(`${sort}-1`)] }),
    );

    root.querySelector<HTMLButtonElement>('.more button')!.click();
    pickSort(fixture, root, 'Most played');
    morePage.next({ total: 30, page: 2, hasMore: false, items: [card('old-3')] });
    fixture.detectChanges();

    const titles = Array.from(root.querySelectorAll('app-scene-card')).map(
      (element) => element.textContent ?? '',
    );
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain('PLAYS-1');
  });
});
