import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { EMPTY, Subscription, catchError, interval, switchMap } from 'rxjs';
import {
  FixCounts,
  FixKind,
  LocalLibraryService,
  LocalSceneCard,
} from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const TABS: Array<{ kind: FixKind; label: string; hint: string }> = [
  {
    kind: 'unmatched',
    label: 'Not matched',
    hint: 'These scenes are not linked to StashDB yet. Identify asks Stash to look each one up and fill in the title, performers, studio and tags.',
  },
  {
    kind: 'untagged',
    label: 'No tags',
    hint: 'These scenes have no tags. Identify can add them, or open a scene and add tags yourself.',
  },
  {
    kind: 'unorganized',
    label: 'Not organized',
    hint: 'Scenes you haven’t marked as organized. Check each one and mark it done.',
  },
];

/** How often to check on an Identify started here. */
const JOB_POLL_MS = 3000;
const JOB_DONE = new Set(['FINISHED', 'CANCELLED', 'FAILED']);

/** A to-do list for your library: scenes that need matching, tags or a check. */
@Component({
  selector: 'app-fix-library-page',
  imports: [RouterLink],
  templateUrl: './fix-library-page.component.html',
  styleUrls: ['./tools-shared.scss', './fix-library-page.component.scss'],
})
export class FixLibraryPageComponent implements OnInit, OnDestroy {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  /** The list to open: ?list= from the Library tools counts, else Not matched. */
  protected readonly kind = signal<FixKind>(
    listFromQuery(inject(ActivatedRoute, { optional: true })),
  );
  protected readonly counts = signal<FixCounts | null>(null);
  protected readonly items = signal<LocalSceneCard[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMore = signal(false);
  protected readonly busyIds = signal<ReadonlySet<string>>(new Set());
  protected readonly identifyingAll = signal(false);
  private page = 1;
  private loadRequest = 0;
  private countsRequest = 0;
  /** Identify jobs started here; the list reloads as each one ends. */
  private readonly watchedJobs = new Set<string>();
  private watch: Subscription | null = null;

  ngOnInit(): void {
    this.refreshCounts();
    this.load(1);
  }

  ngOnDestroy(): void {
    this.watch?.unsubscribe();
  }

  protected hint(): string {
    return TABS.find((tab) => tab.kind === this.kind())?.hint ?? '';
  }

  protected select(kind: FixKind): void {
    if (kind !== this.kind()) {
      this.kind.set(kind);
      this.refreshCounts();
      this.load(1);
    }
  }

  protected loadMore(): void {
    this.load(this.page + 1);
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  protected identify(item: LocalSceneCard): void {
    this.setBusy(item.id, true);
    this.library.identify([item.id]).subscribe({
      next: (result) => {
        this.setBusy(item.id, false);
        this.followJob(result?.jobId);
        this.notifications.success(
          'Identifying in Stash',
          `${item.title} is being looked up. It drops off this list once it's matched.`,
        );
      },
      error: (error: { error?: { message?: string } }) => {
        this.setBusy(item.id, false);
        this.notifications.error(
          "Couldn't start Identify",
          error?.error?.message ?? 'Check that Stash is running.',
        );
      },
    });
  }

  protected identifyPage(): void {
    const ids = this.items().map((item) => item.id);
    if (ids.length === 0) {
      return;
    }
    this.identifyingAll.set(true);
    this.library.identify(ids).subscribe({
      next: (result) => {
        this.identifyingAll.set(false);
        this.followJob(result?.jobId);
        this.notifications.success(
          'Identifying in Stash',
          `${ids.length} scenes are being looked up. Follow along in Stash jobs.`,
        );
      },
      error: (error: { error?: { message?: string } }) => {
        this.identifyingAll.set(false);
        this.notifications.error(
          "Couldn't start Identify",
          error?.error?.message ?? 'Check that Stash is running.',
        );
      },
    });
  }

  protected markOrganized(item: LocalSceneCard): void {
    this.setBusy(item.id, true);
    this.library.updateScene(item.id, { organized: true }).subscribe({
      next: () => {
        this.setBusy(item.id, false);
        this.items.update((items) => items.filter((entry) => entry.id !== item.id));
        // A count already on its way was taken before this change.
        this.countsRequest += 1;
        this.counts.update((counts) =>
          counts ? { ...counts, unorganized: Math.max(0, counts.unorganized - 1) } : counts,
        );
      },
      error: () => {
        this.setBusy(item.id, false);
        this.notifications.error("Couldn't update Stash", 'Try again in a moment.');
      },
    });
  }

  protected isBusy(id: string): boolean {
    return this.busyIds().has(id);
  }

  /** keep: leave the list on screen until the new one arrives (a refresh, not a new tab). */
  private load(page: number, keep = false): void {
    const kind = this.kind();
    // Only the latest request counts: another tab, or a refresh after Identify.
    const request = ++this.loadRequest;
    this.loading.set(true);
    this.error.set(null);
    if (page === 1 && !keep) {
      this.items.set([]);
    }
    // Scenes marked done leave the server's list, so "Show more" carries on
    // right after the ones shown instead of asking for a page that has shifted.
    const offset = page > 1 ? this.items().length : undefined;
    const request$ =
      offset === undefined
        ? this.library.fixScenes(kind, page)
        : this.library.fixScenes(kind, page, offset);
    request$.subscribe({
      next: (result) => {
        if (request !== this.loadRequest) {
          return;
        }
        this.page = page;
        this.items.update((items) => {
          if (page === 1) {
            return result.items;
          }
          const shown = new Set(items.map((item) => item.id));
          return [...items, ...result.items.filter((item) => !shown.has(item.id))];
        });
        this.hasMore.set(result.hasMore);
        this.loading.set(false);
      },
      error: () => {
        // A tab you've already left keeps its error to itself.
        if (request !== this.loadRequest) {
          return;
        }
        this.loading.set(false);
        this.error.set("Couldn't load this list. Check that Stash is running.");
      },
    });
  }

  /** Reloads the list and counts once Stash finishes an Identify started here. */
  private followJob(jobId: string | null | undefined): void {
    if (!jobId) {
      return;
    }
    this.watchedJobs.add(jobId);
    if (this.watch) {
      return;
    }
    this.watch = interval(JOB_POLL_MS)
      // A failed check (a blip, a restart) is skipped, not the end of watching.
      .pipe(switchMap(() => this.library.jobs().pipe(catchError(() => EMPTY))))
      .subscribe((jobs) => {
        const active = new Set(
          jobs.filter((job) => !JOB_DONE.has(job.status)).map((job) => job.id),
        );
        const ended = [...this.watchedJobs].filter((id) => !active.has(id));
        if (ended.length === 0) {
          return;
        }
        ended.forEach((id) => this.watchedJobs.delete(id));
        if (this.watchedJobs.size === 0) {
          this.watch?.unsubscribe();
          this.watch = null;
        }
        this.refreshCounts();
        this.load(1, true);
      });
  }

  private refreshCounts(): void {
    // Only the latest count counts: an older one was taken before a change.
    const request = ++this.countsRequest;
    this.library.fixCounts().subscribe({
      next: (counts) => {
        if (request === this.countsRequest) {
          this.counts.set(counts);
        }
      },
      error: () => {
        if (request === this.countsRequest) {
          this.counts.set(null);
        }
      },
    });
  }

  private setBusy(id: string, busy: boolean): void {
    this.busyIds.update((set) => {
      const next = new Set(set);
      if (busy) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }
}

function listFromQuery(route: ActivatedRoute | null): FixKind {
  const list = route?.snapshot?.queryParamMap?.get('list');
  return TABS.some((tab) => tab.kind === list) ? (list as FixKind) : 'unmatched';
}
