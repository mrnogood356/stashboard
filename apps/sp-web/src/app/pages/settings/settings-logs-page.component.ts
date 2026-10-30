import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import {
  LOG_LEVELS,
  LogEntry,
  LogFilesResponse,
  LogLevel,
  LogQuery,
  LogSettings,
  LogsApiService,
} from '../../core/api/logs.service';
import { formatBytes } from './settings-about-page.component';
import { copyText } from '../../core/clipboard/copy-text';

/** How often the live view asks for new entries. */
export const LIVE_INTERVAL_MS = 3_000;
const PAGE = 200;
const SEARCH_DELAY_MS = 300;
const COPIED_MS = 2_000;

export const LEVEL_LABEL: Record<LogLevel, string> = {
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
  debug: 'Debug',
  trace: 'Trace',
};

/** What each level adds, for the level picker. */
const LEVEL_HELP: Record<LogLevel, string> = {
  error: 'Only errors.',
  warn: 'Errors and warnings.',
  info: 'What Stashboard is doing. Recommended.',
  debug: 'Also every request and the details of each job. For tracking a problem down.',
  trace: 'Everything, including start-up and polling. Very chatty.',
};

/** The minimum-level filter: "Warn" shows warnings and errors. */
const FILTERS: Array<{ value: LogLevel; label: string }> = [
  { value: 'trace', label: 'All levels' },
  { value: 'debug', label: 'Debug and up' },
  { value: 'info', label: 'Info and up' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'error', label: 'Errors only' },
];

/**
 * Settings → Logs: Stashboard's recent log, newest first, filtered by level,
 * component and text, and updated live while the page is visible. Also
 * where the log level is set and the log files are downloaded.
 */
