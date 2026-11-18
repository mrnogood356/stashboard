import { Component, EventEmitter, Input, OnDestroy, Output, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Observable,
  Subject,
  Subscription,
  catchError,
  debounceTime,
  map,
  of,
  switchMap,
} from 'rxjs';
import { LocalLibraryService } from '../../core/api/local-library.service';
import { SheetComponent } from '../../shared/sheet/sheet.component';

type Named = { id: string; name: string };

/** What a picker is choosing. */
type Picking = 'studio' | 'add-performer' | 'remove-performer' | 'add-tag' | 'remove-tag';

const NONE: Named[] = [];

/**
 * The same change on many library scenes, as Stash's own bulk edit: set the
 * studio, add or take off performers, add or take off tags. Anything left
 * empty is left as it is on each scene.
 */
@Component({
  selector: 'app-bulk-edit-sheet',
  imports: [FormsModule, NgTemplateOutlet, SheetComponent],
  templateUrl: './bulk-edit-sheet.component.html',
  // The edit sheet's form, chips and pickers.
  styleUrl: '../local-scene/scene-edit-sheet.component.scss',
})
export class BulkEditSheetComponent implements OnDestroy {
  private readonly library = inject(LocalLibraryService);

  @Input() open = false;
  @Input() set sceneIds(value: readonly string[]) {
    this.ids = [...value];
    this.reset();
  }
  @Output() readonly closed = new EventEmitter<void>();
  /** How many scenes Stash changed. */
  @Output() readonly saved = new EventEmitter<number>();

  protected ids: string[] = [];

  protected readonly studio = signal<Named | null>(null);
  protected readonly addPerformers = signal<Named[]>([]);
  protected readonly removePerformers = signal<Named[]>([]);
  protected readonly addTags = signal<Named[]>([]);
  protected readonly removeTags = signal<Named[]>([]);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly picking = signal<Picking | null>(null);
  protected readonly query = signal('');
  protected readonly results = signal<Named[]>([]);
  protected readonly searching = signal(false);
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  private readonly queries = new Subject<{ kind: Picking; query: string }>();
  private readonly searchSubscription: Subscription = this.queries
    .pipe(
      debounceTime(250),
      switchMap(({ kind, query }) => {
        if (query.trim().length < 2) {
          this.searching.set(false);
          return of(NONE);
        }
        this.searching.set(true);
        return this.search(kind, query.trim()).pipe(catchError(() => of(NONE)));
      }),
    )
    .subscribe((results) => {
      this.results.set(results);
      this.searching.set(false);
    });

  ngOnDestroy(): void {
    this.searchSubscription.unsubscribe();
  }

  private search(kind: Picking, query: string): Observable<Named[]> {
    if (kind === 'add-tag' || kind === 'remove-tag') {
      return this.library.searchTags(query);
    }
    return this.library
      .searchPeople(query)
      .pipe(map((found) => (kind === 'studio' ? found.studios : found.performers)));
  }

  private reset(): void {
    this.studio.set(null);
    this.addPerformers.set([]);
    this.removePerformers.set([]);
    this.addTags.set([]);
    this.removeTags.set([]);
    this.error.set(null);
    this.stopPicking();
  }

  protected heading(): string {
    return this.ids.length === 1 ? 'Edit 1 scene' : `Edit ${this.ids.length} scenes`;
  }

  protected startPicking(kind: Picking): void {
    this.picking.set(kind);
    this.query.set('');
    this.results.set([]);
    this.createError.set(null);
    this.queries.next({ kind, query: '' });
  }

  protected stopPicking(): void {
    this.picking.set(null);
    this.query.set('');
    this.results.set([]);
    this.createError.set(null);
  }

  protected onQuery(value: string): void {
    const kind = this.picking();
    this.query.set(value);
    if (kind) {
      this.queries.next({ kind, query: value });
    }
  }

