import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type SmallerCopyTarget = '2160p' | '1080p' | '720p';

export interface SmallerCopySettings {
  enabled: boolean;
  target: SmallerCopyTarget;
  replaceHigher: boolean;
  upgradeLower: boolean;
  maxFileSizeGb: number | null;
  minFileSizeGb: number | null;
  maxNewSizeGb: number | null;
  minSavingsPercent: number;
  codec: 'any' | 'prefer-efficient' | 'efficient-only';
  prefer: 'largest' | 'smallest';
  matchStrength: 'strong' | 'partial';
  studioMode: 'all' | 'only' | 'skip';
  studioNames: string[];
  autoGrab: boolean;
  oldCopy: 'delete' | 'keep';
  scenesPerHour: number;
  activeFromHour: number | null;
  activeToHour: number | null;
}

export type SmallerCopyOutcome =
  'grabbed' | 'found' | 'none-found' | 'no-catalog-id' | 'failed' | 'replaced' | 'kept-both';

export interface SmallerCopyAttempt {
  stashSceneId: string;
  title: string;
  outcome: SmallerCopyOutcome | string;
  detail: string | null;
  releaseTitle: string | null;
  canGrab: boolean;
  oldSize: number | null;
  newSize: number | null;
  searchedAt: string;
}

export interface SmallerCopies {
  settings: SmallerCopySettings;
  blocked: string | null;
  candidates: number;
  due: number;
  lastSearchAt: string | null;
  recent: SmallerCopyAttempt[];
}

@Injectable({ providedIn: 'root' })
export class SmallerCopiesApiService {
  private readonly http = inject(HttpClient);

  status(): Observable<SmallerCopies> {
    return this.http.get<SmallerCopies>('/api/smaller-copies');
  }

  save(settings: SmallerCopySettings): Observable<SmallerCopies> {
    return this.http.put<SmallerCopies>('/api/smaller-copies', settings);
  }

  searchNow(): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>('/api/smaller-copies/next', {});
  }

  grab(stashSceneId: string): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>(
      `/api/smaller-copies/scenes/${encodeURIComponent(stashSceneId)}/grab`,
      {},
    );
  }
}
