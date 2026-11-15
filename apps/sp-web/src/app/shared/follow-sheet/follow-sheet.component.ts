import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  booleanAttribute,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { MultiSelect } from 'primeng/multiselect';
import { Select } from 'primeng/select';
import { ToggleSwitch } from 'primeng/toggleswitch';
import {
  Subject,
  Subscription,
  catchError,
  debounceTime,
  finalize,
  map,
  of,
  switchMap,
} from 'rxjs';
import { SheetComponent } from '../sheet/sheet.component';
import {
  Follow,
  FollowChanges,
  FollowTag,
  FollowsApiService,
  SINCE_OPTIONS,
  sinceDayLabel,
  sinceDaysAgo,
  sinceOptionFor,
} from '../../core/api/follows.service';

const SEARCH_DEBOUNCE_MS = 250;
/** At most this many tags per follow, as the server allows. */
const MAX_TAGS = 20;
/** The "Starting from" value for a start none of the choices matches. */
const KEEP_START = 'keep';

interface Option<T> {
  label: string;
  value: T;
}

/**
 * A follow's options, as a sheet like the request sheet: where it starts,
 * which tags it's narrowed to, whether it requests on its own, and
 * Unfollow. Nothing is saved until Save.
 */
@Component({
  selector: 'app-follow-sheet',
  imports: [
    FormsModule,
    RouterLink,
    SheetComponent,
    ButtonDirective,
    Message,
    MultiSelect,
    Select,
    ToggleSwitch,
  ],
  templateUrl: './follow-sheet.component.html',
  styleUrl: './follow-sheet.component.scss',
})
export class FollowSheetComponent implements OnChanges, OnDestroy {
  private readonly api = inject(FollowsApiService);
  private readonly tagQueries = new Subject<string>();
  private readonly tagSearchSub: Subscription;

  @Input() open = false;
  /** The follow whose options these are. */
  @Input() set follow(value: Follow | null) {
    this.current.set(value);
  }
  get follow(): Follow | null {
    return this.current();
  }
  private readonly current = signal<Follow | null>(null);
  /** Shows "Open page" in the header (from lists, not from the page itself). */
  @Input({ transform: booleanAttribute }) showPageLink = false;
  /** Artwork behind the header, like the request sheet's scene art. */
  @Input() imageUrl: string | null = null;
  @Output() readonly closed = new EventEmitter<void>();
  @Output() readonly saved = new EventEmitter<{ follow: Follow; changes: FollowChanges }>();
  @Output() readonly unfollowed = new EventEmitter<Follow>();

  protected readonly startChoice = signal<number | typeof KEEP_START>(0);
  protected readonly tags = signal<FollowTag[]>([]);
  protected readonly autoRequest = signal(false);
  protected readonly busy = signal(false);
  protected readonly confirmingUnfollow = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly tagSearchTerm = signal('');
  protected readonly tagSearchLoading = signal(false);
  protected readonly tagSearchFailed = signal(false);
  private readonly tagResults = signal<FollowTag[]>([]);

  protected readonly startOptions = computed<Array<Option<number | typeof KEEP_START>>>(() => {
    const follow = this.current();
    const options: Array<Option<number | typeof KEEP_START>> = SINCE_OPTIONS.map((option) => ({
      label: option.label,
      value: option.days,
    }));
    // Chosen a while ago, its day no longer matches a choice: keep it as is.
    return follow && sinceOptionFor(follow.since) === null
      ? [{ label: sinceDayLabel(follow.since), value: KEEP_START }, ...options]
      : options;
  });

  /** The chosen tags first, then what the search found. */
  protected readonly tagOptions = computed<Array<Option<string>>>(() => {
    const merged = new Map<string, Option<string>>();
    for (const tag of [...this.tags(), ...this.tagResults()]) {
      merged.set(tag.id, { label: tag.name, value: tag.id });
    }
    return [...merged.values()];
  });
  protected readonly tagIds = computed(() => this.tags().map((tag) => tag.id));
  protected readonly maxTags = MAX_TAGS;

