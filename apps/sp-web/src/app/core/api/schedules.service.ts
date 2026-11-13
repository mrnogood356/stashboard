import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type ScheduledJob =
  'organizer-match' | 'send-missing' | 'stash-scan' | 'stash-generate' | 'stash-clean';

export interface ScheduleTime {
  enabled: boolean;
  hour: number;
  minute: number;
  /** 0 is Sunday; empty is every day. */
  days: number[];
}

export interface Schedule extends ScheduleTime {
  job: ScheduledJob;
  label: string;
  detail: string;
  /** Where its on/off lives, when that isn't on the Schedules page. */
  switchIn: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
}

export interface Schedules {
  serverTime: string;
  timeZone: string;
  schedules: Schedule[];
}

@Injectable({ providedIn: 'root' })
export class SchedulesApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<Schedules> {
    return this.http.get<Schedules>('/api/schedules');
  }

  save(job: ScheduledJob, time: ScheduleTime): Observable<Schedules> {
    return this.http.put<Schedules>(`/api/schedules/${job}`, time);
  }
}
