import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface BuildInfo {
  version: string;
  /** Full commit SHA; null for a local build. */
  commit: string | null;
  builtAt: string | null;
  /** "owner/name" of the GitHub repository the image came from; null for a local build. */
  repository: string | null;
}

export interface RecentError {
  at: string;
  level: 'warn' | 'error';
  /** "app" for errors this web app reported. */
  source: 'server' | 'app';
  context: string | null;
  message: string;
}

export interface AboutResponse {
  build: BuildInfo;
  recentErrors: RecentError[];
}

export interface UpdateCheckResponse {
  status: 'up-to-date' | 'behind' | 'unknown';
  behindBy: number | null;
  reason: string | null;
  checkedAt: string;
}

export interface IntegrationHealth {
  type: string;
  label: string;
  reachable: boolean;
  error: string | null;
  errorAt: string | null;
  lastOkAt: string | null;
}

export interface DiskHealth {
  label: string;
  path: string;
  freeBytes: number | null;
  totalBytes: number | null;
  error: string | null;
}

export type JobHealthStatus = 'ok' | 'running' | 'warn' | 'failed' | 'off' | 'never';

export interface JobHealth {
  id: string;
  label: string;
  status: JobHealthStatus;
  lastRunAt: string | null;
  message: string | null;
}

export interface HealthResponse {
  checkedAt: string;
  database: { ok: boolean; error: string | null };
  integrations: IntegrationHealth[];
  disks: DiskHealth[];
  jobs: JobHealth[];
}

export interface ReleaseNotes {
  version: string;
  date: string | null;
  features: string[];
  fixes: string[];
}

export interface ReleaseNotesResponse {
  /** The running version. */
  current: string;
  /** Releases after the one asked about, up to the running one, newest first. */
  releases: ReleaseNotes[];
}

/** Settings → About & health: which build is running and how it's doing. */
@Injectable({ providedIn: 'root' })
export class AboutApiService {
  private readonly http = inject(HttpClient);

  about(): Observable<AboutResponse> {
    return this.http.get<AboutResponse>('/api/about');
  }

  health(): Observable<HealthResponse> {
    return this.http.get<HealthResponse>('/api/about/health');
  }

  update(): Observable<UpdateCheckResponse> {
    return this.http.get<UpdateCheckResponse>('/api/about/update');
  }

  /** What changed since the version this browser last ran. */
  changes(since: string | null): Observable<ReleaseNotesResponse> {
    return this.http.get<ReleaseNotesResponse>('/api/about/changes', {
      params: since ? { since } : {},
    });
  }
}
