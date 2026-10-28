import { NgTemplateOutlet } from '@angular/common';
import { SkeletonComponent } from '../../shared/skeleton/skeleton.component';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { finalize } from 'rxjs';
import { ButtonDirective } from 'primeng/button';
import { Message } from 'primeng/message';
import { IndexingService } from '../../core/api/indexing.service';
import {
  IndexingJobStatus,
  IndexingJobStatusResponse,
  IndexingStatusResponse,
  ManualIndexingSyncJob,
} from '../../core/api/indexing.types';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

interface JobDefinition {
  label: string;
  purpose: string;
  cadence: string;
  triggerJob: Exclude<ManualIndexingSyncJob, 'all'> | null;
}

interface FreshnessCheck {
  label: string;
  ok: boolean;
}

interface HealthSummary {
  label: string;
  tone: 'good' | 'warn' | 'info';
  description: string;
}

type IndexingJobView = IndexingJobStatusResponse & JobDefinition;

/** What each job keeps up to date, in plain words. Jobs with no button run on their own. */
const INDEXING_JOB_DEFINITIONS: Record<string, JobDefinition> = {
  'scene-index-whisparr-queue': {
    label: 'Downloads in Whisparr',
    purpose: 'What Whisparr is downloading and importing right now.',
    cadence: 'Every 30 seconds',
    triggerJob: 'queue',
  },
  'scene-index-whisparr-movies': {
    label: 'Scenes in Whisparr',
    purpose: 'Which scenes Whisparr has, and whether it has their files.',
    cadence: 'Every 15 minutes',
    triggerJob: 'movies',
  },
  'scene-index-library-projection': {
    label: 'Your Stash library',
    purpose: 'What is in Stash, for Library, Home and the “In library” badges.',
    cadence: 'Every 5 minutes, and within 30 seconds of a change in Stash',
    triggerJob: 'library',
  },
  'scene-index-metadata-backfill': {
    label: 'Scene details',
    purpose: 'Fills in titles, pictures and studios from the catalog where they are missing.',
    cadence: 'Every 10 seconds while some are missing, otherwise every 30 minutes',
    triggerJob: 'metadata',
  },
  'scene-index-bootstrap': {
    label: 'Start-up catch-up',
    purpose: 'Brings everything up to date when Stashboard starts.',
    cadence: 'On start-up and with Sync now',
    triggerJob: null,
  },
  'scene-index-request-rows': {
    label: 'Your requests',
    purpose: 'Applies what you requested to each scene’s status.',
    cadence: 'With every sync',
    triggerJob: null,
  },
  'scene-index-stash-availability': {
    label: 'In-library check',
    purpose: 'Marks catalog scenes you have in Stash.',
    cadence: 'With the Stash library sync',
    triggerJob: null,
  },
};

