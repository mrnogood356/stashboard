import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  LibrarySceneSort,
  LibraryScenesFeedResponse,
  LibrarySortDirection,
  LibraryStudioOption,
  LibraryTagMatchMode,
  LibraryTagOption,
} from './library.types';

@Injectable({
  providedIn: 'root',
})
export class LibraryService {
  private readonly http = inject(HttpClient);

  getScenesFeed(
    page: number,
    perPage: number,
    filters?: {
      query?: string;
      sort?: LibrarySceneSort;
      direction?: LibrarySortDirection;
      tagIds?: string[];
      tagMode?: LibraryTagMatchMode;
      studioIds?: string[];
      favoritePerformersOnly?: boolean;
      favoriteStudiosOnly?: boolean;
      favoriteTagsOnly?: boolean;
    },
  ): Observable<LibraryScenesFeedResponse> {
    let params = new HttpParams().set('page', page.toString()).set('perPage', perPage.toString());

    if (filters?.query) {
      params = params.set('query', filters.query);
    }
    if (filters?.sort) {
      params = params.set('sort', filters.sort);
    }
    if (filters?.direction) {
      params = params.set('direction', filters.direction);
    }
    if (filters?.tagIds && filters.tagIds.length > 0) {
      params = params.set('tagIds', filters.tagIds.join(','));
    }
    if (filters?.tagMode) {
      params = params.set('tagMode', filters.tagMode);
    }
    if (filters?.studioIds && filters.studioIds.length > 0) {
      params = params.set('studioIds', filters.studioIds.join(','));
    }
    if (filters?.favoritePerformersOnly) {
      params = params.set('favoritePerformersOnly', 'true');
    }
    if (filters?.favoriteStudiosOnly) {
      params = params.set('favoriteStudiosOnly', 'true');
    }
    if (filters?.favoriteTagsOnly) {
      params = params.set('favoriteTagsOnly', 'true');
    }

    return this.http.get<LibraryScenesFeedResponse>('/api/library/scenes', { params });
  }

  /**
   * Your categories, the most used first with counts: matching what's typed,
   * or with nothing typed the most common. A performer or studio narrows it
   * to their scenes.
   */
  searchTags(query: string, scope: LibraryOptionScope = {}): Observable<LibraryTagOption[]> {
    return this.http.get<LibraryTagOption[]>('/api/library/tags', {
      params: optionParams(query, scope),
    });
  }

  searchStudios(query: string, scope: LibraryOptionScope = {}): Observable<LibraryStudioOption[]> {
    return this.http.get<LibraryStudioOption[]>('/api/library/studios', {
      params: optionParams(query, scope),
    });
  }

  /** Everyone in your own scenes, most scenes first. */
  listPerformers(query: string, page = 1, perPage = 48): Observable<LibraryPerformers> {
    let params = new HttpParams().set('page', page).set('perPage', perPage);
    if (query.trim()) {
      params = params.set('query', query.trim());
    }
    return this.http.get<LibraryPerformers>('/api/library/performers', { params });
  }
}

/** A performer in your own scenes, by their Stash id. */
export interface LibraryPerformer {
  id: string;
  name: string;
  /** Scenes of yours they're in. */
  count: number;
  imageUrl: string;
}

export interface LibraryPerformers {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  items: LibraryPerformer[];
}

/** Options from one performer's or studio's scenes only. */
export interface LibraryOptionScope {
  performerId?: string;
  studioId?: string;
}

function optionParams(query: string, scope: LibraryOptionScope): HttpParams {
  let params = new HttpParams().set('query', query);
  if (scope.performerId) {
    params = params.set('performerId', scope.performerId);
  }
  if (scope.studioId) {
    params = params.set('studioId', scope.studioId);
  }
  return params;
}
