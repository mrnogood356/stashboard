import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import type { LocalSceneCard } from './local-library.service';

/**
 * Scenes saved to watch later. Keeps the saved ids, so every Watch later
 * button shows the same thing, read once and then kept up to date.
 */
@Injectable({ providedIn: 'root' })
export class WatchLaterService {
  private readonly http = inject(HttpClient);
  private readonly saved = signal<ReadonlySet<string>>(new Set());
  private loaded = false;

  readonly count = computed(() => this.saved().size);

  has(sceneId: string): boolean {
    return this.saved().has(sceneId);
  }

  /** Reads the saved ids the first time a button needs them. */
  ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.http.get<string[]>('/api/watch-later/ids').subscribe({
      next: (ids) => this.saved.set(new Set(ids)),
      error: () => {
        this.loaded = false;
      },
    });
  }

  list(): Observable<{ items: LocalSceneCard[] }> {
    return this.http
      .get<{ items: LocalSceneCard[] }>('/api/watch-later')
      .pipe(tap(({ items }) => this.saved.set(new Set(items.map((item) => item.id)))));
  }

  add(sceneId: string): Observable<string[]> {
    return this.http
      .post<string[]>(`/api/watch-later/${encodeURIComponent(sceneId)}`, {})
      .pipe(tap((ids) => this.saved.set(new Set(ids))));
  }

  remove(sceneId: string): Observable<string[]> {
    return this.http
      .delete<string[]>(`/api/watch-later/${encodeURIComponent(sceneId)}`)
      .pipe(tap((ids) => this.saved.set(new Set(ids))));
  }

  toggle(sceneId: string): Observable<string[]> {
    return this.has(sceneId) ? this.remove(sceneId) : this.add(sceneId);
  }

  reorder(ids: string[]): Observable<string[]> {
    return this.http
      .put<string[]>('/api/watch-later/order', { ids })
      .pipe(tap((next) => this.saved.set(new Set(next))));
  }

  clear(): Observable<string[]> {
    return this.http
      .delete<string[]>('/api/watch-later')
      .pipe(tap(() => this.saved.set(new Set())));
  }
}
