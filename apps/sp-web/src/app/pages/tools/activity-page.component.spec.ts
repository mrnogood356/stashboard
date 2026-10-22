import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityApiService, ActivityEntry } from '../../core/api/activity.service';
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