@Component({
  selector: 'app-indexing-settings-page',
  imports: [SkeletonComponent, ButtonDirective, Message, NgTemplateOutlet],
  templateUrl: './indexing-settings-page.component.html',
  styleUrls: ['./indexing-settings-page.component.scss', './settings-shared.scss'],
})
export class IndexingSettingsPageComponent implements OnInit {
  private readonly indexingService = inject(IndexingService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly actionSuccess = signal<string | null>(null);
  protected readonly status = signal<IndexingStatusResponse | null>(null);
  protected readonly triggeringAction = signal<ManualIndexingSyncJob | null>(null);

  protected readonly jobViews = computed<IndexingJobView[]>(() =>
    (this.status()?.jobs ?? []).map((job) => ({
      ...job,
      ...this.definitionForJob(job.jobName),
    })),
  );

  /** The ones you can run yourself, then the internal steps (behind Details). */
  protected readonly mainJobs = computed(() => this.jobViews().filter((job) => job.triggerJob));
  protected readonly internalJobs = computed(() =>
    this.jobViews().filter((job) => !job.triggerJob),
  );
  protected readonly staleChecks = computed(() =>
    this.freshnessChecks().filter((check) => !check.ok),
  );

  protected staleLabels(): string {
    return this.staleChecks()
      .map((check) => check.label.toLowerCase())
      .join(', ');
  }

  protected readonly freshnessChecks = computed<FreshnessCheck[]>(() => {
    const status = this.status();
    if (!status) {
      return [];
    }

    return [
      {
        label: 'Your requests',
        ok: status.freshness.requestRowsFresh,
      },
      {
        label: 'Scenes in Whisparr',
        ok: status.freshness.whisparrMoviesFresh,
      },
      {
        label: 'Your Stash library',
        ok: status.freshness.stashAvailabilityFresh,
      },
      {
        label: 'Status of new scenes',
        ok: status.freshness.canResolveUnknownScenesAsNotRequested,
      },
    ];
  });

  protected readonly healthSummary = computed<HealthSummary>(() => {
    const status = this.status();
    if (!status) {
      return {
        label: 'Unknown',
        tone: 'info',
        description: 'Indexing status is not loaded yet.',
      };
    }

    const failed = this.jobViews().filter((job) => job.status === 'FAILED');
    if (failed.length > 0) {
      return {
        label: 'Something failed',
        tone: 'warn',
        description: `${failed.map((job) => job.label).join(', ')} couldn’t refresh. See below.`,
      };
    }

    if (this.jobViews().some((job) => job.status === 'RUNNING')) {
      return {
        label: 'Syncing',
        tone: 'info',
        description: 'Something is refreshing right now.',
      };
    }

    if (
      status.freshness.requestRowsFresh &&
      status.freshness.whisparrMoviesFresh &&
      status.freshness.stashAvailabilityFresh
    ) {
      return {
        label: 'Up to date',
        tone: 'good',
        description: 'Requests, Library and each scene’s status are current.',
      };
    }

    return {
      label: 'Behind',
      tone: 'warn',
      description: 'Some of it hasn’t refreshed lately. Sync now catches it up.',
    };
  });

  ngOnInit(): void {
    this.loadStatus();
  }

  protected refreshStatus(): void {
    if (this.loading() || this.refreshing() || this.triggeringAction()) {
      return;
    }

    this.refreshing.set(true);
    this.actionError.set(null);

    this.indexingService
      .getStatus()
      .pipe(
        finalize(() => {
          this.refreshing.set(false);
        }),
      )
      .subscribe({
        next: (status) => {
          this.status.set(status);
        },
        error: () => {
          this.actionError.set('Failed to refresh indexing status.');
        },
      });
  }

  protected retryLoad(): void {
    if (this.loading() || this.triggeringAction()) {
      return;
    }

    this.loadStatus();
  }

  protected syncAll(): void {
    this.runSync('all', 'Sync All');
  }

  protected triggerJob(job: IndexingJobView): void {
    if (!job.triggerJob) {
      return;
    }

    this.runSync(job.triggerJob, job.label);
  }

  protected formatStatus(status: IndexingJobStatus): string {
    switch (status) {
      case 'RUNNING':
        return 'Running';
      case 'SUCCEEDED':
        return 'OK';
      case 'FAILED':
        return 'Failed';
      case 'IDLE':
      default:
        return 'Idle';
    }
  }

  protected formatDateTime(value: string | null, fallback = 'Never'): string {
    if (!value) {
      return fallback;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    // Today: just the time. Otherwise the day too; the year only when it differs.
    const now = new Date();
    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === now.toDateString()) {
      return time;
    }
    const day = date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });
    return `${day}, ${time}`;
  }

  protected formatDuration(value: number | null): string {
    if (value === null) {
      return 'n/a';
    }

    if (value < 1_000) {
      return `${value} ms`;
    }

    const totalSeconds = Math.round(value / 1_000);
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) {
      return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  protected formatCount(value: number | null): string {
    return value === null ? 'n/a' : value.toLocaleString();
  }

  protected formatRunReason(value: string | null): string {
    if (!value) {
      return 'n/a';
    }

    return value.replaceAll('-', ' ').replaceAll(':', ' / ');
  }

  protected isSyncAllDisabled(): boolean {
    return this.loading() || this.refreshing() || this.triggeringAction() !== null;
  }

  protected isJobTriggerDisabled(job: IndexingJobView): boolean {
    return (
      !job.triggerJob ||
      job.status === 'RUNNING' ||
      this.loading() ||
      this.refreshing() ||
      this.triggeringAction() !== null
    );
  }

  protected triggerLabel(job: IndexingJobView): string {
    return this.triggeringAction() === job.triggerJob ? 'Running…' : 'Run';
  }

  private loadStatus(): void {
    this.loading.set(true);
    this.loadError.set(null);

    this.indexingService
      .getStatus()
      .pipe(
        finalize(() => {
          this.loading.set(false);
        }),
      )
      .subscribe({
        next: (status) => {
          this.status.set(status);
        },
        error: () => {
          this.loadError.set('Failed to load indexing status from the API.');
        },
      });
  }

  private runSync(job: ManualIndexingSyncJob, label: string): void {
    if (this.triggeringAction() !== null) {
      return;
    }

    this.triggeringAction.set(job);
    this.actionError.set(null);
    this.actionSuccess.set(null);

    this.indexingService
      .sync(job)
      .pipe(
        finalize(() => {
          this.triggeringAction.set(null);
        }),
      )
      .subscribe({
        next: (status) => {
          this.status.set(status);
          this.actionSuccess.set(`${label} is up to date.`);
          this.notifications.success(`${label} finished`);
        },
        error: () => {
          this.actionError.set(`Couldn’t run ${label}. Try again.`);
          this.notifications.error(`Couldn’t run ${label}`);
        },
      });
  }

  private definitionForJob(jobName: string): JobDefinition {
    return (
      INDEXING_JOB_DEFINITIONS[jobName] ?? {
        label: this.humanizeJobName(jobName),
        purpose:
          'Background job details are available, but no specific description is defined yet.',
        cadence: 'Internal cadence',
        triggerJob: null,
      }
    );
  }

  private humanizeJobName(jobName: string): string {
    return jobName
      .replace(/^scene-index-/, '')
      .split('-')
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  }
}
