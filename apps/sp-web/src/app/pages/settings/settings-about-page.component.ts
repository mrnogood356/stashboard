import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AboutApiService,
  AboutResponse,
  DiskHealth,
  HealthResponse,
  JobHealthStatus,
  UpdateCheckResponse,
} from '../../core/api/about.service';

type RowStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface HealthRow {
  id: string;
  title: string;
  status: RowStatus;
  summary: string;
  detail?: string;
}

const STATUS_ICON: Record<RowStatus, string> = {
  ok: 'pi pi-check-circle',
  warn: 'pi pi-exclamation-triangle',
  fail: 'pi pi-times-circle',
  skip: 'pi pi-minus-circle',
};

const JOB_STATUS: Record<JobHealthStatus, { status: RowStatus; label: string }> = {
  ok: { status: 'ok', label: 'Ran' },
  running: { status: 'ok', label: 'Running now' },
  warn: { status: 'warn', label: 'Worth a look' },
  failed: { status: 'fail', label: 'Failed' },
  off: { status: 'skip', label: 'Off' },
  never: { status: 'skip', label: 'Hasn’t run yet' },
};

/** Less free than this (or than 5% of the disk) is worth a warning. */
const LOW_DISK_BYTES = 10 * 1024 ** 3;
const COPIED_MS = 2_000;

/**
 * Which build is running (and whether main has newer changes), whether what
 * Stashboard depends on is working, and the last warnings and errors, with a
 * button to copy it all for a support message. Each part loads on its own,
 * so a slow integration or GitHub never holds up the rest.
 */
@Component({
  selector: 'app-settings-about-page',
  imports: [RouterLink],
  templateUrl: './settings-about-page.component.html',
  styleUrls: ['./settings-about-page.component.scss', './settings-shared.scss'],
})
export class SettingsAboutPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(AboutApiService);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly about = signal<AboutResponse | null>(null);
  protected readonly aboutError = signal(false);
  protected readonly update = signal<UpdateCheckResponse | null>(null);
  protected readonly health = signal<HealthResponse | null>(null);
  protected readonly healthError = signal(false);
  protected readonly checking = signal(false);
  protected readonly copied = signal(false);
  protected readonly copyFailed = signal(false);

  /** The repository the running image was built from; none for a local build. */
  protected readonly githubUrl = computed(() => {
    const repository = this.about()?.build.repository;
    return repository ? `https://github.com/${repository}` : null;
  });

  protected readonly rows = computed(() => {
    const health = this.health();
    return health ? healthRows(health) : [];
  });

  protected readonly problems = computed(
    () => this.rows().filter((row) => row.status === 'fail' || row.status === 'warn').length,
  );

  protected readonly updateLine = computed(() => updateText(this.update()));

  ngOnInit(): void {
    this.load();
    this.api.update().subscribe({
      next: (result) => this.update.set(result),
      error: () =>
        this.update.set({
          status: 'unknown',
          behindBy: null,
          reason: null,
          checkedAt: new Date().toISOString(),
        }),
    });
  }

  ngOnDestroy(): void {
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
    }
  }

  protected load(): void {
    this.aboutError.set(false);
    this.api.about().subscribe({
      next: (result) => this.about.set(result),
      error: () => this.aboutError.set(true),
    });
    this.checking.set(true);
    this.healthError.set(false);
    this.api.health().subscribe({
      next: (result) => {
        this.health.set(result);
        this.checking.set(false);
      },
      error: () => {
        this.healthError.set(true);
        this.checking.set(false);
      },
    });
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(supportText(this.about(), this.update(), this.health()));
      this.copyFailed.set(false);
      this.copied.set(true);
      if (this.copiedTimer) {
        clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_MS);
    } catch {
      this.copyFailed.set(true);
    }
  }

  protected statusIcon(status: RowStatus): string {
    return STATUS_ICON[status];
  }

  protected shortCommit(commit: string): string {
    return commit.slice(0, 7);
  }

  protected when(iso: string | null): string {
    return formatWhen(iso);
  }
}

