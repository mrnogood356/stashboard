import { Component, EventEmitter, Input, OnDestroy, Output, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Subject,
  Subscription,
  catchError,
  debounceTime,
  distinctUntilChanged,
  of,
  switchMap,
} from 'rxjs';
import {
  LocalLibraryService,
  LocalSceneUpdate,
  PeopleResults,
} from '../../core/api/local-library.service';
import type { LocalSceneDetails } from '../../core/api/playback.service';
import { SheetComponent } from '../../shared/sheet/sheet.component';

type Named = { id: string; name: string };

/**
 * A library scene's details, as in Stash's Edit tab: title, date, studio,
 * performers, code, director, links and description. Saved straight to
 * Stash; only what changed is sent.
 */
@Component({
  selector: 'app-scene-edit-sheet',
  imports: [FormsModule, NgTemplateOutlet, SheetComponent],
  templateUrl: './scene-edit-sheet.component.html',
  styleUrl: './scene-edit-sheet.component.scss',
})
export class SceneEditSheetComponent implements OnDestroy {
  private readonly library = inject(LocalLibraryService);

  @Input() open = false;
  @Input() set scene(value: LocalSceneDetails | null) {
    this.original = value;
    if (value) {
      this.reset(value);
    }
  }
  @Output() readonly closed = new EventEmitter<void>();
  @Output() readonly saved = new EventEmitter<LocalSceneDetails>();

  private original: LocalSceneDetails | null = null;

  protected readonly title = signal('');
  protected readonly date = signal('');
  protected readonly code = signal('');
  protected readonly director = signal('');
  protected readonly details = signal('');
  protected readonly urls = signal('');
  protected readonly studio = signal<Named | null>(null);
  protected readonly performers = signal<Named[]>([]);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Which picker is searching, and what it found. */
  protected readonly picking = signal<'studio' | 'performer' | null>(null);
  protected readonly peopleQuery = signal('');
  protected readonly peopleResults = signal<PeopleResults>({ performers: [], studios: [] });
  protected readonly peopleSearching = signal(false);
  private readonly queries = new Subject<string>();
  private readonly searchSubscription: Subscription = this.queries
    .pipe(
      debounceTime(250),
      distinctUntilChanged(),
      switchMap((query) => {
        if (query.trim().length < 2) {
          this.peopleSearching.set(false);
          return of({ performers: [], studios: [] } as PeopleResults);
        }
        this.peopleSearching.set(true);
        return this.library
          .searchPeople(query.trim())
          .pipe(catchError(() => of({ performers: [], studios: [] } as PeopleResults)));
      }),
    )
    .subscribe((results) => {
      this.peopleResults.set(results);
      this.peopleSearching.set(false);
    });

  ngOnDestroy(): void {
    this.searchSubscription.unsubscribe();
  }

  private reset(scene: LocalSceneDetails): void {
    this.title.set(scene.title);
    this.date.set(scene.date ?? '');
    this.code.set(scene.code ?? '');
    this.director.set(scene.director ?? '');
    this.details.set(scene.details ?? '');
    this.urls.set((scene.urls ?? []).join('\n'));
    this.studio.set(scene.studio ? { id: scene.studio.id, name: scene.studio.name } : null);
    this.performers.set(scene.performers.map(({ id, name }) => ({ id, name })));
    this.error.set(null);
    this.stopPicking();
  }

  protected startPicking(kind: 'studio' | 'performer'): void {
    this.picking.set(kind);
    this.peopleQuery.set('');
    this.peopleResults.set({ performers: [], studios: [] });
    this.queries.next('');
  }

  protected stopPicking(): void {
    this.picking.set(null);
    this.peopleQuery.set('');
  }

  protected onPeopleQuery(value: string): void {
    this.peopleQuery.set(value);
    this.queries.next(value);
  }

  protected pickStudio(studio: Named): void {
    this.studio.set(studio);
    this.stopPicking();
  }

  protected addPerformer(performer: Named): void {
    if (!this.performers().some((existing) => existing.id === performer.id)) {
      this.performers.update((list) => [...list, performer]);
    }
    this.peopleQuery.set('');
    this.peopleResults.set({ performers: [], studios: [] });
  }

  protected removePerformer(id: string): void {
    this.performers.update((list) => list.filter((performer) => performer.id !== id));
  }

  /** What differs from the scene as Stash has it, ready to send. */
  protected changes(): LocalSceneUpdate {
    const scene = this.original;
    if (!scene) {
      return {};
    }
    const update: LocalSceneUpdate = {};
    const text = (value: string) => value.trim() || null;
    if (this.title().trim() !== scene.title) {
      update.title = this.title().trim();
    }
    if (text(this.date()) !== (scene.date ?? null)) {
      update.date = text(this.date());
    }
    if (text(this.code()) !== (scene.code ?? null)) {
      update.code = text(this.code());
    }
    if (text(this.director()) !== (scene.director ?? null)) {
      update.director = text(this.director());
    }
    if (text(this.details()) !== (scene.details ?? null)) {
      update.details = text(this.details());
    }
    const urls = this.urls()
      .split(/\s+/)
      .map((url) => url.trim())
      .filter(Boolean);
    if (urls.join('\n') !== (scene.urls ?? []).join('\n')) {
      update.urls = urls;
    }
    if ((this.studio()?.id ?? null) !== (scene.studio?.id ?? null)) {
      update.studioId = this.studio()?.id ?? null;
    }
    const performerIds = this.performers().map((performer) => performer.id);
    if (performerIds.join(',') !== scene.performers.map((performer) => performer.id).join(',')) {
      update.performerIds = performerIds;
    }
    return update;
  }

  protected problem(): string | null {
    if (!this.title().trim()) {
      return 'A scene needs a title.';
    }
    const date = this.date().trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return 'Write the date as YYYY-MM-DD.';
    }
    const bad = this.urls()
      .split(/\s+/)
      .filter(Boolean)
      .find((url) => !/^https?:\/\/\S+$/.test(url));
    return bad ? `“${bad}” isn’t a link: links start with http:// or https://.` : null;
  }

  protected save(): void {
    const scene = this.original;
    if (!scene || this.saving() || this.problem()) {
      return;
    }
    const update = this.changes();
    if (Object.keys(update).length === 0) {
      this.closed.emit();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    this.library.updateScene(scene.id, update).subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.saved.emit(saved);
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
      if (this.original) {
        this.reset(this.original);
      }
      this.closed.emit();
    }
  }
}
