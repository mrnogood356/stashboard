import { SheetComponent } from '../../shared/sheet/sheet.component';
import { Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  DuplicateGroup,
  DuplicateScene,
  LocalLibraryService,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

type Accuracy = 'exact' | 'high' | 'medium';

const ACCURACY: Array<{ value: Accuracy; label: string }> = [
  { value: 'exact', label: 'Exact' },
  { value: 'high', label: 'Very close' },
  { value: 'medium', label: 'Close' },
];

/**
 * Copies of the same video, side by side (Stash's look-alike fingerprints).
 * The best copy is marked and kept unless you pick another to keep; the
 * others can be removed.
 */
@Component({
  selector: 'app-duplicates-page',
  imports: [RouterLink, FormsModule, SheetComponent],
  templateUrl: './duplicates-page.component.html',
  styleUrls: ['./tools-shared.scss', './duplicates-page.component.scss'],
})
export class DuplicatesPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly router = inject(Router);

  protected readonly accuracyOptions = ACCURACY;
  protected readonly accuracy = signal<Accuracy>('exact');
  protected readonly groups = signal<DuplicateGroup[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** The copies the delete sheet is open for: one, a set's extras, or every set's. */
  protected readonly pending = signal<DuplicateScene[] | null>(null);
  /** While several are removed: how many are done. */
  protected readonly progress = signal<{ done: number; total: number } | null>(null);
  protected readonly deleting = signal(false);
  /** Bring plays, tags, chapters and more over to the copy kept first. */
  protected carryOver = true;
  protected readonly hiddenCount = signal(0);
  /**
   * The copy you chose to keep, by set (keyed by its suggested copy), where
   * it isn't the suggested best one.
   */
  private readonly chosen = signal<ReadonlyMap<string, string>>(new Map());
  /** Sets being hidden, so a second tap doesn't count one twice. */
  private readonly hiding = new Set<string>();
  private loadRequest = 0;

  ngOnInit(): void {
    this.load();
  }

  protected setAccuracy(value: Accuracy): void {
    if (value !== this.accuracy()) {
      this.accuracy.set(value);
      this.load();
    }
  }

  protected load(): void {
    this.library.ignoredDuplicates().subscribe({
      next: ({ count }) => this.hiddenCount.set(count),
      error: () => this.hiddenCount.set(0),
    });
    this.loading.set(true);
    this.error.set(null);
    // Only the latest accuracy counts: files are deleted from these groups.
    const request = ++this.loadRequest;
    this.library.duplicates(this.accuracy()).subscribe({
      next: (groups) => {
        if (request !== this.loadRequest) {
          return;
        }
        this.groups.set(groups);
        this.loading.set(false);
      },
      error: () => {
        if (request !== this.loadRequest) {
          return;
        }
        this.loading.set(false);
        this.error.set("Couldn't ask Stash for duplicates. Check that Stash is running.");
      },
    });
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected askDelete(scene: DuplicateScene): void {
    this.pending.set([scene]);
  }

  /** The copy kept in this set: your pick, or else the suggested best one. */
  protected keeper(group: DuplicateGroup): string {
    const pick = this.chosen().get(group.suggestedKeepId);
    return pick && group.scenes.some((scene) => scene.id === pick) ? pick : group.suggestedKeepId;
  }

  /** Keep this copy rather than the suggested one; the best one can then go. */
  protected keepInstead(group: DuplicateGroup, scene: DuplicateScene): void {
    this.chosen.update((current) => new Map(current).set(group.suggestedKeepId, scene.id));
  }

  /** Every copy in this set but the one kept. */
  protected askDeleteExtras(group: DuplicateGroup): void {
    this.pending.set(this.extras(group));
  }

  /** Every copy but the one kept, in every set. */
  protected askDeleteAllExtras(): void {
    this.pending.set(this.groups().flatMap((group) => this.extras(group)));
  }

  protected readonly extraCount = () => this.groups().flatMap((group) => this.extras(group)).length;

  private extras(group: DuplicateGroup): DuplicateScene[] {
    const keep = this.keeper(group);
    return group.scenes.filter((scene) => scene.id !== keep);
  }

  /** You checked these and they aren't copies: hidden until the set changes. */
  protected notDuplicates(group: DuplicateGroup): void {
    const key = group.scenes.map((scene) => scene.id).join(',');
    if (this.hiding.has(key)) {
      return;
    }
    this.hiding.add(key);
    this.library.ignoreDuplicates(group.scenes.map((scene) => scene.id)).subscribe({
      next: () => {
        this.hiding.delete(key);
        this.groups.update((groups) => groups.filter((other) => other !== group));
        this.hiddenCount.update((count) => count + 1);
        this.notifications.success('Hidden', 'It shows again if a copy is added or removed.');
      },
      error: () => {
        this.hiding.delete(key);
        this.notifications.error("Couldn't hide that set", 'Try again in a moment.');
      },
    });
  }

  protected showHidden(): void {
    this.library.clearIgnoredDuplicates().subscribe({
      next: () => this.load(),
      error: () => this.notifications.error("Couldn't show them again", 'Try again in a moment.'),
    });
  }

  protected cancelDelete(): void {
    if (!this.deleting()) {
      this.pending.set(null);
    }
  }

  /**
   * Scenes with more than one file: deleting one from disk would delete its
   * other files too, so they're only ever removed from Stash here.
   */
  protected multiFile(scenes: DuplicateScene[] | null): DuplicateScene[] {
    return (scenes ?? []).filter((scene) => (scene.fileCount ?? 1) > 1);
  }

  protected pendingBytes(): number {
    return (this.pending() ?? []).reduce((sum, scene) => sum + (scene.file?.size ?? 0), 0);
  }

  /** One at a time, so Stash isn't swamped and a failure stops the rest. */
  protected async confirmDelete(deleteFile: boolean): Promise<void> {
    const scenes = this.pending();
    if (!scenes?.length || this.deleting()) {
      return;
    }
    // A list asked for before or during the delete may still show what's gone.
    const loadAtStart = this.loading() ? -1 : this.loadRequest;
    this.deleting.set(true);
    this.progress.set(scenes.length > 1 ? { done: 0, total: scenes.length } : null);
    // Each copy's details go to the copy kept in its set, as chosen now.
    const keeperOf = new Map(
      this.groups().flatMap((group) => {
        const keep = this.keeper(group);
        return group.scenes
          .filter((scene) => scene.id !== keep)
          .map((scene) => [scene.id, keep] as const);
      }),
    );
    const removed = new Set<string>();
    const skipped = deleteFile ? this.multiFile(scenes) : [];
    let failed: DuplicateScene | null = null;
    for (const scene of scenes) {
      if (skipped.includes(scene)) {
        continue;
      }
      try {
        await firstValueFrom(
          this.library.deleteScene(
            scene.id,
            deleteFile,
            deleteFile,
            this.carryOver ? keeperOf.get(scene.id) : undefined,
          ),
        );
        removed.add(scene.id);
        this.progress.update((value) => (value ? { ...value, done: value.done + 1 } : value));
      } catch {
        failed = scene;
        break;
      }
    }
    this.deleting.set(false);
    this.progress.set(null);
    // After a failure the sheet stays open with what's left, to try again.
    this.pending.set(failed ? scenes.filter((scene) => !removed.has(scene.id)) : null);
    this.groups.update((groups) =>
      groups
        .map((group) => ({
          ...group,
          scenes: group.scenes.filter((entry) => !removed.has(entry.id)),
        }))
        .filter((group) => group.scenes.length > 1),
    );
    if (this.loadRequest !== loadAtStart) {
      this.load();
    }
    if (removed.size > 0) {
      const one = scenes.length === 1 ? scenes[0] : null;
      this.notifications.success(
        deleteFile ? 'Deleted' : 'Removed from Stash',
        one
          ? deleteFile
            ? `${one.file?.basename ?? one.title} was deleted.`
            : 'The file was left on disk.'
          : `${removed.size} ${removed.size === 1 ? 'copy' : 'copies'} ${deleteFile ? 'deleted' : 'removed, files left on disk'}.`,
      );
    }
    if (skipped.length > 0 && !failed) {
      this.notifications.info(
        `${skipped.length} left in place`,
        `${skipped.length === 1 ? 'Its scene has' : 'Their scenes have'} more than one file, and deleting from disk would delete them all. Remove ${skipped.length === 1 ? 'it' : 'them'} from Stash only, or delete the extra file in Stash.`,
      );
    }
    if (failed) {
      this.notifications.error(
        "Couldn't delete that scene",
        removed.size > 0
          ? `Stopped at ${failed.file?.basename ?? failed.title}. Check that Stash is running and try again.`
          : 'Check that Stash is running and try again.',
      );
    }
  }

  protected resolution(scene: DuplicateScene): string {
    const height = Math.min(scene.file?.width ?? 0, scene.file?.height ?? 0);
    if (!height) {
      return '—';
    }
    return height >= 2100
      ? '4K'
      : height >= 1400
        ? '1440p'
        : height >= 1000
          ? '1080p'
          : height >= 700
            ? '720p'
            : `${height}p`;
  }

  protected size(bytes: number | null | undefined): string {
    if (!bytes) {
      return '—';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  protected bitRate(bits: number | null | undefined): string {
    return bits ? `${(bits / 1_000_000).toFixed(1)} Mbps` : '—';
  }

  protected duration(seconds: number | null | undefined): string {
    if (!seconds) {
      return '—';
    }
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${(total % 60).toString().padStart(2, '0')}`;
  }
}
