import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Observable,
  Subject,
  Subscription,
  catchError,
  debounceTime,
  distinctUntilChanged,
  map,
  of,
  switchMap,
} from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import { HiddenContentService, HiddenItem } from '../../core/api/hidden-content.service';

type PickerKind = 'tags' | 'studios' | 'performers';

const SEARCH_DEBOUNCE_MS = 300;
const MAX_RESULTS = 8;

/**
 * Settings → Hidden: words, catalog tags, studios and performers to leave
 * out of every catalog scene list. Library pages are never filtered.
 */
@Component({
  selector: 'app-settings-hidden-page',
  imports: [FormsModule],
  templateUrl: './settings-hidden-page.component.html',
  styleUrls: ['./settings-hidden-page.component.scss', './settings-shared.scss'],
})
export class SettingsHiddenPageComponent implements OnInit, OnDestroy {
  private readonly hiddenContent = inject(HiddenContentService);
  private readonly discover = inject(DiscoverService);
  private readonly searches = new Subject<{ kind: PickerKind; text: string }>();
  private searchSubscription: Subscription | null = null;

  protected readonly pickers: Array<{ kind: PickerKind; label: string; placeholder: string }> = [
    { kind: 'tags', label: 'Tags', placeholder: 'Find a tag to hide' },
    { kind: 'studios', label: 'Studios', placeholder: 'Find a studio to hide' },
    { kind: 'performers', label: 'Performers', placeholder: 'Find a performer to hide' },
  ];
  protected readonly loading = signal(true);
  /** The saved list couldn't be read; saving now would wipe it, so the form waits. */
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly status = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);
  /** The words box as typed: "trans, transgender". */
  protected readonly wordsText = signal('');
  protected readonly tags = signal<HiddenItem[]>([]);
  protected readonly studios = signal<HiddenItem[]>([]);
  protected readonly performers = signal<HiddenItem[]>([]);
  protected readonly queries = signal<Record<PickerKind, string>>({
    tags: '',
    studios: '',
    performers: '',
  });
  protected readonly results = signal<Record<PickerKind, HiddenItem[]>>({
    tags: [],
    studios: [],
    performers: [],
  });
  protected readonly searching = signal<PickerKind | null>(null);
  protected readonly hideOwned = signal(false);

  ngOnInit(): void {
    this.searchSubscription = this.searches
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged((left, right) => left.kind === right.kind && left.text === right.text),
        switchMap(({ kind, text }) => {
          if (!text) {
            return of({ kind, items: [] as HiddenItem[] });
          }
          this.searching.set(kind);
          return this.searchCatalog(kind, text).pipe(
            map((items) => ({ kind, items })),
            catchError(() => of({ kind, items: [] as HiddenItem[] })),
          );
        }),
      )
      .subscribe(({ kind, items }) => {
        this.searching.set(null);
        this.results.update((current) => ({ ...current, [kind]: items.slice(0, MAX_RESULTS) }));
      });

    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadFailed.set(false);
    this.status.set(null);
    this.hiddenContent.getSettings().subscribe({
      next: (settings) => {
        this.wordsText.set(settings.words.join(', '));
        this.tags.set(settings.tags);
        this.studios.set(settings.studios);
        this.performers.set(settings.performers ?? []);
        this.hideOwned.set(settings.hideOwned === true);
        this.loading.set(false);
      },
      error: () => {
        this.loadFailed.set(true);
        this.loading.set(false);
      },
    });
  }

  ngOnDestroy(): void {
    this.searchSubscription?.unsubscribe();
  }

  protected chosen(kind: PickerKind): HiddenItem[] {
    return this.list(kind)();
  }

  protected onHideOwnedChanged(value: boolean): void {
    this.hideOwned.set(value);
    this.status.set(null);
  }

  protected onWordsChanged(value: string): void {
    this.wordsText.set(value);
    this.status.set(null);
  }

  protected onQueryChanged(kind: PickerKind, value: string): void {
    const text = value.trim();
    this.queries.update((current) => ({ ...current, [kind]: value }));
    if (!text) {
      this.results.update((current) => ({ ...current, [kind]: [] }));
    }
    this.searches.next({ kind, text });
  }

  /** Search results not already on the list. */
  protected suggestions(kind: PickerKind): HiddenItem[] {
    const taken = new Set(this.chosen(kind).map((item) => item.id));
    return this.results()[kind].filter((item) => !taken.has(item.id));
  }

  protected add(kind: PickerKind, item: HiddenItem): void {
    this.list(kind).update((current) =>
      current.some((entry) => entry.id === item.id) ? current : [...current, item],
    );
    this.queries.update((current) => ({ ...current, [kind]: '' }));
    this.results.update((current) => ({ ...current, [kind]: [] }));
    this.searches.next({ kind, text: '' });
    this.status.set(null);
  }

  protected remove(kind: PickerKind, id: string): void {
    this.list(kind).update((current) => current.filter((entry) => entry.id !== id));
    this.status.set(null);
  }

  protected save(): void {
    if (this.saving() || this.loadFailed()) {
      return;
    }
    this.saving.set(true);
    this.status.set(null);
    this.hiddenContent
      .saveSettings({
        words: splitWords(this.wordsText()),
        tags: this.tags(),
        studios: this.studios(),
        performers: this.performers(),
        hideOwned: this.hideOwned(),
      })
      .subscribe({
        next: (saved) => {
          this.wordsText.set(saved.words.join(', '));
          this.tags.set(saved.tags);
          this.studios.set(saved.studios);
          this.performers.set(saved.performers ?? []);
          this.hideOwned.set(saved.hideOwned === true);
          this.saving.set(false);
          this.status.set({ kind: 'ok', text: 'Saved. Lists use it from now on.' });
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.status.set({ kind: 'error', text: saveErrorMessage(error) });
        },
      });
  }

  private list(kind: PickerKind) {
    return kind === 'tags' ? this.tags : kind === 'studios' ? this.studios : this.performers;
  }

  private searchCatalog(kind: PickerKind, text: string): Observable<HiddenItem[]> {
    if (kind === 'tags') {
      return this.discover
        .searchSceneTags(text)
        .pipe(map((tags) => tags.map((tag) => ({ id: tag.id, name: tag.name }))));
    }
    if (kind === 'performers') {
      return this.discover
        .getPerformersFeed(1, MAX_RESULTS, { name: text })
        .pipe(
          map((response) =>
            response.items.map((performer) => ({ id: performer.id, name: performer.name })),
          ),
        );
    }
    // A studio's own sub-studios come too; each can be hidden on its own.
    return this.discover
      .searchPerformerStudios(text)
      .pipe(
        map((studios) =>
          studios.flatMap((studio) => [
            { id: studio.id, name: studio.name },
            ...studio.childStudios.map((child) => ({ id: child.id, name: child.name })),
          ]),
        ),
      );
  }
}

/** The server's reason (Nest sends one or a list), or a plain retry hint. */
function saveErrorMessage(error: unknown): string {
  const message: unknown =
    error instanceof HttpErrorResponse ? (error.error as { message?: unknown })?.message : null;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }
  if (Array.isArray(message) && message.length > 0) {
    return message.map(String).join('. ');
  }
  return 'Couldn’t save your hidden list. Try again.';
}

/** "trans, transgender pov" -> ['trans', 'transgender', 'pov']; the server tidies the rest. */
function splitWords(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}
