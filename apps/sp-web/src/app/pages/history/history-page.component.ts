import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { LocalLibraryService, type LocalSceneCard } from '../../core/api/local-library.service';
import { SceneCardComponent } from '../../shared/scene-card/scene-card.component';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';

interface Day {
  label: string;
  items: LocalSceneCard[];
}

/** What you've played, latest first, by the day you last played it. */
@Component({
  selector: 'app-history-page',
  imports: [SceneCardComponent, SectionBackComponent],
  templateUrl: './history-page.component.html',
  styleUrl: './history-page.component.scss',
})
export class HistoryPageComponent implements OnInit {
  private readonly library = inject(LocalLibraryService);

  protected readonly items = signal<LocalSceneCard[]>([]);
  protected readonly total = signal(0);
  protected readonly loading = signal(true);
  protected readonly error = signal(false);
  protected readonly hasMore = signal(false);
  private page = 1;

  protected readonly days = computed<Day[]>(() => groupByDay(this.items(), new Date()));

  ngOnInit(): void {
    this.load();
  }

  protected more(): void {
    this.page += 1;
    this.load();
  }

  protected playedAt(item: LocalSceneCard): string {
    if (!item.lastPlayedAt) {
      return '';
    }
    const date = new Date(item.lastPlayedAt);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  private load(): void {
    this.loading.set(true);
    this.library.history(this.page).subscribe({
      next: (page) => {
        this.items.update((items) => [...items, ...page.items]);
        this.total.set(page.total);
        this.hasMore.set(page.hasMore);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.error.set(true);
      },
    });
  }
}

/** Today, Yesterday, then the weekday this week, then the date. */
export function groupByDay(items: LocalSceneCard[], now: Date): Day[] {
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = startOf(now).getTime();
  const DAY = 86_400_000;
  const days: Day[] = [];
  for (const item of items) {
    const at = item.lastPlayedAt ? new Date(item.lastPlayedAt) : null;
    let label = 'Earlier';
    if (at && !Number.isNaN(at.getTime())) {
      const diff = Math.round((today - startOf(at).getTime()) / DAY);
      label =
        diff <= 0
          ? 'Today'
          : diff === 1
            ? 'Yesterday'
            : diff < 7
              ? at.toLocaleDateString([], { weekday: 'long' })
              : at.toLocaleDateString([], {
                  month: 'long',
                  day: 'numeric',
                  ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
                });
    }
    const last = days.at(-1);
    if (last?.label === label) {
      last.items.push(item);
    } else {
      days.push({ label, items: [item] });
    }
  }
  return days;
}
