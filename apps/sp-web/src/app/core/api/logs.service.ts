import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export interface LogEntry {
  id: number;
  at: string;
  level: LogLevel;
  fatal?: boolean;
  /** "app" for errors this web app reported. */
  source: 'server' | 'app';
  context: string | null;
  message: string;
  stack: string | null;
}

export interface LogQuery {
  /** Minimum level. */
  level?: LogLevel;
  context?: string;
  q?: string;
  before?: number;
  limit?: number;
}

export interface LogsResponse {
  /** Newest first. */
  entries: LogEntry[];
  hasMore: boolean;
  /** The level Stashboard is logging at now. */
  level: LogLevel;
  capacity: number;
}

export interface LogFile {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface LogFilesResponse {
  enabled: boolean;
  directory: string | null;
  files: LogFile[];
}

export interface LogSettings {
  level: LogLevel;
  fileEnabled: boolean;
  /** False until saved here; LOG_LEVEL applies until then. */
  saved: boolean;
  envLevel: LogLevel;
  fileDirectory: string | null;
  fileError: string | null;
}

/** Settings → Logs. */
@Injectable({ providedIn: 'root' })
export class LogsApiService {
  private readonly http = inject(HttpClient);

  list(query: LogQuery = {}): Observable<LogsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    }
    return this.http.get<LogsResponse>('/api/logs', { params });
  }

  contexts(): Observable<string[]> {
    return this.http.get<string[]>('/api/logs/contexts');
  }

  clear(): Observable<void> {
    return this.http.delete<void>('/api/logs');
  }

  files(): Observable<LogFilesResponse> {
    return this.http.get<LogFilesResponse>('/api/logs/files');
  }

  /** Download link; the session cookie signs it in. */
  fileUrl(name: string): string {
    return `/api/logs/files/${encodeURIComponent(name)}`;
  }

  settings(): Observable<LogSettings> {
    return this.http.get<LogSettings>('/api/logs/settings');
  }

  saveSettings(settings: { level: LogLevel; fileEnabled: boolean }): Observable<LogSettings> {
    return this.http.put<LogSettings>('/api/logs/settings', settings);
  }
}