/** Every part of health as one list, in the order it's shown and copied. */
export function healthRows(health: HealthResponse): HealthRow[] {
  const rows: HealthRow[] = [
    {
      id: 'database',
      title: 'Database',
      status: health.database.ok ? 'ok' : 'fail',
      summary: health.database.ok ? 'Working.' : 'Stashboard can’t reach its database.',
      detail: health.database.error ?? undefined,
    },
  ];
  for (const integration of health.integrations) {
    rows.push({
      id: `integration-${integration.type}`,
      title: integration.label,
      status: integration.reachable ? 'ok' : 'fail',
      summary: integration.reachable
        ? 'Reachable.'
        : `Not reachable${integration.lastOkAt ? ` (last worked ${formatWhen(integration.lastOkAt)})` : ''}.`,
      detail: integration.error
        ? `${integration.reachable ? 'Last error' : 'Error'}${integration.errorAt ? ` (${formatWhen(integration.errorAt)})` : ''}: ${integration.error}`
        : undefined,
    });
  }
  for (const disk of health.disks) {
    rows.push(diskRow(disk));
  }
  for (const job of health.jobs) {
    const { status, label } = JOB_STATUS[job.status] ?? JOB_STATUS.never;
    rows.push({
      id: `job-${job.id}`,
      title: job.label,
      status,
      summary: job.lastRunAt ? `${label} ${formatWhen(job.lastRunAt)}.` : `${label}.`,
      detail: job.message ?? undefined,
    });
  }
  return rows;
}

function diskRow(disk: DiskHealth): HealthRow {
  const base = { id: `disk-${disk.path}`, title: `${disk.label} disk` };
  if (disk.freeBytes === null || disk.totalBytes === null) {
    return {
      ...base,
      status: 'warn',
      summary: `Couldn’t read free space for ${disk.path}.`,
      detail: disk.error ?? undefined,
    };
  }
  const low =
    disk.freeBytes < LOW_DISK_BYTES ||
    (disk.totalBytes > 0 && disk.freeBytes / disk.totalBytes < 0.05);
  return {
    ...base,
    status: low ? 'warn' : 'ok',
    summary: `${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)} (${disk.path}).`,
  };
}

export function updateText(update: UpdateCheckResponse | null): string {
  if (!update) {
    return 'Checking for updates…';
  }
  switch (update.status) {
    case 'up-to-date':
      return 'Up to date with main.';
    case 'behind':
      return update.behindBy === 1
        ? '1 newer change on main.'
        : `${update.behindBy ?? 'Some'} newer changes on main.`;
    default:
      return 'Can’t check for updates.';
  }
}

/** Version, health and recent errors as plain text, for a support message. */
export function supportText(
  about: AboutResponse | null,
  update: UpdateCheckResponse | null,
  health: HealthResponse | null,
): string {
  const lines: string[] = ['Stashboard – About & health'];
  if (about) {
    const { build } = about;
    lines.push(
      `Version: ${build.version}`,
      `Commit: ${build.commit ?? 'local build'}`,
      `Built: ${build.builtAt ?? 'unknown'}`,
    );
  } else {
    lines.push('Version: couldn’t be read');
  }
  lines.push(
    `Updates: ${updateText(update)}${update?.reason ? ` ${update.reason}` : ''}`,
    '',
    'Health',
  );
  if (health) {
    lines.push(`Checked: ${health.checkedAt}`);
    for (const row of healthRows(health)) {
      lines.push(
        `- ${row.title}: ${row.status.toUpperCase()} – ${row.summary}${row.detail ? ` ${row.detail}` : ''}`,
      );
    }
  } else {
    lines.push('- Couldn’t be read');
  }
  lines.push('', 'Recent errors');
  const errors = about?.recentErrors ?? [];
  if (errors.length === 0) {
    lines.push('- None');
  }
  for (const entry of errors) {
    const where = entry.source === 'app' ? 'app' : (entry.context ?? 'server');
    lines.push(`- ${entry.at} ${entry.level.toUpperCase()} [${where}] ${entry.message}`);
  }
  lines.push('', `Browser: ${navigator.userAgent}`);
  return lines.join('\n');
}

function formatWhen(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
