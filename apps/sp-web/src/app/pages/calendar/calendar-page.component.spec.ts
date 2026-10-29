import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../../core/api/discover.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SceneExplorerItem } from '../../core/api/discover.types';
import { dayKey } from './calendar.model';
import { CalendarPageComponent } from './calendar-page.component';

function scene(id: string, releaseDate: string, extra: Partial<SceneExplorerItem> = {}) {
  return {
    id,
    title: `Scene ${id}`,
    description: null,
    imageUrl: null,
    cardImageUrl: null,
    studioId: 'st',
    studio: 'Velvet Films',
    studioImageUrl: null,
    releaseDate,
    duration: null,
    type: 'SCENE',
    source: 'STASHDB',
    status: { state: 'NOT_REQUESTED' },
    requestable: true,
    ...extra,
  } as SceneExplorerItem;
}

describe('CalendarPageComponent', () => {
  afterEach(() => {
    localStorage.removeItem('stashboard.calendar.whose');
    TestBed.resetTestingModule();
  });

  async function render(getCalendar: ReturnType<typeof vi.fn>) {
    await TestBed.configureTestingModule({
      imports: [CalendarPageComponent],
      providers: [
        provideRouter([]),
        { provide: DiscoverService, useValue: { getCalendar } },
        { provide: AppNotificationsService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(CalendarPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('asks for this month’s releases and lists them by day', async () => {
    const today = new Date();
    const first = dayKey(new Date(today.getFullYear(), today.getMonth(), 1));
    const second = dayKey(new Date(today.getFullYear(), today.getMonth(), 2));
    const getCalendar = vi.fn().mockReturnValue(
      of({
        from: first,
        to: first,
        complete: true,
        items: [
          scene('a', first),
          scene('b', first, { status: { state: 'AVAILABLE' }, requestable: false }),
          scene('c', second),
        ],
      }),
    );
    const { fixture, root } = await render(getCalendar);

    expect(getCalendar).toHaveBeenCalledWith(first, expect.any(String), 'ALL', 'ALL');
    expect(root.textContent).toContain('3 releases');
    expect(root.querySelector(`[data-testid="day-${first}"] .day-scenes`)?.children).toHaveLength(
      2,
    );
    expect(root.querySelectorAll('.agenda-day')).toHaveLength(2);
    expect(root.querySelector(`[data-testid="agenda-${first}"]`)?.textContent).toContain(
      'In library',
    );

    (root.querySelector(`[data-testid="day-${second}"]`) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelectorAll('.agenda-day')).toHaveLength(1);
    expect(root.textContent).toContain('Show the whole month');
  });

  it('switches to studios only, remembers it, and moves between months', async () => {
    const getCalendar = vi
      .fn()
      .mockReturnValue(of({ from: '', to: '', complete: true, items: [] }));
    const { fixture, root } = await render(getCalendar);
    expect(root.textContent).toContain('No releases this month');

    (root.querySelector('[data-testid="whose-STUDIO"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(getCalendar).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      'STUDIO',
      'CATALOG',
    );
    expect(localStorage.getItem('stashboard.calendar.whose')).toBe('STUDIO');

    const before = getCalendar.mock.calls.at(-1)?.[0] as string;
    (root.querySelector('[aria-label="Next month"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(getCalendar.mock.calls.at(-1)?.[0]).not.toBe(before);
  });

  it('shows only Whisparr’s scenes, tagged, and says when Whisparr is off', async () => {
    const first = new Date();
    const day = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-10`;
    const getCalendar = vi.fn((_from: string, _to: string, _whose: string, source: string) =>
      of({
        from: '',
        to: '',
        complete: true,
        whisparr: source === 'CATALOG' ? 'off' : 'ok',
        items:
          source === 'WHISPARR'
            ? [{ ...scene('w1', day, { requestable: false }), inWhisparr: true }]
            : [],
      }),
    );
    const { fixture, root } = await render(getCalendar);

    (root.querySelector('[data-testid="whose-WHISPARR"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(getCalendar).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      'ALL',
      'WHISPARR',
    );
    expect(root.querySelector('[data-testid="in-whisparr"]')?.textContent?.trim()).toBe(
      'In Whisparr',
    );

    getCalendar.mockReturnValue(
      of({ from: '', to: '', complete: true, whisparr: 'off', items: [] }),
    );
    (root.querySelector('[data-testid="whose-ALL"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="whisparr-off"]')?.textContent).toContain(
      'Whisparr isn’t connected',
    );
  });

  it('says when the calendar could not be loaded', async () => {
    const { root } = await render(vi.fn().mockReturnValue(throwError(() => new Error('down'))));
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t load the calendar',
    );
  });
});
