import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { SceneExplorerItem } from './discover.types';

export type FollowKind = 'PERFORMER' | 'STUDIO';
export type FollowedSceneState = 'NEW' | 'REQUESTED' | 'DISMISSED' | 'FAILED';

export interface FollowTag {
  id: string;
  name: string;
}

export interface Follow {
  id: string;
  kind: FollowKind;
  provider: string;
  entityId: string;
  name: string;
  imageUrl: string | null;
  /** Only scenes released on or after this day (YYYY-MM-DD). */
  since: string;
  autoRequest: boolean;
  /** Only scenes with at least one of these tags; empty is every scene. */
  tags: FollowTag[];
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Its scenes waiting for review. */
  newCount: number;
  createdAt: string;
}

export interface FollowList {
  follows: Follow[];
  checking: boolean;
  provider: string | null;
}

export interface FollowLookup {
  follow: Follow | null;
  /** False on a secondary catalog's page: only the main one can be followed. */
  followable: boolean;
}

export interface FollowedRelease extends SceneExplorerItem {
  followed: {
    state: FollowedSceneState;
    detail: string | null;
    foundAt: string;
    follows: Array<{ id: string; kind: FollowKind; entityId: string; name: string }>;
  };
}

export interface FollowedReleases {
  items: FollowedRelease[];
  reviewCount: number;
}

export interface NewFollow {
  kind: FollowKind;
  entityId: string;
  name: string;
  imageUrl?: string | null;
  since?: string;
  autoRequest?: boolean;
  tags?: FollowTag[];
}

export interface FollowChanges {
  since?: string;
  autoRequest?: boolean;
  tags?: FollowTag[];
}

/** Following performers and studios, and the new scenes found for them. */
@Injectable({ providedIn: 'root' })
export class FollowsApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<FollowList> {
    return this.http.get<FollowList>('/api/follows');
  }

  lookup(kind: FollowKind, entityId: string): Observable<FollowLookup> {
    return this.http.get<FollowLookup>('/api/follows/lookup', { params: { kind, entityId } });
  }

  follow(input: NewFollow): Observable<Follow> {
    return this.http.post<Follow>('/api/follows', input);
  }

  /** Tags to narrow a follow to, from the main catalog. */
  searchTags(query: string): Observable<FollowTag[]> {
    return this.http.get<FollowTag[]>('/api/follows/tags', { params: { query } });
  }

  update(id: string, changes: FollowChanges): Observable<Follow> {
    return this.http.patch<Follow>(`/api/follows/${encodeURIComponent(id)}`, changes);
  }

  unfollow(id: string): Observable<void> {
    return this.http.delete<void>(`/api/follows/${encodeURIComponent(id)}`);
  }

  releases(view: 'review' | 'all', limit = 60): Observable<FollowedReleases> {
    return this.http.get<FollowedReleases>('/api/follows/releases', {
      params: { view, limit },
    });
  }

  dismiss(sceneId: string): Observable<void> {
    return this.http.post<void>(`/api/follows/releases/${encodeURIComponent(sceneId)}/dismiss`, {});
  }

  checkNow(): Observable<{ started: boolean }> {
    return this.http.post<{ started: boolean }>('/api/follows/check', {});
  }
}

/** Where a follow starts from, as the choices the follow sheet offers. */
export const SINCE_OPTIONS = [
  { days: 0, label: 'New scenes only' },
  { days: 30, label: 'Last 30 days too' },
  { days: 90, label: 'Last 90 days too' },
  { days: 365, label: 'Last year too' },
] as const;

/** YYYY-MM-DD, `days` before `now` (UTC, like the catalog's dates). */
export function sinceDaysAgo(days: number, now = new Date()): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The closest choice for a saved day, so the sheet shows what it was set to. */
export function sinceOptionFor(since: string, createdAt: string): number {
  const back = Math.round((Date.parse(createdAt) - Date.parse(since)) / 86_400_000);
  let best: number = SINCE_OPTIONS[0].days;
  for (const option of SINCE_OPTIONS) {
    if (back >= option.days - 1) {
      best = option.days;
    }
  }
  return best;
}
