import { DOCUMENT } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import {
  DownloadHandoffApiService,
  DropInWatchStatus,
  Processing,
  ProcessingDropIn,
  ProcessingHandoff,
} from '../../core/api/download-handoff.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { HANDOFF_STEPS, fileSize, relativeTime, stageLabel, stepIndex } from './processing.format';

/** How often the page refreshes while it's on screen. */
const POLL_MS = 5_000;

const WATCH_LABELS: Record<DropInWatchStatus['state'], string> = {
  watching: 'Watching',
  off: 'Off',
  problem: 'Can’t watch',
};

/**
 * Processing: everything on its way into the library in one place. Downloads
 * sent to SABnzbd, from queued to linked, and files dropped into SABnzbd's
 * folder, with whether that folder is being watched and why not. Refreshes
 * every few seconds while it's on screen.
 */
@Component({
  selector: 'app-processing-page',
  imports: [RouterLink],
  templateUrl: './processing-page.component.html',
  styleUrls: ['../tools/tools-shared.scss', './processing-page.component.scss'],
})
export class ProcessingPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(DownloadHandoffApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly document = inject(DOCUMENT);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: Subscription | null = null;
  private destroyed = false;
  private readonly visibilityHandler = () => {
    if (this.document.visibilityState === 'visible') {
      this.refresh();
    } else {
      this.stop();
    }
  };

  protected readonly steps = HANDOFF_STEPS;
  protected readonly data = signal<Processing | null>(null);
  protected readonly loadError = signal(false);
  protected readonly checking = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly now = signal(Date.now());

  protected readonly watch = computed(() => this.data()?.dropIns.watch ?? null);
  protected readonly watchLabel = computed(() => {
    const watch = this.watch();
    return watch ? WATCH_LABELS[watch.state] : '';
  });
  protected readonly failedDropIns = computed(
    () => this.data()?.dropIns.recent.filter((entry) => entry.status === 'failed') ?? [],
  );
  protected readonly broughtIn = computed(
    () => this.data()?.dropIns.recent.filter((entry) => entry.status !== 'failed') ?? [],
  );

  ngOnInit(): void {
    this.document.addEventListener('visibilitychange', this.visibilityHandler);
    this.refresh();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.stop();
  }

  protected checkNow(): void {
    if (this.checking()) {
      return;
    }
    this.checking.set(true);
    this.run(this.api.checkDropIns(), {
      done: () => this.checking.set(false),
      failed: 'Couldn’t check the folder',
    });
  }

  protected retryHandoff(entry: ProcessingHandoff): void {
    this.busy.set(entry.id);
    this.run(this.api.retryHandoff(entry.id), {
      done: () => this.busy.set(null),
      failed: 'Couldn’t try it again',
      success: `Trying “${entry.releaseTitle}” again`,
    });
  }

  protected retryDropIn(entry: ProcessingDropIn): void {
    this.busy.set(entry.id);
    this.run(this.api.retryDropIn(entry.id), {
      done: () => this.busy.set(null),
      failed: 'Couldn’t try it again',
      success: `Trying “${entry.name}” again`,
    });
  }

  /** Stops watching one download; nothing in SABnzbd or on disk changes. */
  protected ignore(entry: ProcessingHandoff): void {
    this.busy.set(entry.id);
    this.api.ignore(entry.id).subscribe({
      next: () => {
        this.busy.set(null);
        this.refresh();
      },
      error: () => {
        this.busy.set(null);
        this.notifications.error('Couldn’t stop watching it', 'Try again.');
      },
    });
  }

  protected stageLabel = stageLabel;
  protected fileSize = fileSize;

  protected ago(iso: string | null): string | null {
    return relativeTime(iso, this.now());
  }

  /** The step a download is on, for the step dots: done, current or not yet. */
  protected stepState(entry: ProcessingHandoff, index: number): 'done' | 'current' | 'todo' {
    const at = stepIndex(entry.stage);
    return index < at ? 'done' : index === at ? 'current' : 'todo';
  }

  private run(
    request: Observable<Processing>,
    options: { done: () => void; failed: string; success?: string },
  ): void {
    request.subscribe({
      next: (data) => {
        options.done();
        this.apply(data);
        if (options.success) {
          this.notifications.success(options.success);
        }
      },
      error: (error: { error?: { message?: string } }) => {
        options.done();
        this.notifications.error(options.failed, error?.error?.message ?? 'Try again.');
      },
    });
  }

  private refresh(): void {
    this.stop();
    this.request = this.api.processing().subscribe({
      next: (data) => {
        this.apply(data);
        this.schedule();
      },
      error: () => {
        this.loadError.set(true);
        this.schedule();
      },
    });
  }

  private apply(data: Processing): void {
    this.data.set(data);
    this.loadError.set(false);
    this.now.set(Date.now());
  }

  private schedule(): void {
    if (this.destroyed || this.document.visibilityState === 'hidden') {
      return;
    }
    this.timer = setTimeout(() => this.refresh(), POLL_MS);
  }

  private stop(): void {
    this.request?.unsubscribe();
    this.request = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
