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
  WhisparrImportItem,
  WhisparrImports,
} from '../../core/api/download-handoff.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { HANDOFF_STEPS, fileSize, relativeTime, stageLabel, stepIndex } from './processing.format';
import { SectionBackComponent } from '../../shared/section-back/section-back.component';
import { Stage, timeLeftText } from '../../shared/stage-track/stage-track';
import { StageTrackComponent } from '../../shared/stage-track/stage-track.component';

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
  imports: [SectionBackComponent, RouterLink, StageTrackComponent],
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
  protected readonly whisparr = signal<WhisparrImports | null>(null);
  /** The queue entry whose Remove is waiting for a second tap. */
  protected readonly confirmRemove = signal<number | null>(null);

  protected readonly watch = computed(() => this.data()?.dropIns.watch ?? null);
  /** "47% · 8 min left", in the same words as Requests. */
  protected progressText(progress: number | null, timeLeft: string | null): string {
    const parts: string[] = [];
    if (progress !== null) {
      parts.push(`${progress}%`);
    }
    const left = timeLeftText(timeLeft);
    if (left) {
      parts.push(left);
    }
    return parts.join(' · ');
  }

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

  /** Has Whisparr import it the way its own Manual Import does. */
  protected importFromWhisparr(item: WhisparrImportItem): void {
    const key = `whisparr-${item.queueId}`;
    this.busy.set(key);
    this.api.importFromWhisparr(item.queueId).subscribe({
      next: (imports) => {
        this.busy.set(null);
        this.whisparr.set(imports);
        const name = item.movieTitle ?? item.title;
        this.notifications.success(
          imports.importState === 'done'
            ? `Whisparr imported “${name}”`
            : `Whisparr is importing “${name}”`,
        );
      },
      error: (error: { error?: { message?: string } }) => {
        this.busy.set(null);
        this.notifications.error('Couldn’t import it', error?.error?.message ?? 'Try again.');
      },
    });
  }

  /** First tap asks, second removes it from Whisparr's queue and the download client. */
  protected removeFromWhisparr(item: WhisparrImportItem): void {
    if (this.confirmRemove() !== item.queueId) {
      this.confirmRemove.set(item.queueId);
      return;
    }
    this.confirmRemove.set(null);
    const key = `whisparr-${item.queueId}`;
    this.busy.set(key);
    this.api.removeFromWhisparr(item.queueId, true).subscribe({
      next: (imports) => {
        this.busy.set(null);
        this.whisparr.set(imports);
      },
      error: (error: { error?: { message?: string } }) => {
        this.busy.set(null);
        this.notifications.error('Couldn’t remove it', error?.error?.message ?? 'Try again.');
      },
    });
  }

  protected clearHandoff(entry: ProcessingHandoff): void {
    this.busy.set(entry.id);
    this.run(this.api.clearHandoff(entry.id), {
      done: () => this.busy.set(null),
      failed: 'Couldn’t clear it',
    });
  }

  protected clearDropIn(entry: ProcessingDropIn): void {
    this.busy.set(entry.id);
    this.run(this.api.clearDropIn(entry.id), {
      done: () => this.busy.set(null),
      failed: 'Couldn’t clear it',
    });
  }

  /** Clears every finished and failed download; ones on their way stay. */
  protected clearHistory(): void {
    this.busy.set('history');
    this.run(this.api.clearHistory(), {
      done: () => this.busy.set(null),
      failed: 'Couldn’t clear the history',
      success: 'History cleared',
    });
  }

  protected readonly hasHistory = computed(
    () => (this.data()?.recentHandoffs.length ?? 0) + (this.data()?.dropIns.recent.length ?? 0) > 0,
  );

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

  /**
   * A download's steps for the step track. A failure is shown where it
   * stopped: at Waiting for Stash once it was moved in, else at Downloading.
   */
  protected stages(entry: ProcessingHandoff): Stage[] {
    const failed = entry.stage === 'failed';
    const at = failed
      ? stepIndex(entry.finalPath ? 'linking' : 'downloading')
      : stepIndex(entry.stage);
    const finished = entry.stage === 'done';
    return this.steps.map((step, index) => ({
      label: step.label,
      state:
        index < at || (finished && index <= at)
          ? 'done'
          : index === at
            ? failed
              ? 'failed'
              : 'current'
            : 'todo',
    }));
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
    // Whisparr is asked at most every 20 s by the server; errors keep what's shown.
    this.api.whisparrImports().subscribe({
      next: (imports) => this.whisparr.set(imports),
      error: () => undefined,
    });
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
