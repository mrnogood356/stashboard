import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type ActivityStatus = 'done' | 'failed' | 'partial';

export interface ActivityEntry {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string | null;
  status: ActivityStatus;
  count: number | null;
  canUndo: boolean;
  undoneAt: string | null;
}

export interface ActivityPage {
  items: ActivityEntry[];
  page: number;
  hasMore: boolean;
}

/** What Stashboard did: renames, deletes, scans, Whisparr changes… */
@Injectable({ providedIn: 'root' })
export class ActivityApiService {
  private readonly http = inject(HttpClient);

  list(page: number, options: { kind?: string | null; q?: string } = {}): Observable<ActivityPage> {
    let params = new HttpParams().set('page', page);
    if (options.kind) {
      params = params.set('kind', options.kind);
    }
    const q = options.q?.trim();
    if (q) {
      params = params.set('q', q);
    }
    return this.http.get<ActivityPage>('/api/activity', { params });
  }

  undo(id: string): Observable<ActivityEntry> {
    return this.http.post<ActivityEntry>(`/api/activity/${encodeURIComponent(id)}/undo`, {});
  }
}
