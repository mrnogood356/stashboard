import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export interface AutomationSettings {
  scanOnImport: boolean;
  identifyNew: boolean;
  generateNew: boolean;
  removeSamples: boolean;
  watchFolders: boolean;
  /** After a Whisparr import: rescan, remove extra copies and link waiting scenes. */
  tidyAfterImport: boolean;
  /** Whether Stashboard can see Stash's library folders to watch them; null before it has looked. */
  foldersVisible: boolean | null;
  /** Path of Whisparr's webhook, e.g. /api/hooks/whisparr/<token>. */
  webhookPath: string;
  running: boolean;
  lastRun: {
    at: string | null;
    status: string | null;
    message: string | null;
    reason: string | null;
  };
}

@Injectable({ providedIn: 'root' })
export class AutomationApiService {
  private readonly http = inject(HttpClient);

  get(): Observable<AutomationSettings> {
    return this.http.get<AutomationSettings>('/api/automation');
  }

  update(
    update: Partial<
      Pick<
        AutomationSettings,
        | 'scanOnImport'
        | 'identifyNew'
        | 'generateNew'
        | 'removeSamples'
        | 'watchFolders'
        | 'tidyAfterImport'
      >
    >,
  ): Observable<AutomationSettings> {
    return this.http.put<AutomationSettings>('/api/automation', update);
  }

  regenerateToken(): Observable<AutomationSettings> {
    return this.http.post<AutomationSettings>('/api/automation/token', {});
  }

  runNow(): Observable<AutomationSettings> {
    return this.http.post<AutomationSettings>('/api/automation/run', {});
  }
}
