import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

/** A catalog tag, studio or performer, kept with its name for showing. */
export interface HiddenItem {
  id: string;
  name: string;
}

/** What one hidden item is: a catalog tag, studio or performer. */
export type HiddenItemKind = 'tag' | 'studio' | 'performer';

/** Words, tags, studios and performers hidden from every catalog scene list. */
export interface HiddenContentSettings {
  words: string[];
  tags: HiddenItem[];
  studios: HiddenItem[];
  performers: HiddenItem[];
}

const LIST_BY_KIND = {
  tag: 'tags',
  studio: 'studios',
  performer: 'performers',
} as const satisfies Record<HiddenItemKind, keyof HiddenContentSettings>;

@Injectable({ providedIn: 'root' })
export class HiddenContentService {
  private readonly http = inject(HttpClient);
  /** The last list seen from the server, for "Hide this studio" buttons. */
  private readonly current = signal<HiddenContentSettings | null>(null);
  private loading = false;

  readonly settings = this.current.asReadonly();

  getSettings(): Observable<HiddenContentSettings> {
    return this.http
      .get<HiddenContentSettings>('/api/hidden-content/settings')
      .pipe(tap((settings) => this.remember(settings)));
  }

  saveSettings(settings: HiddenContentSettings): Observable<HiddenContentSettings> {
    return this.http
      .put<HiddenContentSettings>('/api/hidden-content/settings', settings)
      .pipe(tap((saved) => this.remember(saved)));
  }

  /** "Hide this studio": adds one item to the list. */
  hide(kind: HiddenItemKind, item: HiddenItem): Observable<HiddenContentSettings> {
    return this.http
      .post<HiddenContentSettings>('/api/hidden-content/hide', { kind, ...item })
      .pipe(tap((saved) => this.remember(saved)));
  }

  /** "Stop hiding": takes one item off the list. */
  unhide(kind: HiddenItemKind, id: string): Observable<HiddenContentSettings> {
    return this.http
      .post<HiddenContentSettings>('/api/hidden-content/unhide', { kind, id })
      .pipe(tap((saved) => this.remember(saved)));
  }

  /** Loads the list once, for buttons that show whether something is hidden. */
  ensureLoaded(): void {
    if (this.current() || this.loading) {
      return;
    }
    this.loading = true;
    this.getSettings().subscribe({
      next: () => (this.loading = false),
      error: () => (this.loading = false),
    });
  }

  isHidden(kind: HiddenItemKind, id: string | null | undefined): boolean {
    const settings = this.current();
    return !!id && !!settings?.[LIST_BY_KIND[kind]]?.some((item) => item.id === id);
  }

  private remember(settings: HiddenContentSettings): void {
    this.current.set({
      words: settings.words ?? [],
      tags: settings.tags ?? [],
      studios: settings.studios ?? [],
      performers: settings.performers ?? [],
    });
  }
}
