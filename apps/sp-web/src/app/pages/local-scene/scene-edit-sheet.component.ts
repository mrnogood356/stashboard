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
  of,
  switchMap,
  tap,
} from 'rxjs';
import {
  LocalLibraryService,
  LocalSceneUpdate,
  PeopleResults,
} from '../../core/api/local-library.service';
import { MatchCandidate, OrganizerApiService } from '../../core/api/organizer.service';
import { PlaybackService, type LocalSceneDetails } from '../../core/api/playback.service';
import { SheetComponent } from '../../shared/sheet/sheet.component';

type Named = { id: string; name: string };

/** The text fields a StashDB match can fill in on its own. */
type CopyField = 'title' | 'date' | 'code' | 'director' | 'details' | 'urls';

const COPY_FIELDS: ReadonlyArray<{ key: CopyField; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'date', label: 'Release date' },
  { key: 'code', label: 'Studio code' },
  { key: 'director', label: 'Director' },
  { key: 'details', label: 'Description' },
  { key: 'urls', label: 'Links' },
];

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
  private readonly organizer = inject(OrganizerApiService);
  private readonly playback = inject(PlaybackService);

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
  /** Adding a new performer or studio to Stash from the search. */
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);
  private readonly queries = new Subject<string>();
  private readonly searchSubscription: Subscription = this.queries
    .pipe(
      // No distinctUntilChanged: the same words asked again after a pick
      // (the list cleared) must search again.
      debounceTime(250),
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

  // ---------- filling in from StashDB ----------

  protected readonly copyFields = COPY_FIELDS;
  /** The StashDB finder is open. */
  protected readonly finding = signal(false);
  protected readonly findQuery = signal('');
  protected readonly finds = signal<MatchCandidate[]>([]);
  protected readonly findLoading = signal(false);
  protected readonly findError = signal<string | null>(null);
  /** What was searched for, when the fingerprints found nothing. */
  protected readonly searchedFor = signal<string | null>(null);
  protected readonly chosen = signal<MatchCandidate | null>(null);
  protected readonly copying = signal<ReadonlySet<CopyField>>(new Set());
  protected readonly matching = signal(false);
  private findRequest: Subscription | null = null;
  /** The match saved for "scene:candidate", when the scene then failed to load. */
  private appliedMatch: string | null = null;
  /**
   * Bumped each time a people picker opens or closes: someone added to
   * Stash from a picker that has since closed isn't put on the scene.
   */
  private pickSession = 0;

  /** Saving the form or a whole match: either keeps the sheet busy. */
  protected busy(): boolean {
    return this.saving() || this.matching();
  }

  protected startFinding(): void {
    this.finding.set(true);
    this.findQuery.set('');
    this.chosen.set(null);
    this.lookUp();
  }

  protected stopFinding(): void {
    this.findRequest?.unsubscribe();
    this.finding.set(false);
    this.finds.set([]);
    this.chosen.set(null);
    this.findError.set(null);
    this.findLoading.set(false);
  }

  /** Fingerprints and the file name first; your own words when given. */
  protected lookUp(): void {
    const scene = this.original;
    if (!scene) {
      return;
    }
    this.findRequest?.unsubscribe();
    this.findLoading.set(true);
    this.findError.set(null);
    this.chosen.set(null);
    this.findRequest = this.organizer
      .lookup([scene.id], this.findQuery().trim() || undefined)
      .subscribe({
        next: ([result]) => {
          this.findLoading.set(false);
          this.finds.set(result?.candidates ?? []);
          this.searchedFor.set(result?.searchedFor ?? null);
        },
        error: () => {
          this.findLoading.set(false);
          this.finds.set([]);
          this.findError.set('Couldn’t search StashDB. Check its settings and try again.');
        },
      });
  }

  /** What a match would put in a field, or null when it has nothing. */
  protected matchValue(candidate: MatchCandidate, field: CopyField): string | null {
    switch (field) {
      case 'title':
        return candidate.title?.trim() || null;
      case 'date':
        // Only a whole date: the form takes YYYY-MM-DD.
        return candidate.date && /^\d{4}-\d{2}-\d{2}$/.test(candidate.date) ? candidate.date : null;
      case 'code':
        return candidate.code?.trim() || null;
      case 'director':
        return candidate.director?.trim() || null;
      case 'details':
        return candidate.details?.trim() || null;
      case 'urls':
        return candidate.urls?.length ? candidate.urls.join('\n') : null;
    }
  }

  protected choose(candidate: MatchCandidate): void {
    this.chosen.set(candidate);
    this.copying.set(
      new Set(COPY_FIELDS.map(({ key }) => key).filter((key) => this.matchValue(candidate, key))),
    );
  }

  protected toggleCopy(field: CopyField): void {
    const next = new Set(this.copying());
    if (next.has(field)) {
      next.delete(field);
    } else {
      next.add(field);
    }
    this.copying.set(next);
  }

  /** Puts the ticked fields into the form, to check and save as usual. */
  protected copyChosen(): void {
    const candidate = this.chosen();
    if (!candidate) {
      return;
    }
    const targets: Record<CopyField, (value: string) => void> = {
      title: (value) => this.title.set(value),
      date: (value) => this.date.set(value),
      code: (value) => this.code.set(value),
      director: (value) => this.director.set(value),
      details: (value) => this.details.set(value),
      urls: (value) => this.urls.set(value),
    };
    for (const field of this.copying()) {
      const value = this.matchValue(candidate, field);
      if (value) {
        targets[field](value);
      }
    }
    this.stopFinding();
  }

  /**
   * Saves the whole match now, as Match scenes does: the text, studio,
   * performers, tags, cover and the link to the StashDB scene.
   */
  protected matchChosen(): void {
    const scene = this.original;
    const candidate = this.chosen();
    // Not while the form is saving: one would overwrite the other.
    if (!scene || !candidate || this.matching() || this.saving()) {
      return;
    }
    this.matching.set(true);
    this.findError.set(null);
    const key = `${scene.id}:${candidate.id}`;
    // Saved already, only the scene didn't load again after: just load it.
    // The match can't be saved twice (the server lets it go once used).
    const applied: Observable<unknown> =
      this.appliedMatch === key
        ? of(null)
        : this.organizer.apply(scene.id, candidate.id).pipe(
            tap(() => {
              this.appliedMatch = key;
            }),
          );
    applied.pipe(switchMap(() => this.playback.getSceneDetails(scene.id))).subscribe({
      next: (details) => {
        this.matching.set(false);
        this.appliedMatch = null;
        this.stopFinding();
        this.saved.emit(details);
      },
      error: (error: unknown) => {
        this.matching.set(false);
        if (this.appliedMatch === key) {
          this.findError.set('It’s matched, but the scene didn’t load again. Try again.');
          return;
        }
        const message =
          error instanceof HttpErrorResponse &&
          typeof (error.error as { message?: unknown } | null)?.message === 'string'
            ? (error.error as { message: string }).message
            : 'Try again.';
        this.findError.set(`Couldn’t match it. ${message}`);
      },
    });
  }

  ngOnDestroy(): void {
    this.searchSubscription.unsubscribe();
    this.findRequest?.unsubscribe();
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
    this.appliedMatch = null;
    this.stopPicking();
    this.stopFinding();
  }

  protected startPicking(kind: 'studio' | 'performer'): void {
    this.pickSession += 1;
    this.picking.set(kind);
    this.peopleQuery.set('');
    this.peopleResults.set({ performers: [], studios: [] });
    this.queries.next('');
  }

  protected stopPicking(): void {
    this.pickSession += 1;
    this.picking.set(null);
    this.peopleQuery.set('');
    this.createError.set(null);
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

  /**
   * Offer to add the name searched for when Stash has no one by exactly that
   * name: after the search has answered, so it isn't offered for a name
   * that's only still loading.
   */
  protected canCreate(kind: 'studio' | 'performer'): boolean {
    const name = this.peopleQuery().trim();
    if (name.length < 2 || this.peopleSearching()) {
      return false;
    }
    const found =
      kind === 'studio' ? this.peopleResults().studios : this.peopleResults().performers;
    return !found.some((option) => option.name.toLowerCase() === name.toLowerCase());
  }

  protected createPerson(kind: 'studio' | 'performer'): void {
    const name = this.peopleQuery().trim();
    if (!name || this.creating()) {
      return;
    }
    this.creating.set(true);
    this.createError.set(null);
    const session = this.pickSession;
    this.library.createPerson(kind, name).subscribe({
      next: (person) => {
        this.creating.set(false);
        // That picker closed, or another opened: it's in Stash, not chosen.
        if (session !== this.pickSession) {
          return;
        }
        const named = { id: person.id, name: person.name };
        if (kind === 'studio') {
          this.pickStudio(named);
        } else {
          this.addPerformer(named);
        }
      },
      error: () => {
        this.creating.set(false);
        this.createError.set(`Couldn’t add “${name}” to Stash. Check that Stash is running.`);
      },
    });
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
    // Not while a whole match is saving, or while someone is being added.
    if (!scene || this.busy() || this.creating() || this.problem()) {
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
        // The API's checks answer with a list of messages; Stash with one.
        const body =
          error instanceof HttpErrorResponse ? (error.error as { message?: unknown } | null) : null;
        const message =
          typeof body?.message === 'string'
            ? body.message
            : Array.isArray(body?.message) &&
                body.message.every((entry) => typeof entry === 'string')
              ? (body.message as string[]).join(' ')
              : 'Check that Stash is running and try again.';
        this.error.set(`Couldn’t save that to Stash. ${message}`);
      },
    });
  }

  protected close(): void {
    if (!this.busy()) {
      if (this.original) {
        this.reset(this.original);
      }
      this.closed.emit();
    }
  }
}
