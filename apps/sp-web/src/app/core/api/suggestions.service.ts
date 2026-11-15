import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { SceneExplorerItem } from './discover.types';

export interface Suggestion extends SceneExplorerItem {
  /** Why it was picked; key is sent back with Not interested. */
  reason: { key: string; text: string };
}

export interface Suggestions {
  items: Suggestion[];
  /** Why there's nothing to show, when there isn't. */
  message: string | null;
}

/** "You may enjoy": catalog scenes picked from what you watch most. */
@Injectable({ providedIn: 'root' })
export class SuggestionsApiService {
  private readonly http = inject(HttpClient);

  /** `tagIds`: catalog categories; only scenes in at least one of them. */
  list(limit = 24, tagIds: string[] = []): Observable<Suggestions> {
    return this.http.get<Suggestions>('/api/suggestions', { params: params(limit, tagIds) });
  }

  /** A fresh set now: other picks, deeper in, what was just shown moved down. */
  shuffle(limit = 24, tagIds: string[] = []): Observable<Suggestions> {
    return this.http.post<Suggestions>('/api/suggestions/shuffle', null, {
      params: params(limit, tagIds),
    });
  }

  dismiss(suggestion: Suggestion): Observable<void> {
    return this.http.post<void>(`/api/suggestions/${encodeURIComponent(suggestion.id)}/dismiss`, {
      reason: suggestion.reason.key,
    });
  }
}

function params(limit: number, tagIds: string[]): Record<string, string | number> {
  return tagIds.length > 0 ? { limit, tags: tagIds.join(',') } : { limit };
}
