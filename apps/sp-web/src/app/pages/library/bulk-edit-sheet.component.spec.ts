import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { BulkEditSheetComponent } from './bulk-edit-sheet.component';

async function render(library: Record<string, unknown>, sceneIds = ['1', '2', '3']) {
  await TestBed.configureTestingModule({
    imports: [BulkEditSheetComponent],
    providers: [{ provide: LocalLibraryService, useValue: library }],
  }).compileComponents();
  const fixture = TestBed.createComponent(BulkEditSheetComponent);
  fixture.componentRef.setInput('sceneIds', sceneIds);
  fixture.componentRef.setInput('open', true);
  fixture.detectChanges();
  const root = () => document.querySelector('[data-testid="bulk-edit-sheet"]') as HTMLElement;
  const click = (testId: string) => {
    root().querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
    fixture.detectChanges();
  };
  const search = (text: string) => {
    const input = root().querySelector<HTMLInputElement>('[data-testid="bulk-search"]')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    vi.advanceTimersByTime(300);
    fixture.detectChanges();
  };
  const choose = (name: string) => {
    Array.from(root().querySelectorAll<HTMLButtonElement>('.people-results button'))
      .find((button) => button.textContent?.includes(name))!
      .click();
    fixture.detectChanges();
  };
  return { fixture, root, click, search, choose };
}

describe('BulkEditSheetComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('sets a studio, adds people and tags, takes others off, and saves it all at once', async () => {
    vi.useFakeTimers();
    const library = {
      searchPeople: vi.fn().mockReturnValue(
        of({
          performers: [
            { id: 'p1', name: 'Ana' },
            { id: 'p2', name: 'Bea' },
          ],
          studios: [{ id: 's1', name: 'Harbor' }],
        }),
      ),
      searchTags: vi.fn().mockReturnValue(of([{ id: 't1', name: 'Outdoor' }])),
      bulkEditScenes: vi.fn().mockReturnValue(of({ edited: 3 })),
    };
    const { fixture, root, click, search, choose } = await render(library);
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);

    expect(root().textContent).toContain('Edit 3 scenes');
    // Nothing picked yet: nothing to save.
    expect(root().querySelector<HTMLButtonElement>('[data-testid="bulk-save"]')!.disabled).toBe(
      true,
    );

    click('bulk-pick-studio');
    search('har');
    choose('Harbor');
    expect(root().querySelector('[data-testid="bulk-studio"]')?.textContent).toContain('Harbor');

    click('bulk-pick-add-performer');
    search('an');
    choose('Ana');
    // Picked to take off after all: it moves, it isn't in both.
    click('bulk-pick-remove-performer');
    search('an');
    choose('Ana');
    search('bea');
    choose('Bea');
    expect(root().querySelectorAll('[data-testid="bulk-add-performer"]')).toHaveLength(0);
    expect(root().querySelectorAll('[data-testid="bulk-remove-performer"]')).toHaveLength(2);

    click('bulk-pick-add-tag');
    search('out');
    expect(library.searchTags).toHaveBeenCalledWith('out');
    choose('Outdoor');

    click('bulk-save');
    expect(library.bulkEditScenes).toHaveBeenCalledWith({
      sceneIds: ['1', '2', '3'],
      studioId: 's1',
      addPerformerIds: [],
      removePerformerIds: ['p1', 'p2'],
      addTagIds: ['t1'],
      removeTagIds: [],
    });
    expect(saved).toHaveBeenCalledWith(3);
  });

  it('adds a new performer to Stash, and says why a save didn’t work', async () => {
    vi.useFakeTimers();
    const library = {
      searchPeople: vi.fn().mockReturnValue(of({ performers: [], studios: [] })),
      searchTags: vi.fn(),
      createPerson: vi.fn().mockReturnValue(of({ id: 'p9', name: 'Cleo', created: true })),
      bulkEditScenes: vi
        .fn()
        .mockReturnValue(
          throwError(
            () => new HttpErrorResponse({ status: 502, error: { message: 'Stash is down.' } }),
          ),
        ),
    };
    const { root, click, search } = await render(library, ['1']);

    expect(root().textContent).toContain('Edit 1 scene');
    click('bulk-pick-add-performer');
    search('Cleo');
    click('bulk-create');
    expect(library.createPerson).toHaveBeenCalledWith('performer', 'Cleo');
    expect(root().querySelector('[data-testid="bulk-add-performer"]')?.textContent).toContain(
      'Cleo',
    );

    // Taking off: nothing new to make.
    click('bulk-pick-remove-performer');
    search('Dana');
    expect(root().querySelector('[data-testid="bulk-create"]')).toBeNull();

    click('bulk-save');
    expect(root().textContent).toContain('Couldn’t save that to Stash. Stash is down.');
  });
});
