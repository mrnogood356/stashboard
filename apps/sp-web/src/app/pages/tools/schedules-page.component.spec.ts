import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { Schedule, Schedules, SchedulesApiService } from '../../core/api/schedules.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SchedulesPageComponent } from './schedules-page.component';

const schedule = (over: Partial<Schedule>): Schedule => ({
  job: 'stash-scan',
  label: 'Scan the library in Stash',
  detail: 'Stash looks for new files.',
  switchIn: null,
  enabled: false,
  hour: 3,
  minute: 0,
  days: [],
  lastRunAt: null,
  lastStatus: null,
  nextRunAt: null,
  ...over,
});

const DATA: Schedules = {
  serverTime: '2026-11-08T12:00:00.000Z',
  timeZone: 'Europe/London',
  schedules: [
    schedule({
      job: 'organizer-match',
      label: 'Match the backlog',
      switchIn: 'Organizer → Settings → Every night',
      hour: 4,
      nextRunAt: '2026-11-09T04:00:00.000Z',
    }),
    schedule({}),
  ],
};

async function render(save = vi.fn().mockReturnValue(of(DATA))) {
  const notifications = { success: vi.fn(), error: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [SchedulesPageComponent],
    providers: [
      provideRouter([]),
      { provide: SchedulesApiService, useValue: { list: () => of(DATA), save } },
      { provide: AppNotificationsService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(SchedulesPageComponent);
  fixture.detectChanges();
  return { fixture, root: fixture.nativeElement as HTMLElement, save, notifications };
}

describe('SchedulesPageComponent', () => {
  it('shows each job with its time and days, and where the organizer’s on/off lives', async () => {
    const { root } = await render();
    const match = root.querySelector('[data-testid="schedule-organizer-match"]')!;
    expect(match.textContent).toContain('On or off in Organizer → Settings → Every night');
    expect(match.querySelector('input[type="checkbox"]')).toBeNull();
    expect((match.querySelector('input[type="time"]') as HTMLInputElement).value).toBe('04:00');
    expect(root.textContent).toContain('Europe/London');
  });

  it('saves a change straight away: on, the time, a day off', async () => {
    const { root, save, notifications } = await render();
    const scan = root.querySelector('[data-testid="schedule-stash-scan"]')!;

    (scan.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    expect(save).toHaveBeenLastCalledWith('stash-scan', {
      enabled: true,
      hour: 3,
      minute: 0,
      days: [],
    });

    const time = scan.querySelector('input[type="time"]') as HTMLInputElement;
    time.value = '01:45';
    time.dispatchEvent(new Event('change'));
    expect(save).toHaveBeenLastCalledWith(
      'stash-scan',
      expect.objectContaining({ hour: 1, minute: 45 }),
    );

    // Every day is on; turning Sunday off leaves Monday to Saturday.
    (scan.querySelectorAll('.day')[0] as HTMLButtonElement).click();
    expect(save).toHaveBeenLastCalledWith(
      'stash-scan',
      expect.objectContaining({ days: [1, 2, 3, 4, 5, 6] }),
    );
    expect(notifications.error).not.toHaveBeenCalled();
  });
});
