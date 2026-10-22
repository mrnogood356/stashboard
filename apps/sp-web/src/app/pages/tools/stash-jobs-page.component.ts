import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { LibraryTask, LocalLibraryService, StashJob } from '../../core/api/local-library.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

interface TaskCard {
  task: LibraryTask;
  title: string;
  detail: string;
  icon: string;
  confirm?: string;
}

const TASKS: TaskCard[] = [
  {
    task: 'scan',
    title: 'Scan for new files',
    detail: 'Finds new and changed videos in your Stash folders.',
    icon: 'pi pi-search',
  },
  {
    task: 'generate',
    title: 'Generate',
    detail:
      'Makes thumbnails, preview clips, scrubber images and the fingerprints the duplicate finder needs.',
    icon: 'pi pi-images',
  },
  {
    task: 'identify',
    title: 'Identify',
    detail: 'Looks up every scene on StashDB and fills in details.',
    icon: 'pi pi-sparkles',
  },
  {
    task: 'auto-tag',
    title: 'Auto tag',
    detail: 'Adds performers, studios and tags whose names appear in file names.',
    icon: 'pi pi-tags',
  },
  {
    task: 'clean',
    title: 'Clean up',
    detail: 'Removes scenes whose files no longer exist on disk.',
    icon: 'pi pi-eraser',
    confirm:
      'Clean up removes every scene whose file is missing from disk (for example on an unplugged drive). Run it now?',
  },
];

const POLL_MS = 2000;
const IDLE_POLL_MS = 8000;

/** Run Stash's library tasks from your phone and watch their progress. */
@Component({
  selector: 'app-stash-jobs-page',
  imports: [RouterLink],
  templateUrl: './stash-jobs-page.component.html',
  styleUrls: ['./tools-shared.scss', './stash-jobs-page.component.scss'],
})
export class StashJobsPageComponent implements OnInit, OnDestroy {
  private readonly library = inject(LocalLibraryService);
  private readonly notifications = inject(AppNotificationsService);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The check on its way; a new one replaces it, so only one chain of checks runs. */
  private request: Subscription | null = null;
  private destroyed = false;

  protected readonly tasks = TASKS;
  protected readonly jobs = signal<StashJob[]>([]);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly starting = signal<LibraryTask | null>(null);

  ngOnInit(): void {
    this.poll();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.request?.unsubscribe();
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  protected start(card: TaskCard): void {
    if (card.confirm && !window.confirm(card.confirm)) {
      return;
    }
    this.starting.set(card.task);
    this.library.startJob(card.task).subscribe({
      next: () => {
        this.starting.set(null);
        this.notifications.success(`${card.title} started`, 'Follow its progress below.');
        this.poll();
      },
      error: (error: { error?: { message?: string } }) => {
        this.starting.set(null);
        this.notifications.error(
          `Couldn't start ${card.title}`,
          error?.error?.message ?? 'Check that Stash is running.',
        );
      },
    });
  }

  protected stop(job: StashJob): void {
    this.library.stopJob(job.id).subscribe({
      next: () => this.poll(),
      error: () =>
        this.notifications.error(
          `Couldn't stop ${job.description || 'that job'}`,
          'Check that Stash is running and try again.',
        ),
    });
  }

  protected percent(job: StashJob): number | null {
    return job.progress === null ? null : Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
  }

  protected statusLabel(job: StashJob): string {
    switch (job.status) {
      case 'RUNNING':
        return 'Running';
      case 'READY':
        return 'Waiting';
      case 'STOPPING':
        return 'Stopping';
      case 'FINISHED':
        return 'Done';
      case 'CANCELLED':
        return 'Cancelled';
      case 'FAILED':
        return 'Failed';
      default:
        return job.status.toLowerCase();
    }
  }

  private poll(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.request?.unsubscribe();
    this.request = this.library.jobs().subscribe({
      next: (jobs) => {
        this.jobs.set(jobs);
        this.loaded.set(true);
        this.error.set(null);
        this.schedule(jobs.length > 0 ? POLL_MS : IDLE_POLL_MS);
      },
      error: () => {
        this.loaded.set(true);
        this.error.set("Couldn't reach Stash to check its jobs.");
        this.schedule(IDLE_POLL_MS);
      },
    });
  }

  private schedule(delay: number): void {
    if (!this.destroyed) {
      this.timer = setTimeout(() => this.poll(), delay);
    }
  }
}
