import { Component, EventEmitter, Input, OnDestroy, Output, inject, signal } from '@angular/core';
import { Subject, Subscription, debounceTime, of, switchMap } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { FollowTag, FollowsApiService } from '../../core/api/follows.service';

/** At most this many tags per follow, as the server allows. */
const MAX_TAGS = 20;
const SEARCH_DEBOUNCE_MS = 250;

let nextId = 0;

/**
 * Narrows a follow to some tags: the chosen ones as chips (× takes one off),
 * and a search of the main catalog's tags to add more. No tags means every
 * scene. Emits the whole new list on each change.
 */
@Component({
  selector: 'app-follow-tags',
  template: `
    <div class="follow-tags" [attr.aria-labelledby]="labelId">
      <span class="label" [id]="labelId">Only scenes tagged</span>
      @if (tags.length > 0) {
        <ul class="chips">
          @for (tag of tags; track tag.id) {
            <li class="chip">
              <span>{{ tag.name }}</span>
              <button
                type="button"
                [disabled]="disabled"
                [attr.aria-label]="'Remove ' + tag.name"
                [attr.data-testid]="'remove-tag-' + tag.id"
                (click)="remove(tag)"
              >
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="hint">Any tag: every new scene counts.</p>
      }
      @if (tags.length < maxTags) {
        <input
          type="search"
          class="search"
          autocomplete="off"
          [placeholder]="tags.length > 0 ? 'Add another tag' : 'Search tags'"
          [disabled]="disabled"
          [value]="query()"
          [attr.aria-label]="'Search tags to narrow following to'"
          data-testid="tag-search"
          (input)="search($any($event.target).value)"
          (keydown.enter)="$event.preventDefault(); addFirst()"
        />
        @if (query().trim().length > 0) {
          <ul class="results" role="listbox" aria-label="Matching tags">
            @if (searching()) {
              <li class="muted" role="status">Searching…</li>
            } @else if (results().length === 0) {
              <li class="muted">No tags match.</li>
            } @else {
              @for (tag of results(); track tag.id) {
                <li role="option" [attr.aria-selected]="false">
                  <button type="button" [attr.data-testid]="'add-tag-' + tag.id" (click)="add(tag)">
                    {{ tag.name }}
                  </button>
                </li>
              }
            }
          </ul>
        }
      }
      @if (tags.length > 1) {
        <p class="hint">A scene needs any one of these.</p>
      }
    </div>
  `,
  styles: `
    .follow-tags {
      display: grid;
      gap: 0.4rem;
      min-width: 0;
    }

    .label {
      color: var(--text-secondary);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.15rem;
      max-width: 100%;
      padding: 0.1rem 0.15rem 0.1rem 0.6rem;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent-text, var(--accent));
      font-size: 0.82rem;
      font-weight: 600;
    }

    .chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chip button {
      display: grid;
      place-items: center;
      width: 1.6rem;
      height: 1.6rem;
      border: 0;
      border-radius: 50%;
      background: none;
      color: inherit;
      cursor: pointer;
    }

    .chip button i {
      font-size: 0.65rem;
    }

    .search {
      min-height: 2.25rem;
      padding: 0 0.6rem;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      background: var(--surface-elevated, var(--surface-1));
      color: var(--text-primary);
      font: inherit;
    }

    .results {
      display: grid;
      max-height: 12rem;
      margin: 0;
      padding: 0.25rem;
      overflow-y: auto;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      background: var(--surface-elevated, var(--surface-1));
      list-style: none;
    }

    .results button {
      width: 100%;
      min-height: 2.1rem;
      padding: 0 0.5rem;
      border: 0;
      border-radius: 7px;
      background: none;
      color: var(--text-primary);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .results button:hover,
    .results button:focus-visible {
      background: var(--chip-bg);
    }

    .muted,
    .hint {
      margin: 0;
      padding: 0.3rem 0.5rem;
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    .hint {
      padding: 0;
    }
  `,
})
export class FollowTagsComponent implements OnDestroy {
  private readonly api = inject(FollowsApiService);
  private readonly queries = new Subject<string>();
  private readonly searchSub: Subscription;

  @Input() tags: FollowTag[] = [];
  @Input() disabled = false;
  @Output() readonly tagsChange = new EventEmitter<FollowTag[]>();

  protected readonly labelId = `follow-tags-${nextId++}`;
  protected readonly maxTags = MAX_TAGS;
  protected readonly query = signal('');
  protected readonly results = signal<FollowTag[]>([]);
  protected readonly searching = signal(false);

  constructor() {
    this.searchSub = this.queries
      .pipe(
        // No skipping a repeat: the same words typed again after adding a
        // tag still need their results.
        debounceTime(SEARCH_DEBOUNCE_MS),
        switchMap((text) =>
          text
            ? this.api.searchTags(text).pipe(catchError(() => of([] as FollowTag[])))
            : of([] as FollowTag[]),
        ),
      )
      .subscribe((tags) => {
        const chosen = new Set(this.tags.map((tag) => tag.id));
        this.results.set(tags.filter((tag) => !chosen.has(tag.id)));
        this.searching.set(false);
      });
  }

  ngOnDestroy(): void {
    this.searchSub.unsubscribe();
  }

  protected search(value: string): void {
    this.query.set(value);
    const text = value.trim();
    this.searching.set(text.length > 0);
    this.queries.next(text);
  }

  protected addFirst(): void {
    const first = this.results()[0];
    if (first && !this.searching()) {
      this.add(first);
    }
  }

  protected add(tag: FollowTag): void {
    if (this.disabled || this.tags.some((other) => other.id === tag.id)) {
      return;
    }
    this.query.set('');
    this.results.set([]);
    this.queries.next('');
    this.tagsChange.emit([...this.tags, tag].slice(0, MAX_TAGS));
  }

  protected remove(tag: FollowTag): void {
    if (this.disabled) {
      return;
    }
    this.tagsChange.emit(this.tags.filter((other) => other.id !== tag.id));
  }
}
