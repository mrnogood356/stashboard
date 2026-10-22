import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  FixKind,
  LocalLibraryService,
  LocalSceneCard,
  LocalScenePage,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { FixLibraryPageComponent } from './fix-library-page.component';

function card(id: string): LocalSceneCard {
  return {
    id,
    title: `Scene ${id}`,
    imageUrl: null,
    cardImageUrl: null,
    studioId: null,
    studio: null,
    studioImageUrl: null,
    releaseDate: null,
    duration: null,
    playCount: 0,
    progress: null,
    type: 'SCENE',
    source: 'STASH',
  };
}

function page(ids: string[], hasMore = false, pageNumber = 1): LocalScenePage {
  return { total: ids.length, page: pageNumber, hasMore, items: ids.map(card) };
}

async function render(library: Record<string, unknown>) {
  const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [FixLibraryPageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(FixLibraryPageComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
}

function tab(root: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.segmented button')).find((entry) =>
    entry.textContent?.includes(label),
  )!;
}

function titles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.row-title')).map((el) => el.textContent!.trim());
}

describe('FixLibraryPageComponent', () => {
  it('shows a count on each tab and loads the list for the tab picked', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 4, untagged: 7, unorganized: 0 })),
      fixScenes: vi.fn((kind: FixKind) => of(page(kind === 'untagged' ? ['t1'] : ['u1']))),
      identify: vi.fn(),
      updateScene: vi.fn(),
    };
    const { fixture, root } = await render(library);

    expect(library.fixScenes).toHaveBeenCalledWith('unmatched', 1);
    expect(tab(root, 'Not matched').querySelector('.count-badge')?.textContent).toBe('4');
    expect(tab(root, 'No tags').querySelector('.count-badge')?.textContent).toBe('7');
    expect(titles(root)).toEqual(['Scene u1']);
    expect(root.querySelector('a.organizer-link')?.getAttribute('href')).toBe('/tools/organize');

    tab(root, 'No tags').click();
    fixture.detectChanges();

    expect(library.fixScenes).toHaveBeenLastCalledWith('untagged', 1);
    expect(tab(root, 'No tags').getAttribute('aria-selected')).toBe('true');
    expect(titles(root)).toEqual(['Scene t1']);
    expect(root.querySelector('a.organizer-link')).toBeNull();
  });

  it('shows more by carrying on after the scenes shown, even if some left the list', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 3, untagged: 0, unorganized: 0 })),
      fixScenes: vi.fn((_kind: FixKind, number: number) =>
        of(number === 1 ? page(['1', '2'], true) : page(['3'], false, 2)),
      ),
      identify: vi.fn(),
      updateScene: vi.fn(),
    };
    const { fixture, root } = await render(library);

    Array.from(root.querySelectorAll<HTMLButtonElement>('.more button'))[0].click();
    fixture.detectChanges();

    // Two scenes are shown, so the next ones start after them.
    expect(library.fixScenes).toHaveBeenLastCalledWith('unmatched', 2, 2);
    expect(titles(root)).toEqual(['Scene 1', 'Scene 2', 'Scene 3']);
    expect(root.querySelector('.more')).toBeNull();
  });

  it('says all clear when a list is empty', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 0, untagged: 0, unorganized: 0 })),
      fixScenes: vi.fn().mockReturnValue(of(page([]))),
      identify: vi.fn(),
      updateScene: vi.fn(),
    };
    const { root } = await render(library);

    expect(root.textContent).toContain('All clear. Nothing on this list.');
    // "Identify these" only appears for more than one scene.
    expect(root.querySelector('.list-head .btn')).toBeNull();
  });

  it('shows an error when the list cannot be loaded', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      fixScenes: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      identify: vi.fn(),
      updateScene: vi.fn(),
    };
    const { root } = await render(library);

    expect(root.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load this list");
    expect(root.querySelector('.count-badge')).toBeNull();
    expect(root.textContent).not.toContain('All clear');
  });

  it("ignores a list that answers after you've switched to another tab", async () => {
    const unmatched = new Subject<LocalScenePage>();
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 1, untagged: 1, unorganized: 1 })),
      fixScenes: vi.fn((kind: FixKind) => (kind === 'unmatched' ? unmatched : of(page(['n1'])))),
      identify: vi.fn(),
      updateScene: vi.fn(),
    };
    const { fixture, root } = await render(library);

    tab(root, 'Not organized').click();
    fixture.detectChanges();
    unmatched.next(page(['late']));
    fixture.detectChanges();

    expect(titles(root)).toEqual(['Scene n1']);
    // Not-organized rows get "Done", not "Identify".
    expect(root.querySelector('.row-actions')?.textContent).toContain('Done');
  });

  it('reports the server reason when Identify cannot start', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 1, untagged: 0, unorganized: 0 })),
      fixScenes: vi.fn().mockReturnValue(of(page(['1']))),
      identify: vi
        .fn()
        .mockReturnValue(throwError(() => ({ error: { message: 'No stash-box set up' } }))),
      updateScene: vi.fn(),
    };
    const { fixture, root, notifications } = await render(library);

    const identify = root.querySelector<HTMLButtonElement>('[aria-label="Identify Scene 1"]')!;
    identify.click();
    fixture.detectChanges();

    expect(library.identify).toHaveBeenCalledWith(['1']);
    expect(notifications.error).toHaveBeenCalledWith(
      "Couldn't start Identify",
      'No stash-box set up',
    );
    expect(identify.disabled).toBe(false);
  });

  it('marking organized lowers the count, and a failure keeps the scene', async () => {
    const library = {
      fixCounts: vi.fn().mockReturnValue(of({ unmatched: 0, untagged: 0, unorganized: 2 })),
      fixScenes: vi.fn().mockReturnValue(of(page(['1', '2']))),
      identify: vi.fn(),
      updateScene: vi.fn((id: string) =>
        id === '1' ? of({}) : throwError(() => new Error('nope')),
      ),
    };
    const { fixture, root, notifications } = await render(library);

    tab(root, 'Not organized').click();
    fixture.detectChanges();
    expect(root.querySelector('.list-head .btn')).toBeNull();

    root.querySelectorAll<HTMLButtonElement>('.row .btn')[0].click();
    fixture.detectChanges();
    expect(library.updateScene).toHaveBeenCalledWith('1', { organized: true });
    expect(titles(root)).toEqual(['Scene 2']);
    expect(tab(root, 'Not organized').querySelector('.count-badge')?.textContent).toBe('1');

    root.querySelector<HTMLButtonElement>('.row .btn')!.click();
    fixture.detectChanges();
    expect(library.updateScene).toHaveBeenCalledWith('2', { organized: true });
    expect(notifications.error).toHaveBeenCalledWith("Couldn't update Stash", expect.any(String));
    expect(titles(root)).toEqual(['Scene 2']);
    expect(tab(root, 'Not organized').querySelector('.count-badge')?.textContent).toBe('1');
  });

  it('reloads the list and counts once Stash finishes an Identify started here', async () => {
    const library = {
      fixCounts: vi
        .fn()
        .mockReturnValueOnce(of({ unmatched: 2, untagged: 0, unorganized: 0 }))
        .mockReturnValue(of({ unmatched: 1, untagged: 0, unorganized: 0 })),
      fixScenes: vi
        .fn()
        .mockReturnValueOnce(of(page(['1', '2'])))
        .mockReturnValue(of(page(['2']))),
      identify: vi.fn().mockReturnValue(of({ jobId: 'j1' })),
      updateScene: vi.fn(),
      jobs: vi
        .fn()
        .mockReturnValueOnce(of([{ id: 'j1', status: 'RUNNING' }]))
        .mockReturnValue(of([])),
    };
    const { fixture, root } = await render(library);
    vi.useFakeTimers();
    try {
      root.querySelector<HTMLButtonElement>('[aria-label="Identify Scene 1"]')!.click();
      vi.advanceTimersByTime(3_000);
      fixture.detectChanges();
      // Still running: the list stays as it is.
      expect(library.fixScenes).toHaveBeenCalledTimes(1);
      expect(titles(root)).toEqual(['Scene 1', 'Scene 2']);

      vi.advanceTimersByTime(3_000);
      fixture.detectChanges();
      expect(library.fixScenes).toHaveBeenLastCalledWith('unmatched', 1);
      expect(titles(root)).toEqual(['Scene 2']);
      expect(tab(root, 'Not matched').querySelector('.count-badge')?.textContent).toBe('1');

      vi.advanceTimersByTime(30_000);
      expect(library.jobs).toHaveBeenCalledTimes(2);
    } finally {
      fixture.destroy();
      vi.useRealTimers();
    }
  });
});
