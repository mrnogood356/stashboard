import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LocalLibraryService, SimilarTagGroup } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

/**
 * Tags written more than one way ("Blonde", "blondes"), side by side. You
 * pick which to keep and which to fold into it; nothing merges until you do.
 */
@Component({
  selector: 'app-tag-cleanup-page',
  imports: [RouterLink],
  templateUrl: './tag-cleanup-page.component.html',
  styleUrls: ['./tools-shared.scss', './tag-cleanup-page.component.scss'],
})
export class TagCleanupPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly groups = signal<SimilarTagGroup[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  /** Per group (by its first tag): the tag kept, and the tags folded in. */
  protected readonly keep = signal<Record<string, string>>({});
  protected readonly fold = signal<Record<string, string[]>>({});
  protected readonly confirming = signal<string | null>(null);
  protected readonly merging = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(false);
    this.library.similarTags().subscribe({
      next: (groups) => {
        this.groups.set(groups);
        this.keep.set(Object.fromEntries(groups.map((group) => [key(group), group.keepId])));
        this.fold.set(
          Object.fromEntries(
            groups.map((group) => [
              key(group),
              group.tags.filter((tag) => tag.id !== group.keepId).map((tag) => tag.id),
            ]),
          ),
        );
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  protected groupKey(group: SimilarTagGroup): string {
    return key(group);
  }

  protected kept(group: SimilarTagGroup): string {
    return this.keep()[key(group)] ?? group.keepId;
  }

  protected folded(group: SimilarTagGroup, id: string): boolean {
    return (this.fold()[key(group)] ?? []).includes(id);
  }

  protected setKeep(group: SimilarTagGroup, id: string): void {
    const k = key(group);
    this.keep.update((all) => ({ ...all, [k]: id }));
    // The kept tag can't also be folded in; the old kept one now can be.
    this.fold.update((all) => ({
      ...all,
      [k]: group.tags.filter((tag) => tag.id !== id).map((tag) => tag.id),
    }));
    this.confirming.set(null);
  }

  protected toggleFold(group: SimilarTagGroup, id: string): void {
    const k = key(group);
    this.fold.update((all) => {
      const current = all[k] ?? [];
      return {
        ...all,
        [k]: current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
      };
    });
    this.confirming.set(null);
  }

  protected foldCount(group: SimilarTagGroup): number {
    return (this.fold()[key(group)] ?? []).filter((id) => id !== this.kept(group)).length;
  }

  protected keptName(group: SimilarTagGroup): string {
    return group.tags.find((tag) => tag.id === this.kept(group))?.name ?? '';
  }

  /** First tap asks, second tap merges. */
  protected merge(group: SimilarTagGroup): void {
    const k = key(group);
    if (this.confirming() !== k) {
      this.confirming.set(k);
      return;
    }
    const destination = this.kept(group);
    const sources = (this.fold()[k] ?? []).filter((id) => id !== destination);
    this.merging.set(k);
    this.library.mergeTags(destination, sources).subscribe({
      next: () => {
        this.merging.set(null);
        this.confirming.set(null);
        const name = this.keptName(group);
        const left = group.tags.filter(
          (tag) => tag.id === destination || !sources.includes(tag.id),
        );
        this.groups.update((groups) =>
          groups
            // The tag kept becomes the group's default, whichever it was.
            .map((entry) =>
              key(entry) === k ? { ...entry, keepId: destination, tags: left } : entry,
            )
            .filter((entry) => entry.tags.length > 1),
        );
        this.notifications.success(
          'Merged',
          `${sources.length} ${sources.length === 1 ? 'tag' : 'tags'} merged into ${name}.`,
        );
      },
      error: () => {
        this.merging.set(null);
        this.notifications.error("Couldn't merge those tags", 'Check that Stash is running.');
      },
    });
  }
}

function key(group: SimilarTagGroup): string {
  return group.tags
    .map((tag) => tag.id)
    .sort()
    .join(',');
}
