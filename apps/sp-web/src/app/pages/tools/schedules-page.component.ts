import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  Schedule,
  ScheduleTime,
  Schedules,
  SchedulesApiService,
} from '../../core/api/schedules.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** When the organizer's and Stash's jobs run by themselves. Saved as you change them. */
@Component({
  selector: 'app-schedules-page',
  imports: [RouterLink],
  templateUrl: './schedules-page.component.html',
  styleUrls: ['./tools-shared.scss', './schedules-page.component.scss'],
})
export class SchedulesPageComponent implements OnInit {
  private readonly api = inject(SchedulesApiService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly data = signal<Schedules | null>(null);
  protected readonly error = signal(false);
  protected readonly saving = signal<string | null>(null);
  protected readonly dayNames = DAY_NAMES;

  ngOnInit(): void {
    this.api.list().subscribe({
      next: (data) => this.data.set(data),
      error: () => this.error.set(true),
    });
  }

  protected timeValue(schedule: Schedule): string {
    return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  }

  protected onDay(schedule: Schedule, day: number): boolean {
    return schedule.days.length === 0 || schedule.days.includes(day);
  }

  protected setEnabled(schedule: Schedule, enabled: boolean): void {
    this.save(schedule, { enabled });
  }

  protected setTime(schedule: Schedule, value: string): void {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    if (match) {
      this.save(schedule, { hour: Number(match[1]), minute: Number(match[2]) });
    }
  }

  protected toggleDay(schedule: Schedule, day: number): void {
    const current = schedule.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : schedule.days;
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    if (next.length === 0) {
      this.notifications.error('Pick at least one day', 'Turn it off instead to stop it.');
      return;
    }
    this.save(schedule, { days: next });
  }

  /** In the server's time zone, the one the schedules run on. */
  protected when(iso: string | null): string {
    if (!iso) {
      return '';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return iso;
    }
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    };
    try {
      return date.toLocaleString([], { ...options, timeZone: this.data()?.timeZone });
    } catch {
      // A zone this browser doesn't know: its own.
      return date.toLocaleString([], options);
    }
  }

  private save(schedule: Schedule, change: Partial<ScheduleTime>): void {
    const time: ScheduleTime = {
      enabled: schedule.enabled,
      hour: schedule.hour,
      minute: schedule.minute,
      days: schedule.days,
      ...change,
    };
    this.saving.set(schedule.job);
    this.api.save(schedule.job, time).subscribe({
      next: (data) => {
        this.data.set(data);
        this.saving.set(null);
      },
      error: () => {
        this.saving.set(null);
        this.notifications.error("Couldn't save that", 'Try again in a moment.');
      },
    });
  }
}
