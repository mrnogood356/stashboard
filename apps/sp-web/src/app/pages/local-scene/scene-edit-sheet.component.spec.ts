import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { PlaybackService, type LocalSceneDetails } from '../../core/api/playback.service';
import { OrganizerApiService, type MatchCandidate } from '../../core/api/organizer.service';
import { SceneEditSheetComponent } from './scene-edit-sheet.component';

function scene(overrides: Partial<LocalSceneDetails> = {}): LocalSceneDetails {
  return {
    id: '4',
    title: 'Old title',
    code: 'AB-1',
    details: 'About it',
    director: null,
    urls: ['https://studio.example/scene/1'],
    date: '2025-01-02',
    rating100: null,
    oCounter: 0,
    playCount: 0,
    resumeTime: 0,
    duration: 600,
    organized: false,
    imageUrl: null,
    studio: { id: 's1', name: 'Archive', imageUrl: null },
    performers: [{ id: 'p1', name: 'Ana', gender: null, favorite: false, imageUrl: null }],
    tags: [],
    files: [],
    catalogSceneId: null,
    viewUrl: 'http://stash/scenes/4',
    ...overrides,
  };
}

async function render(
  library: Record<string, unknown>,
  services: { organizer?: Record<string, unknown>; playback?: Record<string, unknown> } = {},
) {
  await TestBed.configureTestingModule({
    imports: [SceneEditSheetComponent],
    providers: [
      { provide: LocalLibraryService, useValue: library },
      { provide: OrganizerApiService, useValue: services.organizer ?? {} },
      { provide: PlaybackService, useValue: services.playback ?? {} },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(SceneEditSheetComponent);
  fixture.componentRef.setInput('scene', scene());
  fixture.componentRef.setInput('open', true);
  fixture.detectChanges();
  const root = () => document.querySelector('[data-testid="scene-edit-sheet"]') as HTMLElement;
  const type = (testId: string, value: string) => {
    const input = root().querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${testId}"]`,
    )!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const click = (testId: string) => {
    root().querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
    fixture.detectChanges();
  };
  return { fixture, root, type, click };
}

describe('SceneEditSheetComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('sends only what changed, and hands back what Stash saved', async () => {
    const saved = scene({ title: 'New title' });
    const library = {
      updateScene: vi.fn().mockReturnValue(of(saved)),
      searchPeople: vi.fn(),
    };
    const { fixture, type, click } = await render(library);
    const emitted = vi.fn();
    fixture.componentInstance.saved.subscribe(emitted);

    type('edit-title', '  New title ');
    type('edit-urls', 'https://studio.example/scene/1\nhttps://other.example/x');
    click('edit-save');

    expect(library.updateScene).toHaveBeenCalledWith('4', {
      title: 'New title',
      urls: ['https://studio.example/scene/1', 'https://other.example/x'],
    });
    expect(emitted).toHaveBeenCalledWith(saved);
  });

  it('picks a studio and adds and takes off performers from Stash’s own lists', async () => {
    vi.useFakeTimers();
    const library = {
      updateScene: vi.fn().mockReturnValue(of(scene())),
      searchPeople: vi.fn().mockReturnValue(
        of({
          performers: [{ id: 'p2', name: 'Bea' }],
          studios: [{ id: 's2', name: 'Harbor' }],
        }),
      ),
    };
    const { fixture, root, type, click } = await render(library);

    click('edit-pick-studio');
    type('edit-people-search', 'har');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    expect(library.searchPeople).toHaveBeenCalledWith('har');
    Array.from(root().querySelectorAll<HTMLButtonElement>('.people-results button'))
      .find((button) => button.textContent?.includes('Harbor'))!
      .click();
    fixture.detectChanges();
    expect(root().querySelector('[data-testid="edit-studio"]')?.textContent).toContain('Harbor');

    click('edit-add-performer');
    type('edit-people-search', 'bea');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    Array.from(root().querySelectorAll<HTMLButtonElement>('.people-results button'))
      .find((button) => button.textContent?.includes('Bea'))!
      .click();
    fixture.detectChanges();
    root().querySelector<HTMLButtonElement>('[aria-label="Take Ana off"]')!.click();
    fixture.detectChanges();

    click('edit-save');
    expect(library.updateScene).toHaveBeenCalledWith('4', {
      studioId: 's2',
      performerIds: ['p2'],
    });
  });

  it('adds a performer or studio Stash doesn’t have yet, from the search', async () => {
    vi.useFakeTimers();
    const library = {
      updateScene: vi.fn().mockReturnValue(of(scene())),
      searchPeople: vi.fn().mockReturnValue(
        of({
          performers: [{ id: 'p2', name: 'Cleo Grant' }],
          studios: [{ id: 's2', name: 'Harbor' }],
        }),
      ),
      createPerson: vi
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('down')))
        .mockReturnValueOnce(of({ id: 'p9', name: 'Cleo', created: true })),
    };
    const { fixture, root, type, click } = await render(library);
    const search = (text: string) => {
      type('edit-people-search', text);
      vi.advanceTimersByTime(300);
      fixture.detectChanges();
    };
    const create = () => root().querySelector('[data-testid="edit-people-create"]');

    // Stash has a studio by exactly that name: nothing to add.
    click('edit-pick-studio');
    search('harbor');
    expect(create()).toBeNull();

    click('edit-add-performer');
    search('Cleo');
    expect(create()?.textContent).toContain('Add “Cleo” to Stash');
    click('edit-people-create');
    expect(library.createPerson).toHaveBeenCalledWith('performer', 'Cleo');
    expect(root().textContent).toContain('Couldn’t add “Cleo” to Stash');
    click('edit-people-create');
    const performers = Array.from(
      root().querySelectorAll('[data-testid="edit-performer"]'),
      (chip) => chip.textContent ?? '',
    );
    expect(performers.some((name) => name.includes('Cleo'))).toBe(true);
    expect(root().textContent).not.toContain('Couldn’t add');

    click('edit-save');
    expect(library.updateScene).toHaveBeenCalledWith('4', { performerIds: ['p1', 'p9'] });
  });

  it('fills in some of the form from a StashDB match, to check before saving', async () => {
    const candidate: MatchCandidate = {
      id: 's0-remote-1',
      title: 'Summer Afternoon',
      date: '2023-08-14',
      studio: 'Bright Studio',
      performers: ['Jane Doe'],
      imageUrl: null,
      duration: 1800,
      code: null,
      details: 'About it, from StashDB',
      director: 'Lee',
      urls: ['https://stashdb.example/scenes/1'],
      source: 'StashDB',
      score: 1,
      confidence: 'exact',
      reasons: ['Same video fingerprint'],
    };
    const organizer = {
      lookup: vi
        .fn()
        .mockReturnValueOnce(of([{ sceneId: '4', searchedFor: null, candidates: [] }]))
        .mockReturnValueOnce(
          of([{ sceneId: '4', searchedFor: 'summer', candidates: [candidate] }]),
        ),
    };
    const library = { updateScene: vi.fn().mockReturnValue(of(scene())), searchPeople: vi.fn() };
    const { fixture, root, type, click } = await render(library, { organizer });

    click('edit-find-stashdb');
    expect(organizer.lookup).toHaveBeenCalledWith(['4'], undefined);
    expect(root().querySelector('[data-testid="edit-find-none"]')).not.toBeNull();
    // The form wires up a new field a moment after it appears.
    await fixture.whenStable();

    type('edit-find-query', 'summer');
    root()
      .querySelector<HTMLInputElement>('[data-testid="edit-find-query"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(organizer.lookup).toHaveBeenLastCalledWith(['4'], 'summer');
    click('edit-find-result');

    // Only what the match has is offered; no code here. Leave the director.
    expect(root().querySelector('[data-testid="edit-copy-code"]')).toBeNull();
    click('edit-copy-director');
    click('edit-copy');
    expect(root().querySelector('[data-testid="edit-finder"]')).toBeNull();

    click('edit-save');
    expect(library.updateScene).toHaveBeenCalledWith('4', {
      title: 'Summer Afternoon',
      date: '2023-08-14',
      details: 'About it, from StashDB',
      urls: ['https://stashdb.example/scenes/1'],
    });
  });

  it('matches fully from the sheet and hands back the scene as Stash now has it', async () => {
    const candidate = {
      id: 's0-remote-1',
      title: 'Summer Afternoon',
      date: '2023',
      studio: null,
      performers: [],
      imageUrl: null,
      duration: null,
      code: null,
      source: 'StashDB',
      score: 1,
      confidence: 'exact',
      reasons: [],
    } as MatchCandidate;
    const matched = scene({ title: 'Summer Afternoon', catalogSceneId: 'remote-1' });
    const organizer = {
      lookup: vi
        .fn()
        .mockReturnValue(of([{ sceneId: '4', searchedFor: null, candidates: [candidate] }])),
      apply: vi
        .fn()
        .mockReturnValueOnce(
          throwError(
            () =>
              new HttpErrorResponse({
                status: 409,
                error: { message: 'That match has expired. Look the scene up again.' },
              }),
          ),
        )
        .mockReturnValueOnce(of({ sceneId: '4', renamedTo: null })),
    };
    const playback = { getSceneDetails: vi.fn().mockReturnValue(of(matched)) };
    const library = { updateScene: vi.fn(), searchPeople: vi.fn() };
    const { fixture, root, click } = await render(library, { organizer, playback });
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);

    click('edit-find-stashdb');
    click('edit-find-result');
    // A year alone isn't a date the form takes: not offered.
    expect(root().querySelector('[data-testid="edit-copy-date"]')).toBeNull();
    click('edit-match');
    expect(root().textContent).toContain('Couldn’t match it. That match has expired.');
    click('edit-match');
    expect(organizer.apply).toHaveBeenLastCalledWith('4', 's0-remote-1');
    expect(playback.getSceneDetails).toHaveBeenCalledWith('4');
    expect(saved).toHaveBeenCalledWith(matched);
    expect(library.updateScene).not.toHaveBeenCalled();
  });

  it('after a match is saved but the scene fails to load, only loads it again', async () => {
    const candidate = {
      id: 's0-remote-1',
      title: 'Summer Afternoon',
      date: null,
      studio: null,
      performers: [],
      imageUrl: null,
      duration: null,
      code: null,
      source: 'StashDB',
      score: 1,
      confidence: 'exact',
      reasons: [],
    } as MatchCandidate;
    const matched = scene({ title: 'Summer Afternoon' });
    const organizer = {
      lookup: vi
        .fn()
        .mockReturnValue(of([{ sceneId: '4', searchedFor: null, candidates: [candidate] }])),
      apply: vi.fn().mockReturnValue(of({ sceneId: '4', renamedTo: null })),
    };
    const playback = {
      getSceneDetails: vi
        .fn()
        .mockReturnValueOnce(throwError(() => new HttpErrorResponse({ status: 502 })))
        .mockReturnValueOnce(of(matched)),
    };
    const library = { updateScene: vi.fn(), searchPeople: vi.fn() };
    const { fixture, root, click } = await render(library, { organizer, playback });
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);

    click('edit-find-stashdb');
    click('edit-find-result');
    click('edit-match');
    expect(root().textContent).toContain('It’s matched, but the scene didn’t load again.');
    // Save waits while a match is out; the match waits while the form saves.
    click('edit-match');
    expect(organizer.apply).toHaveBeenCalledTimes(1);
    expect(playback.getSceneDetails).toHaveBeenCalledTimes(2);
    expect(saved).toHaveBeenCalledWith(matched);
  });

  it('doesn’t save while a whole match is being saved, nor match while saving', async () => {
    const candidate = {
      id: 'c1',
      title: 'T',
      date: null,
      studio: null,
      performers: [],
      imageUrl: null,
      duration: null,
      code: null,
      source: 'StashDB',
      score: 1,
      confidence: 'exact',
      reasons: [],
    } as MatchCandidate;
    const applying = new Subject<{ sceneId: string; renamedTo: null }>();
    const organizer = {
      lookup: vi
        .fn()
        .mockReturnValue(of([{ sceneId: '4', searchedFor: null, candidates: [candidate] }])),
      apply: vi.fn().mockReturnValue(applying),
    };
    const library = { updateScene: vi.fn(), searchPeople: vi.fn() };
    const { root, type, click } = await render(library, {
      organizer,
      playback: { getSceneDetails: vi.fn() },
    });
    click('edit-find-stashdb');
    click('edit-find-result');
    click('edit-match');
    type('edit-title', 'Mine');
    const saveButton = root().querySelector<HTMLButtonElement>('[data-testid="edit-save"]')!;
    expect(saveButton.disabled).toBe(true);
    root().querySelector('form')!.dispatchEvent(new Event('submit'));
    expect(library.updateScene).not.toHaveBeenCalled();
  });

  it('leaves out a studio added to Stash after its picker was closed', async () => {
    vi.useFakeTimers();
    const created = new Subject<{ id: string; name: string; created: boolean }>();
    const library = {
      updateScene: vi.fn(),
      searchPeople: vi.fn().mockReturnValue(of({ performers: [], studios: [] })),
      createPerson: vi.fn().mockReturnValue(created),
    };
    const { fixture, root, type, click } = await render(library);
    click('edit-pick-studio');
    type('edit-people-search', 'Brand New');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    click('edit-people-create');
    // Done, then Archive kept: the new studio mustn't replace it.
    Array.from(root().querySelectorAll<HTMLButtonElement>('.link-button'))
      .find((button) => button.textContent?.trim() === 'Done')!
      .click();
    fixture.detectChanges();
    created.next({ id: 's9', name: 'Brand New', created: true });
    fixture.detectChanges();
    expect(root().querySelector('[data-testid="edit-studio"]')?.textContent).toContain('Archive');
  });

  it('won’t save without a title, a YYYY-MM-DD date or real links, and says why', async () => {
    const library = { updateScene: vi.fn(), searchPeople: vi.fn() };
    const { root, type } = await render(library);
    const save = () => root().querySelector<HTMLButtonElement>('[data-testid="edit-save"]')!;

    type('edit-title', '   ');
    expect(root().textContent).toContain('A scene needs a title.');
    expect(save().disabled).toBe(true);

    type('edit-title', 'Fine');
    type('edit-urls', 'studio.example/scene');
    expect(root().textContent).toContain('isn’t a link');
    expect(save().disabled).toBe(true);
    expect(library.updateScene).not.toHaveBeenCalled();
  });

  it('searches again for the same words after a pick cleared the list', async () => {
    vi.useFakeTimers();
    const library = {
      updateScene: vi.fn(),
      searchPeople: vi
        .fn()
        .mockReturnValue(of({ performers: [{ id: 'p2', name: 'Bea' }], studios: [] })),
    };
    const { fixture, root, type, click } = await render(library);
    click('edit-add-performer');
    type('edit-people-search', 'bea');
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
    root().querySelector<HTMLButtonElement>('.people-results button')!.click();
    fixture.detectChanges();

    type('edit-people-search', 'bea');
    vi.advanceTimersByTime(300);
    expect(library.searchPeople).toHaveBeenCalledTimes(2);
  });

  it('shows the API’s own reasons when it turns a save down', async () => {
    const library = {
      updateScene: vi.fn().mockReturnValue(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 400,
              error: { message: ['title must be shorter than or equal to 500 characters'] },
            }),
        ),
      ),
      searchPeople: vi.fn(),
    };
    const { root, type, click } = await render(library);
    type('edit-title', 'Changed');
    click('edit-save');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain(
      'title must be shorter than or equal to 500 characters',
    );
  });

  it('says what Stash said when saving fails, and keeps the edits', async () => {
    const library = {
      updateScene: vi
        .fn()
        .mockReturnValue(
          throwError(
            () => new HttpErrorResponse({ status: 502, error: { message: 'Stash is down.' } }),
          ),
        ),
      searchPeople: vi.fn(),
    };
    const { root, type, click } = await render(library);
    type('edit-title', 'Kept');
    click('edit-save');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('Stash is down.');
    expect(root().querySelector<HTMLInputElement>('[data-testid="edit-title"]')!.value).toBe(
      'Kept',
    );
  });
});
