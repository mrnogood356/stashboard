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

  list(limit = 24): Observable<Suggestions> {
    return this.http.get<Suggestions>('/api/suggestions', { params: { limit } });
  }

  dismiss(suggestion: Suggestion): Observable<void> {
    return this.http.post<void>(`/api/suggestions/${encodeURIComponent(suggestion.id)}/dismiss`, {
      reason: suggestion.reason.key,
    });
  }
}