  protected placeholder(kind: Picking): string {
    switch (kind) {
      case 'studio':
        return 'Find a studio in Stash';
      case 'add-performer':
      case 'remove-performer':
        return 'Find a performer in Stash';
      default:
        return 'Find a tag in Stash';
    }
  }

  private listFor(kind: Exclude<Picking, 'studio'>) {
    switch (kind) {
      case 'add-performer':
        return this.addPerformers;
      case 'remove-performer':
        return this.removePerformers;
      case 'add-tag':
        return this.addTags;
      default:
        return this.removeTags;
    }
  }

  /** The other list of the same kind: one can't be both added and taken off. */
  private oppositeOf(kind: Exclude<Picking, 'studio'>) {
    switch (kind) {
      case 'add-performer':
        return this.removePerformers;
      case 'remove-performer':
        return this.addPerformers;
      case 'add-tag':
        return this.removeTags;
      default:
        return this.addTags;
    }
  }

  protected choose(option: Named): void {
    const kind = this.picking();
    if (!kind) {
      return;
    }
    if (kind === 'studio') {
      this.studio.set(option);
      this.stopPicking();
      return;
    }
    const list = this.listFor(kind);
    if (!list().some((existing) => existing.id === option.id)) {
      list.update((items) => [...items, option]);
    }
    this.oppositeOf(kind).update((items) => items.filter((item) => item.id !== option.id));
    this.query.set('');
    this.results.set([]);
  }

  protected drop(kind: Exclude<Picking, 'studio'>, id: string): void {
    this.listFor(kind).update((items) => items.filter((item) => item.id !== id));
  }

  /** New performers and studios can be added to Stash; tags and take-offs can't. */
  protected canCreate(): boolean {
    const kind = this.picking();
    const name = this.query().trim();
    if ((kind !== 'studio' && kind !== 'add-performer') || name.length < 2 || this.searching()) {
      return false;
    }
    return !this.results().some((option) => option.name.toLowerCase() === name.toLowerCase());
  }

  protected create(): void {
    const kind = this.picking();
    const name = this.query().trim();
    if ((kind !== 'studio' && kind !== 'add-performer') || !name || this.creating()) {
      return;
    }
    this.creating.set(true);
    this.createError.set(null);
    this.library.createPerson(kind === 'studio' ? 'studio' : 'performer', name).subscribe({
      next: (person) => {
        this.creating.set(false);
        this.choose({ id: person.id, name: person.name });
      },
      error: () => {
        this.creating.set(false);
        this.createError.set(`Couldn’t add “${name}” to Stash. Check that Stash is running.`);
      },
    });
  }

  protected hasChanges(): boolean {
    return (
      this.studio() !== null ||
      this.addPerformers().length +
        this.removePerformers().length +
        this.addTags().length +
        this.removeTags().length >
        0
    );
  }

  protected save(): void {
    if (this.saving() || !this.hasChanges() || this.ids.length === 0) {
      return;
    }
    const ids = (list: Named[]) => list.map((item) => item.id);
    this.saving.set(true);
    this.error.set(null);
    this.library
      .bulkEditScenes({
        sceneIds: this.ids.slice(0, 100),
        studioId: this.studio()?.id,
        addPerformerIds: ids(this.addPerformers()),
        removePerformerIds: ids(this.removePerformers()),
        addTagIds: ids(this.addTags()),
        removeTagIds: ids(this.removeTags()),
      })
      .subscribe({
        next: (result) => {
          this.saving.set(false);
          this.saved.emit(result.edited);
        },
        error: (error: unknown) => {
          this.saving.set(false);
          const message =
            error instanceof HttpErrorResponse &&
            typeof (error.error as { message?: unknown } | null)?.message === 'string'
              ? (error.error as { message: string }).message
              : 'Check that Stash is running and try again.';
          this.error.set(`Couldn’t save that to Stash. ${message}`);
        },
      });
  }

  protected close(): void {
    if (!this.saving()) {
      this.closed.emit();
    }
  }
}
