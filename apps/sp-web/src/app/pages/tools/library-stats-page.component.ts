import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LibraryStats,
  LibraryStatsBucket,
  LocalLibraryService,
} from '../../core/api/local-library.service';
import { fileSize, relativeTime } from '../processing/processing.format';

/**
 * What the library is made of: size by resolution, codec and studio, the
 * biggest files, and about how much re-encoding older codecs would save.
 */
@Component({
  selector: 'app-library-stats-page',
  imports: [RouterLink],
  templateUrl: './library-stats-page.component.html',
  styleUrls: ['./tools-shared.scss', './library-stats-page.component.scss'],
})
export class LibraryStatsPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);

  protected readonly stats = signal<LibraryStats | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);

  protected readonly hours = computed(() => {
    const seconds = this.stats()?.duration ?? 0;
    return Math.round(seconds / 3600);
  });

  protected size = (bytes: number | null) => fileSize(bytes) ?? '—';

  ngOnInit(): void {
    this.load(false);
  }

  protected load(refresh: boolean): void {
    this.loading.set(true);
    this.error.set(false);
    this.library.stats(refresh).subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.loading.set(false);
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
      },
    });
  }

  /** A bar's length: its share of the biggest bucket in the list. */
  protected share(bucket: LibraryStatsBucket, list: LibraryStatsBucket[]): number {
    const most = Math.max(...list.map((entry) => entry.bytes), 1);
    return Math.max(1, Math.round((bucket.bytes / most) * 100));
  }

  /** Of the whole library, for the label. */
  protected percent(bytes: number): string {
    const total = this.stats()?.bytes ?? 0;
    if (!total) {
      return '0%';
    }
    const value = (bytes / total) * 100;
    return value < 1 ? '<1%' : `${Math.round(value)}%`;
  }

  protected checked(iso: string): string {
    return relativeTime(iso, Date.now()) ?? '';
  }
}
