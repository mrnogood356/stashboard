import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LocalLibraryService, SampleScene } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

type ShorterThan = 0 | 1 | 2 | 5;

const LENGTHS: Array<{ value: ShorterThan; label: string }> = [
  { value: 0, label: 'Named sample' },
  { value: 1, label: 'Or under 1 min' },
  { value: 2, label: 'Or under 2 min' },
  { value: 5, label: 'Or under 5 min' },
];

/**
 * Sample clips left over from downloads: "sample" in the file or folder
 * name, and optionally anything very short. Remove them one at a time or
 * all at once, from Stash only or from disk too.
 */
@Component({
  selector: 'app-samples-page',
  imports: [RouterLink],
  templateUrl: './samples-page.component.html',
  styleUrls: [
    './tools-shared.scss',
    './duplicates-page.component.scss',
    './samples-page.component.scss',
  ],
})
export class SamplesPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly router = inject(Router);

  protected readonly lengthOptions = LENGTHS;
  protected readonly shorterThan = signal<ShorterThan>(0);
  protected readonly samples = signal<SampleScene[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  /** The scenes the delete sheet is open for: one, or every one shown. */
  protected readonly pending = signal<SampleScene[] | null>(null);
  protected readonly deleting = signal(false);
  protected readonly progress = signal(0);
  protected readonly totalSize = computed(() =>
    this.samples().reduce((sum, scene) => sum + (scene.file?.size ?? 0), 0),
  );
  private loadRequest = 0;

  ngOnInit(): void {
    this.load();
  }

  protected setShorterThan(value: ShorterThan): void {
    if (value !== this.shorterThan()) {
      this.shorterThan.set(value);
      this.load();
    }
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    // Only the latest choice counts: files are deleted from this list.
    const request = ++this.loadRequest;
    this.library.samples(this.shorterThan()).subscribe({
      next: (samples) => {
        if (request !== this.loadRequest) {
          return;
        }
        this.samples.set(samples);
        this.loading.set(false);
      },
      error: () => {
        if (request !== this.loadRequest) {
          return;
        }
        this.loading.set(false);
        this.error.set("Couldn't ask Stash for sample files. Check that Stash is running.");
      },
    });
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected askDelete(scenes: SampleScene[]): void {
    if (scenes.length > 0) {
      this.pending.set(scenes);
    }
  }

  protected cancelDelete(): void {
    if (!this.deleting()) {
      this.pending.set(null);
    }
  }

  /** One at a time, so a failure stops it with the rest left in the list. */
  protected async confirmDelete(deleteFile: boolean): Promise<void> {
    const scenes = this.pending();
    if (!scenes || this.deleting()) {
      return;
    }
    // A list asked for before or during the delete may still show what's gone.
    const loadAtStart = this.loading() ? -1 : this.loadRequest;
    this.deleting.set(true);
    this.progress.set(0);
    let removed = 0;
    for (const scene of scenes) {
      const ok = await new Promise<boolean>((resolve) =>
        this.library.deleteScene(scene.id, deleteFile).subscribe({
          next: () => resolve(true),
          error: () => resolve(false),
        }),
      );
      if (!ok) {
        this.notifications.error(
          `Couldn't remove ${scene.file?.basename ?? scene.title}`,
          'Check that Stash is running and try again.',
        );
        break;
      }
      removed += 1;
      this.progress.set(removed);
      this.samples.update((list) => list.filter((entry) => entry.id !== scene.id));
    }
    this.deleting.set(false);
    this.pending.set(null);
    if (removed > 0 && this.loadRequest !== loadAtStart) {
      this.load();
    }
    if (removed > 0) {
      this.notifications.success(
        deleteFile ? 'Deleted' : 'Removed from Stash',
        `${removed} ${removed === 1 ? 'sample' : 'samples'}${deleteFile ? '' : ' (files left on disk)'}.`,
      );
    }
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

  protected duration(seconds: number | null | undefined): string {
    if (!seconds) {
      return '—';
    }
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${(total % 60).toString().padStart(2, '0')}`;
  }

  protected folder(path: string | null | undefined): string {
    if (!path) {
      return '';
    }
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return index > 0 ? path.slice(0, index) : '';
  }
}
