import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { DiscoverService } from '../../core/api/discover.service';
import {
  SceneExplorerItem,
  SceneFavoritesFilter,
  SceneRequestContext,
} from '../../core/api/discover.types';
import { SceneRequestModalComponent } from '../../shared/scene-request-modal/scene-request-modal.component';
import { SceneStatusBadgeComponent } from '../../shared/scene-status-badge/scene-status-badge.component';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import {
  addMonths,
  dayKey,
  longDayLabel,
  monthGrid,
  monthLabel,
  monthRange,
  startOfMonth,
} from './calendar.model';

/** How many releases a day's square shows before "+3 more". */
const PER_CELL = 3;
const WHOSE_KEY = 'stashboard.calendar.whose';

const WHOSE_OPTIONS: readonly { value: SceneFavoritesFilter; label: string }[] = [
  { value: 'ALL', label: 'Both' },
  { value: 'STUDIO', label: 'Studios' },
  { value: 'PERFORMER', label: 'Performers' },
];

/**
 * Calendar: what the studios and performers you starred release, a month at
 * a time, with what you already have or requested marked. Nothing is
 * requested for you; Request is there when you want it.
 */
@Component({
  selector: 'app-calendar-page',
  imports: [
    RouterLink,
    SceneRequestModalComponent,
    SceneStatusBadgeComponent,
    SectionBackComponent,
    SkeletonComponent,
  ],
  templateUrl: './calendar-page.component.html',
  styleUrl: './calendar-page.component.scss',
})
export class CalendarPageComponent implements OnInit {
  private readonly discover = inject(DiscoverService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private request: Subscription | null = null;

  protected readonly weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  protected readonly whoseOptions = WHOSE_OPTIONS;
  protected readonly perCell = PER_CELL;

  protected readonly month = signal(startOfMonth(new Date()));
  protected readonly whose = signal<SceneFavoritesFilter>(readWhose());
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly items = signal<SceneExplorerItem[]>([]);
  protected readonly complete = signal(true);
  protected readonly selectedDay = signal<string | null>(null);

  protected readonly requestContext = signal<SceneRequestContext | null>(null);

  protected readonly title = computed(() => monthLabel(this.month()));
  protected readonly weeks = computed(() => monthGrid(this.month()));
  protected readonly isThisMonth = computed(
    () => dayKey(this.month()) === dayKey(startOfMonth(new Date())),
  );

  protected readonly byDay = computed(() => {
    const map = new Map<string, SceneExplorerItem[]>();
    for (const item of this.items()) {
      if (item.releaseDate) {
        const list = map.get(item.releaseDate) ?? [];
        list.push(item);
        map.set(item.releaseDate, list);
      }
    }
    return map;
  });

  /** Every day with releases, for the list (all of them on a phone). */
  protected readonly agenda = computed(() =>
    [...this.byDay().entries()].map(([key, scenes]) => ({
      key,
      label: longDayLabel(key),
      scenes,
      isToday: key === dayKey(new Date()),
    })),
  );

  protected readonly selectedAgenda = computed(() => {
    const day = this.selectedDay();
    return day ? this.agenda().filter((entry) => entry.key === day) : this.agenda();
  });

  protected readonly releaseCount = computed(() => this.items().length);

  ngOnInit(): void {
    this.load();
    this.destroyRef.onDestroy(() => this.request?.unsubscribe());
  }

  protected previousMonth(): void {
    this.month.update((month) => addMonths(month, -1));
    this.load();
  }

  protected nextMonth(): void {
    this.month.update((month) => addMonths(month, 1));
    this.load();
  }

  protected thisMonth(): void {
    this.month.set(startOfMonth(new Date()));
    this.load();
  }

  protected setWhose(value: SceneFavoritesFilter): void {
    if (value === this.whose()) {
      return;
    }
    this.whose.set(value);
    try {
      localStorage.setItem(WHOSE_KEY, value);
    } catch {
      // Private browsing: it just isn't remembered.
    }
    this.load();
  }

  protected scenesOn(key: string): SceneExplorerItem[] {
    return this.byDay().get(key) ?? [];
  }

  /** Tapping a day shows just its releases below; tapping it again shows them all. */
  protected selectDay(key: string): void {
    this.selectedDay.update((current) => (current === key ? null : key));
  }

  protected openRequest(item: SceneExplorerItem): void {
    this.requestContext.set({ id: item.id, title: item.title, imageUrl: item.imageUrl });
  }

  protected onRequestSubmitted(stashId: string): void {
    this.items.update((items) =>
      items.map((item) =>
        item.id === stashId
          ? { ...item, requestable: false, status: { state: 'REQUESTED' } }
          : item,
      ),
    );
  }

  protected returnTo(): string {
    return this.router.url;
  }

  protected statusClass(item: SceneExplorerItem): string {
    switch (item.status.state) {
      case 'AVAILABLE':
        return 'is-owned';
      case 'REQUESTED':
      case 'DOWNLOADING':
      case 'IMPORT_PENDING':
        return 'is-requested';
      case 'FAILED':
        return 'is-failed';
      default:
        return '';
    }
  }

  private load(): void {
    const { from, to } = monthRange(this.month());
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.selectedDay.set(null);
    this.request = this.discover.getCalendar(from, to, this.whose()).subscribe({
      next: (response) => {
        this.items.set(response.items);
        this.complete.set(response.complete);
        this.loading.set(false);
      },
      error: () => {
        this.items.set([]);
        this.error.set('Couldn’t load the calendar from the catalog. Try again in a moment.');
        this.loading.set(false);
      },
    });
  }

  protected retry(): void {
    this.load();
  }
}

function readWhose(): SceneFavoritesFilter {
  try {
    const saved = localStorage.getItem(WHOSE_KEY);
    return saved === 'STUDIO' || saved === 'PERFORMER' ? saved : 'ALL';
  } catch {
    return 'ALL';
  }
}
