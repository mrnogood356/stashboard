import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type SetupCheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface SetupCheck {
  id: string;
  title: string;
  status: SetupCheckStatus;
  summary: string;
  detail?: string;
  fix?: { label: string; action: string };
  link?: { label: string; route: string };
}

export interface SetupCheckResponse {
  checkedAt: string;
  checks: SetupCheck[];
}

/** How Stash, StashDB, Whisparr and Stashboard are set up together. */
@Injectable({ providedIn: 'root' })
export class SetupCheckApiService {
  private readonly http = inject(HttpClient);

  run(): Observable<SetupCheckResponse> {
    // Stashboard's address as this browser sees it, for Whisparr's webhook.
    return this.http.get<SetupCheckResponse>('/api/setup-check', {
      params: { origin: window.location.origin },
    });
  }

  fix(action: string): Observable<{ ok: true; message: string }> {
    return this.http.post<{ ok: true; message: string }>(
      `/api/setup-check/fix/${encodeURIComponent(action)}`,
      { origin: window.location.origin },
    );
  }
}
