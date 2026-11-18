import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLibraryService } from '../../core/api/local-library.service';
import type { LocalSceneDetails } from '../../core/api/playback.service';
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

async function render(library: Record<string, unknown>) {
  await TestBed.configureTestingModule({
    imports: [SceneEditSheetComponent],
    providers: [{ provide: LocalLibraryService, useValue: library }],
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
