import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

export type RestoreStatus = 'restored' | 'warning' | 'failed';

export interface RestoreResult {
  id: string;
  label: string;
  status: RestoreStatus;
  message: string | null;
}

export interface RestoreResponse {
  results: RestoreResult[];
}

/** What the page shows about a backup file before it's restored. */
export interface BackupSummary {
  appVersion: string | null;
  exportedAt: string | null;
  includesSecrets: boolean;
}

/** Settings → Account & backup: every setting as one file, and restoring it. */
@Injectable({ providedIn: 'root' })
export class BackupApiService {
  private readonly http = inject(HttpClient);

  /** The backup file, and the name the server gave it. */
  download(includeSecrets: boolean): Observable<{ blob: Blob; fileName: string }> {
    return this.http
      .get('/api/backup', {
        params: { secrets: includeSecrets },
        observe: 'response',
        responseType: 'blob',
      })
      .pipe(
        map((response) => ({
          blob: response.body ?? new Blob([]),
          fileName:
            /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
            'stashboard-settings.json',
        })),
      );
  }

  restore(file: unknown): Observable<RestoreResponse> {
    return this.http.post<RestoreResponse>('/api/backup/restore', file);
  }
}

/** The file's own description of itself, or null when it isn't a backup. */
export function summarizeBackup(file: unknown): BackupSummary | null {
  if (typeof file !== 'object' || file === null) {
    return null;
  }
  const backup = file as Record<string, unknown>;
  if (backup['format'] !== 'stashboard-settings') {
    return null;
  }
  return {
    appVersion: typeof backup['appVersion'] === 'string' ? backup['appVersion'] : null,
    exportedAt: typeof backup['exportedAt'] === 'string' ? backup['exportedAt'] : null,
    includesSecrets: backup['includesSecrets'] === true,
  };
}