@Component({
  selector: 'app-settings-logs-page',
  templateUrl: './settings-logs-page.component.html',
  styleUrls: ['./settings-logs-page.component.scss', './settings-shared.scss'],
})
export class SettingsLogsPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(LogsApiService);
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private readonly onVisibility = () => {
    if (!document.hidden) {
      this.refreshNewest();
    }
  };

  protected readonly levels = LOG_LEVELS.map((value) => ({
    value,
    label: LEVEL_LABEL[value],
    help: LEVEL_HELP[value],
  }));
  protected readonly filters = FILTERS;

  // Settings
  protected readonly settings = signal<LogSettings | null>(null);
  protected readonly settingsError = signal(false);
  protected readonly saving = signal(false);
  protected readonly settingsStatus = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);
  protected readonly levelHelp = computed(() => {
    const level = this.settings()?.level;
    return level ? LEVEL_HELP[level] : '';
  });

  // Filters
  protected readonly minLevel = signal<LogLevel>('trace');
  protected readonly context = signal('');
  protected readonly search = signal('');
  protected readonly contexts = signal<string[]>([]);

  // Entries
  protected readonly entries = signal<LogEntry[]>([]);
  protected readonly hasMore = signal(false);
  protected readonly loading = signal(false);
  protected readonly loadingOlder = signal(false);
  protected readonly loadError = signal(false);
  protected readonly loggingAt = signal<LogLevel | null>(null);
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());
  protected readonly live = signal(true);
  protected readonly copiedId = signal<number | null>(null);
  protected readonly confirmingClear = signal(false);

  // Files
  protected readonly files = signal<LogFilesResponse | null>(null);
  protected readonly filesError = signal(false);

  protected readonly filtered = computed(
    () => this.minLevel() !== 'trace' || !!this.context() || !!this.search().trim(),
  );

  ngOnInit(): void {
    this.loadSettings();
    this.load();
    this.loadFiles();
    this.liveTimer = setInterval(() => this.refreshNewest(), LIVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    for (const timer of [this.searchTimer, this.copiedTimer]) {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
    }
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  // ---------- settings ----------

  protected loadSettings(): void {
    this.settingsError.set(false);
    this.api.settings().subscribe({
      next: (settings) => this.settings.set(settings),
      error: () => this.settingsError.set(true),
    });
  }

  protected setLevel(select: HTMLSelectElement): void {
    this.saveSettings({ level: select.value as LogLevel }, (saved) => {
      select.value = saved.level;
    });
  }

  protected setFileEnabled(input: HTMLInputElement): void {
    this.saveSettings({ fileEnabled: input.checked }, (saved) => {
      input.checked = saved.fileEnabled;
    });
  }

  /** Saves at once; on failure puts the control back the way it was. */
  private saveSettings(
    change: Partial<Pick<LogSettings, 'level' | 'fileEnabled'>>,
    revert: (previous: LogSettings) => void,
  ): void {
    const current = this.settings();
    if (!current) {
      return;
    }
    const next = { level: current.level, fileEnabled: current.fileEnabled, ...change };
    this.settings.set({ ...current, ...next });
    this.saving.set(true);
    this.settingsStatus.set(null);
    this.api.saveSettings(next).subscribe({
      next: (saved) => {
        this.settings.set(saved);
        this.saving.set(false);
        this.settingsStatus.set({ kind: 'ok', text: 'Saved. Applied right away.' });
        this.loggingAt.set(saved.level);
        this.loadFiles();
      },
      error: (error: unknown) => {
        this.settings.set(current);
        revert(current);
        this.saving.set(false);
        this.settingsStatus.set({
          kind: 'error',
          text: messageFrom(error, 'Couldn’t save the log settings.'),
        });
      },
    });
  }

  // ---------- entries ----------

  protected setMinLevel(level: string): void {
    this.minLevel.set(level as LogLevel);
    this.load();
  }

  protected setContext(context: string): void {
    this.context.set(context);
    this.load();
  }

  protected setSearch(text: string): void {
    this.search.set(text);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => this.load(), SEARCH_DELAY_MS);
  }

  protected clearFilters(): void {
    this.minLevel.set('trace');
    this.context.set('');
    this.search.set('');
    this.load();
  }

  protected toggleLive(): void {
    this.live.update((live) => !live);
    if (this.live()) {
      this.refreshNewest();
    }
  }

  /** The newest entries for the current filters, from the top again. */
  protected load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.api.list(this.query()).subscribe({
      next: (result) => {
        this.entries.set(result.entries);
        this.hasMore.set(result.hasMore);
        this.loggingAt.set(result.level);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set(true);
        this.loading.set(false);
      },
    });
    this.api.contexts().subscribe({
      next: (contexts) => this.contexts.set(contexts),
      error: () => undefined,
    });
  }

  protected loadOlder(): void {
    const oldest = this.entries().at(-1);
    if (!oldest) {
      return;
    }
    this.loadingOlder.set(true);
    this.api.list({ ...this.query(), before: oldest.id }).subscribe({
      next: (result) => {
        this.entries.update((entries) => [...entries, ...result.entries]);
        this.hasMore.set(result.hasMore);
        this.loadingOlder.set(false);
      },
      error: () => this.loadingOlder.set(false),
    });
  }

  /** Live view: adds what's new since the newest entry shown. Paused while the tab is hidden. */
  protected refreshNewest(): void {
    if (!this.live() || document.hidden || this.loading() || this.refreshing) {
      return;
    }
    this.refreshing = true;
    this.api.list(this.query()).subscribe({
      next: (result) => {
        this.refreshing = false;
        this.loggingAt.set(result.level);
        const newest = this.entries()[0]?.id ?? 0;
        const fresh = result.entries[0]?.id ?? 0;
        if (fresh < newest) {
          // Cleared, or Stashboard restarted: start over.
          this.entries.set(result.entries);
          this.hasMore.set(result.hasMore);
          return;
        }
        const added = result.entries.filter((entry) => entry.id > newest);
        if (added.length > 0) {
          this.entries.update((entries) => [...added, ...entries]);
        }
      },
      error: () => {
        this.refreshing = false;
      },
    });
  }

  protected clear(): void {
    if (!this.confirmingClear()) {
      this.confirmingClear.set(true);
      return;
    }
    this.confirmingClear.set(false);
    this.api.clear().subscribe({
      next: () => {
        this.entries.set([]);
        this.hasMore.set(false);
        this.load();
      },
      error: () => this.loadError.set(true),
    });
  }

  protected cancelClear(): void {
    this.confirmingClear.set(false);
  }

  protected toggle(id: number): void {
    this.expanded.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  protected async copy(entry: LogEntry): Promise<void> {
    try {
      await copyText(entryText(entry));
      this.copiedId.set(entry.id);
      if (this.copiedTimer) {
        clearTimeout(this.copiedTimer);
      }
      this.copiedTimer = setTimeout(() => this.copiedId.set(null), COPIED_MS);
    } catch {
      this.copiedId.set(null);
    }
  }

  // ---------- files ----------

  protected loadFiles(): void {
    this.filesError.set(false);
    this.api.files().subscribe({
      next: (files) => this.files.set(files),
      error: () => this.filesError.set(true),
    });
  }

  protected fileUrl(name: string): string {
    return this.api.fileUrl(name);
  }

  // ---------- display ----------

  protected levelLabel(entry: LogEntry): string {
    return entry.fatal ? 'Fatal' : LEVEL_LABEL[entry.level];
  }

  protected time(iso: string): string {
    return formatEntryTime(iso);
  }

  protected when(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }

  private query(): LogQuery {
    return {
      level: this.minLevel(),
      context: this.context() || undefined,
      q: this.search().trim() || undefined,
      limit: PAGE,
    };
  }
}

/** One entry as text, the way it appears in the log file. */
export function entryText(entry: LogEntry): string {
  const label = entry.fatal ? 'FATAL' : entry.level.toUpperCase();
  const where = entry.source === 'app' ? 'app' : (entry.context ?? 'server');
  return [`${entry.at} ${label} [${where}] ${entry.message}`, entry.stack]
    .filter(Boolean)
    .join('\n');
}

/** "14:03:22.481" today; with the date before that. */
export function formatEntryTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const time = `${date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
    if (Array.isArray(message) && typeof message[0] === 'string') {
      return message[0];
    }
  }
  return fallback;
}
