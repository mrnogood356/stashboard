import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AcquisitionFeedOptions,
  AcquisitionLifecycleFilter,
  AcquisitionScenesResponse,
} from './acquisition.types';

@Injectable({
  providedIn: 'root',
})
export class AcquisitionService {
  private readonly http = inject(HttpClient);

  getScenesFeed(
    page: number,
    perPage: number,
    lifecycle: AcquisitionLifecycleFilter = 'ANY',
    options: AcquisitionFeedOptions = {},
  ): Observable<AcquisitionScenesResponse> {
    let params = new HttpParams().set('page', page.toString()).set('perPage', perPage.toString());

    if (lifecycle !== 'ANY') {
      params = params.set('lifecycle', lifecycle);
    }

    const query = options.q?.trim() ?? '';
    if (query) {
      params = params.set('q', query);
    }
    if (options.sort && options.sort !== 'status') {
      params = params.set('sort', options.sort);
    }

    return this.http.get<AcquisitionScenesResponse>('/api/acquisition/scenes', {
      params,
    });
  }

  /** search: Whisparr looks for them again; remove: out of Whisparr (files stay). */
  bulk(
    action: 'search' | 'remove',
    ids: string[],
  ): Observable<{
    action: string;
    done: number;
    failed: Array<{ id: string; title: string | null; reason: string }>;
  }> {
    return this.http.post<{
      action: string;
      done: number;
      failed: Array<{ id: string; title: string | null; reason: string }>;
    }>('/api/acquisition/bulk', { action, ids });
  }
}
