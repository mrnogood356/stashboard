import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { LocalSceneCard } from '../../core/api/local-library.service';
import { WatchLaterService } from '../../core/api/watch-later.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { PlayQueueService, shuffled } from '../../core/play-queue/play-queue.service';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';

/** Scenes saved to watch later: play them in order or shuffled, reorder, remove. */
@Component({
  selector: 'app-watch-later-page',
  imports: [RouterLink, SectionBackComponent],
  templateUrl: './watch-later-page.component.html',
  styleUrl: './watch-later-page.component.scss',
})
export class WatchLaterPageComponent implements OnInit {
  private readonly watchLater = inject(WatchLaterService);
  private readonly queue = inject(PlayQueueService);
  private readonly router = inject(Router);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly items = signal<LocalSceneCard[] | null>(null);
  protected readonly error = signal(false);
  protected readonly confirmingClear = signal(false);

  ngOnInit(): void {
    this.watchLater.list().subscribe({
      next: ({ items }) => this.items.set(items),
      error: () => this.error.set(true),
    });
  }

  protected duration(seconds: number | null): string {
    if (!seconds) {
      return '';
    }
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  }

  protected play(from = 0, shuffle = false): void {
    const items = this.items() ?? [];
    const ordered = shuffle ? shuffled(items) : items.slice(from);
    const first = this.queue.start({
      label: 'Watch later',
      kind: 'later',
      items: ordered.map((item) => ({
        sceneId: item.id,
        title: item.title,
        imageUrl: item.cardImageUrl ?? item.imageUrl,
      })),
    });
    if (first) {
      void this.router.navigate(['/watch', first.sceneId], {
        queryParams: { returnTo: '/watch-later' },
      });
    }
  }

  protected move(index: number, direction: -1 | 1): void {
    const items = [...(this.items() ?? [])];
    const to = index + direction;
    if (to < 0 || to >= items.length) {
      return;
    }
    [items[index], items[to]] = [items[to], items[index]];
    this.items.set(items);
    this.watchLater.reorder(items.map((item) => item.id)).subscribe({
      error: () => this.notifications.error("Couldn't save the order", 'Try again in a moment.'),
    });
  }

  protected remove(item: LocalSceneCard): void {
    this.items.update((items) => (items ?? []).filter((other) => other.id !== item.id));
    this.watchLater.remove(item.id).subscribe({
      error: () => this.notifications.error("Couldn't remove it", 'Try again in a moment.'),
    });
  }

  protected clear(): void {
    if (!this.confirmingClear()) {
      this.confirmingClear.set(true);
      return;
    }
    this.confirmingClear.set(false);
    this.watchLater.clear().subscribe({
      next: () => this.items.set([]),
      error: () => this.notifications.error("Couldn't clear the list", 'Try again in a moment.'),
    });
  }
}
