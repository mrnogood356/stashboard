import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityApiService,
  ActivityEntry,
  ActivityFilesPage,
} from '../../core/api/activity.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { ActivityPageComponent } from './activity-page.component';

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: '1',
    at: new Date().toISOString(),
    kind: 'rename',
    title: 'Renamed 3 files',
    detail: 'a.mp4 → b.mp4',
    status: 'done',
    count: 3,
    canUndo: true,
    undoneAt: null,
    ...overrides,
  };
}

describe('ActivityPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Record<string, unknown>) {
    await TestBed.configureTestingModule({
      imports: [ActivityPageComponent],
      providers: [
        provideRouter([]),
        { provide: ActivityApiService, useValue: api },
        {
          provide: AppNotificationsService,
          useValue: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ActivityPageComponent);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('lists today’s activity and undoes a rename after a second tap', async () => {
    const api = {
      list: vi.fn().mockReturnValue(
        of({
          items: [entry(), entry({ id: '2', kind: 'scan', canUndo: false, title: 'Scanned' })],
          page: 1,
          hasMore: false,
        }),
      ),
      undo: vi.fn().mockReturnValue(of(entry({ undoneAt: new Date().toISOString() }))),
    };
    const { fixture, root } = await render(api);

    expect(root.querySelector('.day-label')?.textContent).toBe('Today');
    expect(root.querySelectorAll('.entry')).toHaveLength(2);
    const undo = () => Array.from(root.querySelectorAll<HTMLButtonElement>('.entry .btn'))[0];
    expect(root.querySelectorAll('.entry .btn')).toHaveLength(1);

    undo().click();
    fixture.detectChanges();
    expect(api.undo).not.toHaveBeenCalled();
    expect(undo().textContent?.trim()).toBe('Tap again');
    undo().click();
    fixture.detectChanges();

    expect(api.undo).toHaveBeenCalledWith('1');
    expect(root.querySelector('.entry.undone')).not.toBeNull();
  });

  it('shows the files a run moved, from where to where', async () => {
    const files = vi.fn().mockReturnValue(
      of({
        page: 1,
        hasMore: false,
        items: [
          { sceneId: '7', from: '/in/a.mp4', to: '/lib/Vixen/A.mp4', undone: false },
          { sceneId: '8', from: '/in/b.mp4', to: '/lib/Vixen/B.mp4', undone: true },
        ],
      }),
    );
    const { fixture, root } = await render({
      list: () => of({ items: [entry({ hasFiles: true })], page: 1, hasMore: false }),
      files,
    });

    root.querySelector<HTMLButtonElement>('[data-testid="show-files"]')!.click();
    fixture.detectChanges();

    expect(files).toHaveBeenCalledWith('1', 1);
    const moves = Array.from(root.querySelectorAll('.moves li'));
    expect(moves.map((li) => li.querySelector('.from')?.textContent?.trim())).toEqual([
      '/in/a.mp4',
      '/in/b.mp4',
    ]);
    expect(moves[0].querySelector('.to')?.textContent?.trim()).toBe('→ /lib/Vixen/A.mp4');
    expect(moves[1].classList.contains('undone')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-testid="show-files"]')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.moves')).toBeNull();
  });

  it('keeps a list closed while loading closed, and shows more on request', async () => {
    const answer = new Subject<ActivityFilesPage>();
    const files = vi
      .fn()
      .mockReturnValueOnce(answer)
      .mockReturnValueOnce(
        of({
          page: 1,
          hasMore: true,
          items: [{ sceneId: '1', from: '/a', to: '/b', undone: false }],
        }),
      )
      .mockReturnValueOnce(
        of({
          page: 2,
          hasMore: false,
          items: [{ sceneId: '2', from: '/c', to: '/d', undone: false }],
        }),
      );
    const { fixture, root } = await render({
      list: () => of({ items: [entry({ hasFiles: true })], page: 1, hasMore: false }),
      files,
    });
    const toggle = () =>
      root.querySelector<HTMLButtonElement>('[data-testid="show-files"]')!.click();

    toggle();
    toggle();
    answer.next({
      page: 1,
      hasMore: false,
      items: [{ sceneId: '9', from: '/x', to: '/y', undone: false }],
    });
    fixture.detectChanges();
    expect(root.querySelector('.moves')).toBeNull();

    toggle();
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[data-testid="more-files"]')!.click();
    fixture.detectChanges();
    expect(files).toHaveBeenLastCalledWith('1', 2);
    expect(root.querySelectorAll('.moves li').length).toBe(2);
  });

  it('filters by kind', async () => {
    const api = {
      list: vi.fn().mockReturnValue(of({ items: [], page: 1, hasMore: false })),
      undo: vi.fn(),
    };
    const { fixture, root } = await render(api);

    Array.from(root.querySelectorAll<HTMLButtonElement>('.chip'))
      .find((chip) => chip.textContent?.trim() === 'Deletes')!
      .click();
    fixture.detectChanges();

    expect(api.list).toHaveBeenLastCalledWith(1, { kind: 'delete', q: '' });
    expect(root.textContent).toContain('Nothing matches.');
  });
});
