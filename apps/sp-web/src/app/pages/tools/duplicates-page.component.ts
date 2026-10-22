import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
 * The best copy is marked; the others can be removed.
 */
@Component({
  selector: 'app-duplicates-page',
  imports: [RouterLink],
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
  /** The scene the delete sheet is open for. */
  protected readonly pending = signal<DuplicateScene | null>(null);
  protected readonly deleting = signal(false);
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
    this.pending.set(scene);
  }

  protected cancelDelete(): void {
    this.pending.set(null);
  }

  protected confirmDelete(deleteFile: boolean): void {
    const scene = this.pending();
    if (!scene || this.deleting()) {
      return;
    }
    // A list asked for before or during the delete may still show what's gone.
    const loadAtStart = this.loading() ? -1 : this.loadRequest;
    this.deleting.set(true);
    this.library.deleteScene(scene.id, deleteFile).subscribe({
      next: () => {
        this.deleting.set(false);
        this.pending.set(null);
        this.groups.update((groups) =>
          groups
            .map((group) => ({
              ...group,
              scenes: group.scenes.filter((entry) => entry.id !== scene.id),
            }))
            .filter((group) => group.scenes.length > 1),
        );
        if (this.loadRequest !== loadAtStart) {
          this.load();
        }
        this.notifications.success(
          deleteFile ? 'Deleted' : 'Removed from Stash',
          deleteFile
            ? `${scene.file?.basename ?? scene.title} was deleted.`
            : 'The file was left on disk.',
        );
      },
      error: () => {
        this.deleting.set(false);
        this.notifications.error(
          "Couldn't delete that scene",
          'Check that Stash is running and try again.',
        );
      },
    });
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
