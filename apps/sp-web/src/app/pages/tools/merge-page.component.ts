import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { Subject, debounceTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  LocalLibraryService,
  type MergeCandidate,
  type MergeKind,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

interface MergeSet {
  key: string;
  items: MergeCandidate[];
  keepId: string;
  /** Ones ticked to merge into the kept one. */
  merge: ReadonlySet<string>;
}

const MANUAL = 'by-hand';

/**
 * Library tools → Merge: performers or studios entered more than once, and
 * any you pick by hand, merged into one with their scenes and names.
 */
@Component({
  selector: 'app-merge-page',
  imports: [FormsModule, RouterLink, NgTemplateOutlet],
  templateUrl: './merge-page.component.html',
  styleUrls: ['./tools-shared.scss', './merge-page.component.scss'],
})
export class MergePageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly kind = signal<MergeKind>('performers');
  protected readonly sets = signal<MergeSet[]>([]);
  protected readonly manual = signal<MergeSet | null>(null);
  protected readonly matches = signal<MergeCandidate[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly confirming = signal<string | null>(null);
  protected readonly merging = signal<string | null>(null);
  protected query = '';
  private readonly typed = new Subject<void>();

  constructor() {
    this.typed.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(() => this.search());
  }

  ngOnInit(): void {
    this.load();
  }

  protected setKind(kind: MergeKind): void {
    if (kind !== this.kind()) {
      this.kind.set(kind);
      this.manual.set(null);
      this.query = '';
      this.matches.set([]);
      this.load();
    }
  }

  protected noun(count = 2): string {
    const one = this.kind() === 'performers' ? 'performer' : 'studio';
    return count === 1 ? one : `${one}s`;
  }

  protected onType(): void {
    this.typed.next();
  }

  /** Adds a search result to the set picked by hand. */
  protected pick(item: MergeCandidate): void {
    const current = this.manual();
    if (current?.items.some((other) => other.id === item.id)) {
      return;
    }
    const items = [...(current?.items ?? []), item];
    const keepId = current?.keepId ?? item.id;
    this.manual.set({
      key: MANUAL,
      items,
      keepId,
      merge: new Set(items.filter((other) => other.id !== keepId).map((other) => other.id)),
    });
  }

  protected unpick(item: MergeCandidate): void {
    const current = this.manual();
    if (!current) {
      return;
    }
    const items = current.items.filter((other) => other.id !== item.id);
    if (items.length === 0) {
      this.manual.set(null);
      return;
    }
    const keepId = items.some((other) => other.id === current.keepId)
      ? current.keepId
      : items[0].id;
    this.manual.set({
      ...current,
      items,
      keepId,
      merge: new Set([...current.merge].filter((id) => id !== item.id && id !== keepId)),
    });
  }

  protected setKeep(set: MergeSet, id: string): void {
    this.update(set, {
      keepId: id,
      merge: new Set(set.items.filter((item) => item.id !== id).map((item) => item.id)),
    });
  }

  protected toggle(set: MergeSet, id: string): void {
    const merge = new Set(set.merge);
    if (merge.has(id)) {
      merge.delete(id);
    } else {
      merge.add(id);
    }
    this.update(set, { merge });
  }

  protected keptName(set: MergeSet): string {
    return set.items.find((item) => item.id === set.keepId)?.name ?? '';
  }

  /** Two taps: the first asks, the second merges. */
  protected run(set: MergeSet): void {
    if (set.merge.size === 0 || this.merging()) {
      return;
    }
    if (this.confirming() !== set.key) {
      this.confirming.set(set.key);
      return;
    }
    this.confirming.set(null);
    this.merging.set(set.key);
    const kind = this.kind();
    this.library.merge(kind, set.keepId, [...set.merge]).subscribe({
      next: () => {
        this.merging.set(null);
        this.notifications.success(
          'Merged',
          `${set.merge.size} ${this.noun(set.merge.size)} merged into ${this.keptName(set)}.`,
        );
        if (set.key === MANUAL) {
          this.manual.set(null);
        }
        this.load();
      },
      error: (error: { error?: { message?: string } }) => {
        this.merging.set(null);
        this.notifications.error(
          "Couldn't merge them",
          error.error?.message ?? 'Check that Stash is running, then look again.',
        );
      },
    });
  }

  private update(set: MergeSet, change: Partial<MergeSet>): void {
    this.confirming.set(null);
    if (set.key === MANUAL) {
      this.manual.set({ ...set, ...change });
    } else {
      this.sets.update((sets) =>
        sets.map((other) => (other.key === set.key ? { ...other, ...change } : other)),
      );
    }
  }

  private load(): void {
    this.loading.set(true);
    this.error.set(false);
    const kind = this.kind();
    this.library.mergeCandidates(kind).subscribe({
      next: ({ groups }) => {
        if (kind !== this.kind()) {
          return;
        }
        this.sets.set(
          groups.map((group) => ({
            key: group.items.map((item) => item.id).join(','),
            items: group.items,
            keepId: group.keepId,
            merge: new Set(
              group.items.filter((item) => item.id !== group.keepId).map((item) => item.id),
            ),
          })),
        );
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
      },
    });
  }

  private search(): void {
    const query = this.query.trim();
    if (!query) {
      this.matches.set([]);
      return;
    }
    const kind = this.kind();
    this.library.mergeCandidates(kind, query).subscribe({
      next: ({ matches }) => {
        if (kind === this.kind()) {
          this.matches.set(matches);
        }
      },
      error: () => this.matches.set([]),
    });
  }
}
