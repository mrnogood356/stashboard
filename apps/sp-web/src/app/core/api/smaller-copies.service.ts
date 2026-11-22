import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type SmallerCopyTarget = '2160p' | '1080p' | '720p';

export interface SmallerCopySettings {
  enabled: boolean;
  target: SmallerCopyTarget;
  replaceHigher: boolean;
  upgradeLower: boolean;
  /** Sizes are GB per hour of video. At the target but heavier: replace. */
  maxGbPerHour: number | null;
  /** Leave files lighter than this alone. */
  minGbPerHour: number | null;
  /** The new copy's cap. */
  maxNewGbPerHour: number | null;
  /** The new copy's floor: lighter is too squeezed to swap in. */
  minNewGbPerHour: number | null;
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
  | 'grabbed'
  | 'found'
  | 'none-found'
  | 'no-catalog-id'
  | 'failed'
  | 'replaced'
  | 'kept-both'
  | 'removed';

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
  /** After Search now: why nothing was searched, if nothing was. */
  notice?: string | null;
  candidates: number;
  due: number;
  lastSearchAt: string | null;
  /** Space given back so far (less than nothing after upgrades), and scenes replaced. */
  saved: { bytes: number; scenes: number };
  recent: SmallerCopyAttempt[];
  /** Releases grabbed so far, newest first, and how each ended. */
  tries: SmallerCopyTry[];
  /** How many tries ended each way, over all of them. */
  tryCounts: Record<string, number>;
  /** Scenes on the Failed list (latest try failed) or whose last search failed. */
  failed?: number;
}

/** A release grabbed for a scene: grabbed (on its way), replaced, kept-both, removed or failed. */
export interface SmallerCopyTry {
  id: string;
  stashSceneId: string;
  title: string;
  releaseTitle: string | null;
  outcome: string;
  detail: string | null;
  oldSize: number | null;
  newSize: number | null;
  at: string;
  /** Kept both: the Stash scene the download landed on, apart from the old one. */
  newSceneId?: string | null;
  /** Whether "Remove it" is offered: the new scene holds just the one file. */
  canRemoveNew?: boolean;
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

  /** Look at a scene again on the next search. */
  /** `onlyIfFailed`: from a failed try, refused if a later try ended another way. */
  recheck(stashSceneId: string, onlyIfFailed = false): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>(
      `/api/smaller-copies/scenes/${encodeURIComponent(stashSceneId)}/recheck`,
      {},
      onlyIfFailed ? { params: { ifFailed: 'true' } } : {},
    );
  }

  /** Look at every scene again, a few an hour as usual. */
  recheckAll(): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>('/api/smaller-copies/recheck', {});
  }

  /** Look again at only the scenes whose last try failed. */
  recheckFailed(): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>('/api/smaller-copies/recheck/failed', {});
  }

  /** Kept both: delete the new copy's scene and file; the old file stays. */
  removeNewCopy(tryId: string): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>(
      `/api/smaller-copies/tries/${encodeURIComponent(tryId)}/remove-new`,
      {},
    );
  }

  grab(stashSceneId: string): Observable<SmallerCopies> {
    return this.http.post<SmallerCopies>(
      `/api/smaller-copies/scenes/${encodeURIComponent(stashSceneId)}/grab`,
      {},
    );
  }
}
