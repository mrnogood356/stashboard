import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSceneDetails, PlaybackService } from '../../core/api/playback.service';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { DiagnosticsApiService } from '../../core/api/diagnostics.service';
import { LocalScenePageComponent } from './local-scene-page.component';

function sceneDetails(overrides: Partial<LocalSceneDetails> = {}): LocalSceneDetails {
  return {
    id: '12',
    title: 'Sunset Scene',
    code: null,
    details: 'A short overview.',
    date: '2026-01-02',
    rating100: 80,
    oCounter: 0,
    playCount: 2,
    resumeTime: 0,
    duration: 1800,
    organized: false,
    imageUrl: '/api/media/stash/scenes/12/screenshot',
    studio: { id: '5', name: 'Studio Five', imageUrl: null },
    performers: [{ id: '7', name: 'Ana', gender: null, favorite: true, imageUrl: null }],
    tags: [{ id: '9', name: 'Outdoor' }],
    files: [
      {
        basename: 'sunset.mp4',
        size: 1_610_612_736,
        duration: 1800,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'mp4',
        frameRate: 29.97,
        bitRate: 7_200_000,
      },
    ],
    catalogSceneId: null,
    viewUrl: 'http://stash.local/scenes/12',
    ...overrides,
  };
}

describe('LocalScenePageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  let library: {
    related: ReturnType<typeof vi.fn>;
    updateScene: ReturnType<typeof vi.fn>;
    setWatched: ReturnType<typeof vi.fn>;
    searchTags: ReturnType<typeof vi.fn>;
  };
  const diagnosticsApi = { catalogScene: vi.fn(), localScene: vi.fn() };

  async function render(getSceneDetails: ReturnType<typeof vi.fn>) {
    library = {
      related: vi.fn().mockReturnValue(of([])),
      updateScene: vi.fn((_id: string, update: Record<string, unknown>) =>
        of(
          sceneDetails({
            ...(update['rating100'] !== undefined
              ? { rating100: update['rating100'] as number | null }
              : {}),
          }),
        ),
      ),
      setWatched: vi.fn().mockReturnValue(of(sceneDetails({ playCount: 0 }))),
      searchTags: vi.fn().mockReturnValue(of([{ id: '50', name: 'Beach' }])),
    };
    const params = new BehaviorSubject(convertToParamMap({ sceneId: '12' }));
    const query = new BehaviorSubject(convertToParamMap({ returnTo: '/home' }));
    await TestBed.configureTestingModule({
      imports: [LocalScenePageComponent],
      providers: [
        provideRouter([]),
        { provide: PlaybackService, useValue: { getSceneDetails } },
        { provide: LocalLibraryService, useValue: library },
        { provide: DiagnosticsApiService, useValue: diagnosticsApi },
        { provide: ActivatedRoute, useValue: { paramMap: params, queryParamMap: query } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(LocalScenePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, params };
  }

  it('shows the scene with a Play button that opens the built-in player', async () => {
    const { root } = await render(vi.fn().mockReturnValue(of(sceneDetails())));

    expect(root.querySelector('h1')?.textContent).toContain('Sunset Scene');
    const play = root.querySelector<HTMLAnchorElement>('a.action.primary');
    expect(play?.textContent).toContain('Play');
    expect(play?.getAttribute('href')).toContain('/watch/12');
    expect(root.textContent).toContain('1080p');
    expect(root.textContent).toContain('Watched 2×');
    expect(root.textContent).toContain('Ana');
    expect(root.textContent).toContain('Outdoor');
    expect(root.textContent).toContain('1.5 GB');
    expect(root.querySelector('.back-link')?.textContent).toContain('Back to Home');
    // Not linked to StashDB, so there is no catalog page button.
    expect(root.textContent).not.toContain('Catalog page');
  });

  it('has a collapsed “Why is it like this?” panel for the Stash scene', async () => {
    diagnosticsApi.localScene.mockReset().mockReturnValue(of(null));
    const { root } = await render(vi.fn().mockReturnValue(of(sceneDetails())));
    const toggle = root.querySelector<HTMLButtonElement>('app-scene-evidence .evidence-toggle');

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(diagnosticsApi.localScene).not.toHaveBeenCalled();

    toggle!.click();
    expect(diagnosticsApi.localScene).toHaveBeenCalledWith('12');
  });

  it('offers resume and start-over when the scene was partly watched', async () => {
    const { root } = await render(
      vi.fn().mockReturnValue(of(sceneDetails({ resumeTime: 754, catalogSceneId: 'cat-1' }))),
    );

    expect(root.querySelector('a.action.primary')?.textContent).toContain('Resume from 12:34');
    const fromStart = Array.from(root.querySelectorAll<HTMLAnchorElement>('a.action')).find(
      (link) => link.textContent?.includes('From the start'),
    );
    expect(fromStart?.getAttribute('href')).toContain('t=0');
    expect(root.textContent).toContain('Catalog page');
    expect(root.querySelector('.poster-progress')).not.toBeNull();
  });

  it('treats a nearly finished scene as watched and plays from the start', async () => {
    const { root } = await render(vi.fn().mockReturnValue(of(sceneDetails({ resumeTime: 1795 }))));

    expect(root.querySelector('a.action.primary')?.textContent?.trim()).toBe('Play');
  });

  it('explains when the scene cannot be loaded and can retry', async () => {
    const getSceneDetails = vi
      .fn()
      .mockReturnValueOnce(
        throwError(() => new HttpErrorResponse({ status: 404, error: { message: 'Gone.' } })),
      )
      .mockReturnValue(of(sceneDetails()));
    const { fixture, root } = await render(getSceneDetails);

    expect(root.textContent).toContain('Gone.');
    root.querySelector<HTMLButtonElement>('.state-panel button')!.click();
    fixture.detectChanges();
    expect(root.querySelector('h1')?.textContent).toContain('Sunset Scene');
  });

  it('rates the scene with a tap and clears it when the same star is tapped', async () => {
    const { fixture, root } = await render(
      vi.fn().mockReturnValue(of(sceneDetails({ rating100: 60 }))),
    );

    root.querySelector<HTMLButtonElement>('[aria-label="Rate 5 stars"]')!.click();
    fixture.detectChanges();
    expect(library.updateScene).toHaveBeenCalledWith('12', { rating100: 100 });

    root.querySelector<HTMLButtonElement>('[aria-label="Rate 5 stars"]')!.click();
    expect(library.updateScene).toHaveBeenLastCalledWith('12', { rating100: null });
  });

  it('marks the scene unwatched', async () => {
    const { fixture, root } = await render(
      vi.fn().mockReturnValue(of(sceneDetails({ playCount: 2 }))),
    );

    const toggle = Array.from(root.querySelectorAll<HTMLButtonElement>('.toggle-chip')).find(
      (button) => button.textContent?.includes('Watched'),
    );
    toggle!.click();
    fixture.detectChanges();

    expect(library.setWatched).toHaveBeenCalledWith('12', false);
    expect(root.textContent).toContain('Unwatched');
  });

  it('adds and removes tags', async () => {
    vi.useFakeTimers();
    const { fixture, root } = await render(vi.fn().mockReturnValue(of(sceneDetails())));

    Array.from(root.querySelectorAll<HTMLButtonElement>('.panel-head .link-button'))[0].click();
    fixture.detectChanges();
    const input = root.querySelector<HTMLInputElement>('.tag-search input')!;
    input.value = 'bea';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(250);
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('.tag-results button')!.click();
    expect(library.updateScene).toHaveBeenCalledWith('12', { tagIds: ['9', '50'] });

    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[aria-label="Remove tag Outdoor"]')!.click();
    expect(library.updateScene).toHaveBeenLastCalledWith('12', { tagIds: [] });
    vi.useRealTimers();
  });

  it('lists chapters that open the player at that time, and related scenes', async () => {
    const getSceneDetails = vi.fn().mockReturnValue(
      of(
        sceneDetails({
          markers: [{ id: 'm1', title: 'Beach', seconds: 125.4, imageUrl: '/m1' }],
        }),
      ),
    );
    const { fixture, root } = await render(getSceneDetails);
    library.related.mockReturnValue(of([]));

    const chapter = root.querySelector<HTMLAnchorElement>('a.chapter')!;
    expect(chapter.textContent).toContain('2:05');
    expect(chapter.getAttribute('href')).toContain('/watch/12');
    expect(chapter.getAttribute('href')).toContain('t=125');
    fixture.detectChanges();
  });

  it('keeps a save for the scene you left off the scene you opened', async () => {
    const getSceneDetails = vi.fn((id: string) =>
      of(sceneDetails(id === '13' ? { id: '13', title: 'Next Scene' } : {})),
    );
    const { fixture, root, params } = await render(getSceneDetails);
    const saved = new Subject<LocalSceneDetails>();
    library.updateScene.mockReturnValue(saved);

    root.querySelector<HTMLButtonElement>('[aria-label="Rate 5 stars"]')!.click();
    params.next(convertToParamMap({ sceneId: '13' }));
    saved.next(sceneDetails({ rating100: 100 }));
    fixture.detectChanges();

    expect(root.textContent).toContain('Next Scene');
    expect(root.textContent).not.toContain('Sunset Scene');
  });

  it('shows the last scene opened when two load at once', async () => {
    const answers: Record<string, Subject<LocalSceneDetails>> = {
      '13': new Subject(),
      '14': new Subject(),
    };
    const getSceneDetails = vi.fn((id: string) => answers[id] ?? of(sceneDetails()));
    const { fixture, root, params } = await render(getSceneDetails);

    params.next(convertToParamMap({ sceneId: '13' }));
    params.next(convertToParamMap({ sceneId: '14' }));
    answers['14'].next(sceneDetails({ id: '14', title: 'Fourteen' }));
    answers['13'].next(sceneDetails({ id: '13', title: 'Thirteen' }));
    fixture.detectChanges();

    expect(root.textContent).toContain('Fourteen');
    expect(root.textContent).not.toContain('Thirteen');
  });
});