  constructor() {
    this.tagSearchSub = this.tagQueries
      .pipe(
        map((value) => value.trim()),
        debounceTime(SEARCH_DEBOUNCE_MS),
        switchMap((query) => {
          if (!query) {
            return of({ tags: [] as FollowTag[], failed: false });
          }
          this.tagSearchLoading.set(true);
          return this.api.searchTags(query).pipe(
            map((tags) => ({ tags, failed: false })),
            catchError(() => of({ tags: [] as FollowTag[], failed: true })),
            finalize(() => this.tagSearchLoading.set(false)),
          );
        }),
      )
      .subscribe(({ tags, failed }) => {
        this.tagResults.set(tags);
        this.tagSearchFailed.set(failed);
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Opened, or opened for another follow: start from what's saved.
    if ((changes['open'] || changes['follow']) && this.open && this.follow) {
      const follow = this.follow;
      this.startChoice.set(sinceOptionFor(follow.since) ?? KEEP_START);
      this.tags.set([...follow.tags]);
      this.autoRequest.set(follow.autoRequest);
      this.tagResults.set([]);
      this.tagSearchTerm.set('');
      this.tagSearchFailed.set(false);
      this.error.set(null);
      this.confirmingUnfollow.set(false);
      this.busy.set(false);
    }
  }

  ngOnDestroy(): void {
    this.tagSearchSub.unsubscribe();
  }

  protected pageRoute(follow: Follow): string[] {
    return [follow.kind === 'PERFORMER' ? '/performer' : '/studio', follow.entityId];
  }

  protected close(): void {
    if (!this.busy()) {
      this.closed.emit();
    }
  }

  protected onTagsChanged(ids: string[] | null): void {
    const known = new Map(
      [...this.tags(), ...this.tagResults()].map((tag) => [tag.id, tag] as const),
    );
    this.tags.set(
      [...new Set(ids ?? [])]
        .map((id) => known.get(id))
        .filter((tag): tag is FollowTag => tag !== undefined)
        .slice(0, MAX_TAGS),
    );
  }

  protected onTagFilter(value: string | null | undefined): void {
    const term = (value ?? '').trimStart();
    this.tagSearchTerm.set(term);
    this.tagQueries.next(term);
  }

  protected tagEmptyMessage(): string {
    if (this.tagSearchLoading()) {
      return 'Searching…';
    }
    if (this.tagSearchFailed()) {
      return 'Couldn’t search tags. Type again to retry.';
    }
    return this.tagSearchTerm().trim() ? 'No tags match.' : 'Type to search tags.';
  }

  protected save(): void {
    const follow = this.follow;
    if (!follow || this.busy()) {
      return;
    }
    const changes = this.pendingChanges(follow);
    if (Object.keys(changes).length === 0) {
      this.closed.emit();
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api.update(follow.id, changes).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.saved.emit({ follow: saved, changes });
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Couldn’t save that. Try again.');
      },
    });
  }

  protected unfollow(): void {
    const follow = this.follow;
    if (!follow || this.busy()) {
      return;
    }
    if (!this.confirmingUnfollow()) {
      this.confirmingUnfollow.set(true);
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.api.unfollow(follow.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.unfollowed.emit(follow);
      },
      error: () => {
        this.busy.set(false);
        this.confirmingUnfollow.set(false);
        this.error.set('Couldn’t unfollow. Try again.');
      },
    });
  }

  /** Only what differs from what's saved. */
  private pendingChanges(follow: Follow): FollowChanges {
    const changes: FollowChanges = {};
    const start = this.startChoice();
    if (start !== KEEP_START && start !== sinceOptionFor(follow.since)) {
      changes.since = sinceDaysAgo(start);
    }
    const before = follow.tags
      .map((tag) => tag.id)
      .sort()
      .join(',');
    const after = this.tagIds().slice().sort().join(',');
    if (before !== after) {
      changes.tags = this.tags();
    }
    if (this.autoRequest() !== follow.autoRequest) {
      changes.autoRequest = this.autoRequest();
    }
    return changes;
  }
}
