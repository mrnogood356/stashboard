import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LocalLibraryService, type MergeCandidate } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { MergePageComponent } from './merge-page.component';

const item = (id: string, name: string, sceneCount: number): MergeCandidate => ({
  id,
  name,
  aliases: [],
  sceneCount,
  note: null,
  deathDate: null,
});

async function render(groups?: unknown[]) {
  const library = {
    mergeCandidates: vi.fn((_kind: string, q?: string) =>
      of(
        q
          ? { groups: [], matches: [item('7', 'Jo Smith', 4), item('8', 'Joanna Smith', 1)] }
          : {
              groups: groups ?? [
                {
                  keepId: '2',
                  items: [
                    item('2', 'Jane Doe', 9),
                    item('1', 'jane doe', 3),
                    item('5', 'Jane-Doe', 1),
                  ],
                },
              ],
              matches: [],
            },
      ),
    ),
    merge: vi.fn(() => of(undefined)),
  };
  await TestBed.configureTestingModule({
    imports: [MergePageComponent],
    providers: [
      provideRouter([]),
      { provide: LocalLibraryService, useValue: library },
      { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(MergePageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, library };
}

describe('MergePageComponent', () => {
  it('says why each is suggested, and leaves alias-only ones unticked', async () => {
    const { root } = await render([
      {
        keepId: '2',
        items: [
          { ...item('2', 'Jane Doe', 9), match: { reason: 'name', with: 'jane doe' } },
          { ...item('1', 'jane doe', 3), match: { reason: 'name', with: 'Jane Doe' } },
          {
            ...item('5', 'JD', 1),
            aliases: ['Jane Doe'],
            match: { reason: 'alias', with: 'Jane Doe' },
          },
          { ...item('6', 'Janey', 1), match: { reason: 'catalog', with: 'Jane Doe' } },
        ],
      },
    ]);
    const rows = Array.from(root.querySelectorAll('[data-testid="merge-set"] .row'));
    expect(rows.map((row) => row.querySelector('.why')?.textContent?.trim())).toEqual([
      'Same name',
      'Same name',
      'Lists Jane Doe as an alias',
      'Same StashDB entry as Jane Doe',
    ]);
    const ticked = rows
      .slice(1)
      .map((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked);
    expect(ticked).toEqual([true, false, true]);
    expect(root.querySelector('[data-testid="merge-button"]')?.textContent).toContain(
      'Merge 2 into Jane Doe',
    );
  });

  it('merges a suggested set into the one kept, after a second tap, leaving out unticked ones', async () => {
    const { fixture, root, library } = await render();
    const set = root.querySelector('[data-testid="merge-set"]')!;
    const boxes = set.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    boxes[1].click();
    fixture.detectChanges();
    const button = set.querySelector('[data-testid="merge-button"]') as HTMLButtonElement;
    expect(button.textContent).toContain('Merge 1 into Jane Doe');
    button.click();
    fixture.detectChanges();
    expect(library.merge).not.toHaveBeenCalled();
    const sheet = document.querySelector('[data-testid="merge-sheet"]')!;
    expect(sheet.textContent).toContain('Merge into Jane Doe?');
    expect(sheet.textContent).toContain('can’t be undone');
    expect(sheet.querySelectorAll('[data-testid="merge-going"] li')).toHaveLength(1);
    (sheet.querySelector('[data-testid="confirm-merge"]') as HTMLButtonElement).click();
    expect(library.merge).toHaveBeenCalledWith('performers', '2', ['1']);
  });

  it('picks by hand from a search, and switches to studios', async () => {
    vi.useFakeTimers();
    try {
      const { fixture, root, library } = await render();
      const search = root.querySelector('input[type="search"]') as HTMLInputElement;
      search.value = 'smith';
      search.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(400);
      fixture.detectChanges();
      const matches = root.querySelectorAll<HTMLButtonElement>('.match');
      expect(matches.length).toBe(2);
      matches[0].click();
      matches[1].click();
      fixture.detectChanges();
      const manual = root.querySelector('.by-hand [data-testid="merge-set"]')!;
      const button = manual.querySelector('[data-testid="merge-button"]') as HTMLButtonElement;
      button.click();
      fixture.detectChanges();
      (document.querySelector('[data-testid="confirm-merge"]') as HTMLButtonElement).click();
      expect(library.merge).toHaveBeenCalledWith('performers', '7', ['8']);

      (
        Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) =>
          tab.textContent?.includes('Studios'),
        ) as HTMLButtonElement
      ).click();
      expect(library.mergeCandidates).toHaveBeenLastCalledWith('studios');
    } finally {
      vi.useRealTimers();
    }
  });
});
