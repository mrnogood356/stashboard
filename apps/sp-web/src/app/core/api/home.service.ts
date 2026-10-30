import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  HomeAttention,
  HomeRailContentResponse,
  HomeRailConfig,
  HomeRowDisplay,
  HomeRowGalleryId,
  HomeRowGalleryItem,
  SaveHomeRailPayload,
  UpdateHomeRailsPayload,
} from './home.types';
import { PerformerStudioOption, SceneTagOption } from './discover.types';

@Injectable({
  providedIn: 'root',
})
export class HomeService {
  private readonly http = inject(HttpClient);

  getRails(): Observable<HomeRailConfig[]> {
    return this.http.get<HomeRailConfig[]>('/api/home/rails');
  }

  getAttention(): Observable<HomeAttention> {
    return this.http.get<HomeAttention>('/api/home/attention');
  }

  getRailItems(id: string): Observable<HomeRailContentResponse> {
    return this.http.get<HomeRailContentResponse>(
      `/api/home/rails/${encodeURIComponent(id)}/items`,
    );
  }

  searchStashTags(query: string): Observable<SceneTagOption[]> {
    const params = new HttpParams().set('query', query);
    return this.http.get<SceneTagOption[]>('/api/home/stash/tags', { params });
  }

  searchStashStudios(query: string): Observable<PerformerStudioOption[]> {
    const params = new HttpParams().set('query', query);
    return this.http.get<PerformerStudioOption[]>('/api/home/stash/studios', {
      params,
    });
  }

  updateRails(payload: UpdateHomeRailsPayload): Observable<HomeRailConfig[]> {
    return this.http.put<HomeRailConfig[]>('/api/home/rails', payload);
  }

  createRail(payload: SaveHomeRailPayload): Observable<HomeRailConfig> {
    return this.http.post<HomeRailConfig>('/api/home/rails', payload);
  }

  updateRail(id: string, payload: SaveHomeRailPayload): Observable<HomeRailConfig> {
    return this.http.patch<HomeRailConfig>(`/api/home/rails/${encodeURIComponent(id)}`, payload);
  }

  /** Changes how one row looks; fields left out keep their value. */
  updateRowDisplay(id: string, change: Partial<HomeRowDisplay>): Observable<HomeRailConfig> {
    return this.http.patch<HomeRailConfig>(
      `/api/home/rails/${encodeURIComponent(id)}/display`,
      change,
    );
  }

  getRowGallery(): Observable<HomeRowGalleryItem[]> {
    return this.http.get<HomeRowGalleryItem[]>('/api/home/rails/gallery');
  }

  addGalleryRow(id: HomeRowGalleryId): Observable<HomeRailConfig> {
    return this.http.post<HomeRailConfig>(`/api/home/rails/gallery/${encodeURIComponent(id)}`, {});
  }

  deleteRail(id: string): Observable<void> {
    return this.http.delete<void>(`/api/home/rails/${encodeURIComponent(id)}`);
  }
}
