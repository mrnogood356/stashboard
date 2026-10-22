import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('LocalCollectionPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(kind: 'performer' | 'studio') {
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
    return { fixture, root: fixture.nativeElement as HTMLElement, library };
  }

  it('shows the performer with their scenes and loads more', async () => {
    const { fixture, root, library } = await render('performer');

    expect(root.querySelector('h1')?.textContent).toContain('Ana Rivers');
    expect(root.textContent).toContain('Female · US');
    expect(root.textContent).toContain('30 scenes');
    expect(root.querySelectorAll('app-scene-card').length).toBe(2);

    root.querySelector<HTMLButtonElement>('.more button')!.click();
    fixture.detectChanges();
    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 2, 'DATE', 0);
    expect(root.querySelectorAll('app-scene-card').length).toBe(3);
  });

  it('changes the sort', async () => {
    const { fixture, root, library } = await render('performer');

    Array.from(root.querySelectorAll<HTMLButtonElement>('.segmented button'))
      .find((button) => button.textContent?.includes('Most played'))!
      .click();
    fixture.detectChanges();

    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 1, 'PLAYS', 0);
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

    expect(library.performerScenes).toHaveBeenLastCalledWith('p1', 1, 'RANDOM', expect.any(Number));
    expect(navigate).toHaveBeenCalledWith(['/watch', '2'], expect.anything());
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
    Array.from(root.querySelectorAll<HTMLButtonElement>('.segmented button'))
      .find((button) => button.textContent?.includes('Most played'))!
      .click();
    morePage.next({ total: 30, page: 2, hasMore: false, items: [card('old-3')] });
    fixture.detectChanges();

    const titles = Array.from(root.querySelectorAll('app-scene-card')).map(
      (element) => element.textContent ?? '',
    );
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain('PLAYS-1');
  });
});
