import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActivityApiService, ActivityEntry, ActivityFile } from '../../core/api/activity.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

const KINDS: Array<{ id: string | null; label: string; icon: string }> = [
  { id: null, label: 'All', icon: 'pi pi-list' },
  { id: 'rename', label: 'Renames', icon: 'pi pi-pencil' },
  { id: 'delete', label: 'Deletes', icon: 'pi pi-trash' },
  { id: 'match', label: 'Matches', icon: 'pi pi-link' },
  { id: 'scan', label: 'Scans', icon: 'pi pi-refresh' },
  { id: 'whisparr', label: 'Whisparr', icon: 'pi pi-download' },
  { id: 'request', label: 'Requests', icon: 'pi pi-plus-circle' },
  { id: 'download', label: 'Downloads', icon: 'pi pi-cloud-download' },
  { id: 'automation', label: 'Automation', icon: 'pi pi-bolt' },
];

const ICONS: Record<string, string> = {
  rename: 'pi pi-pencil',
  undo: 'pi pi-undo',
  move: 'pi pi-arrow-right-arrow-left',
  cleanup: 'pi pi-eraser',
  delete: 'pi pi-trash',
  match: 'pi pi-link',
  scan: 'pi pi-refresh',
  whisparr: 'pi pi-download',
  request: 'pi pi-plus-circle',
  download: 'pi pi-cloud-download',
  automation: 'pi pi-bolt',
  setting: 'pi pi-cog',
};

const SEARCH_DELAY_MS = 350;

interface FilesState {
  items: ActivityFile[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  error: boolean;
}

/** Everything Stashboard did, newest first, with Undo where it can be undone. */
@Component({
  selector: 'app-activity-page',
  imports: [RouterLink],
  templateUrl: './activity-page.component.html',
  styleUrls: ['./tools-shared.scss', './activity-page.component.scss'],
})
export class ActivityPageComponent implements OnInit, OnDestroy {
  private readonly api = inject(ActivityApiService);
  private readonly notifications = inject(AppNotificationsService);

  protected readonly kinds = KINDS;
  protected readonly kind = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly items = signal<ActivityEntry[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMore = signal(false);
  protected readonly open = signal<ReadonlySet<string>>(new Set());
  protected readonly confirmUndo = signal<string | null>(null);
  protected readonly undoing = signal<string | null>(null);
  /** The files a run moved, once asked for. */
  protected readonly files = signal<Record<string, FilesState>>({});
  /** The latest request per entry, so a late answer can't reopen or overwrite a list. */
  private readonly filesRequest = new Map<string, number>();
  private page = 1;
  private request = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** The entries grouped by day, newest day first. */
  protected readonly days = computed(() => {
    const groups: Array<{ label: string; items: ActivityEntry[] }> = [];
    for (const item of this.items()) {
      const label = dayLabel(item.at);
      const last = groups[groups.length - 1];
      if (last?.label === label) {
        last.items.push(item);
      } else {
        groups.push({ label, items: [item] });
      }
    }
    return groups;
  });

  ngOnInit(): void {
    this.load(1);
  }

  ngOnDestroy(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
  }

  protected pickKind(kind: string | null): void {
    if (this.kind() === kind) {
      return;
    }
    this.kind.set(kind);
    this.load(1);
  }

  protected onSearch(value: string): void {
    this.query.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.load(1);
    }, SEARCH_DELAY_MS);
  }

  protected loadMore(): void {
    this.load(this.page + 1);
  }

  protected toggle(id: string): void {
    const next = new Set(this.open());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.open.set(next);
  }

  /** Show files / Hide files; a list closed while loading stays closed. */
  protected toggleFiles(entry: ActivityEntry): void {
    if (entry.id in this.files()) {
      this.forgetFiles(entry.id);
      return;
    }
    this.files.update((all) => ({
      ...all,
      [entry.id]: { items: [], page: 0, hasMore: false, loading: true, error: false },
    }));
    this.loadFiles(entry.id, 1);
  }

  protected moreFiles(id: string): void {
    const state = this.files()[id];
    if (state && !state.loading && state.hasMore) {
      this.patchFiles(id, { loading: true, error: false });
      this.loadFiles(id, state.page + 1);
    }
  }

  protected filesOf(id: string): FilesState | undefined {
    return this.files()[id];
  }

  private loadFiles(id: string, page: number): void {
    const token = (this.filesRequest.get(id) ?? 0) + 1;
    this.filesRequest.set(id, token);
    this.api.files(id, page).subscribe({
      next: (result) => {
        // Closed, or asked again, meanwhile: this answer is out of date.
        if (this.filesRequest.get(id) !== token || !(id in this.files())) {
          return;
        }
        this.patchFiles(id, {
          items: [...(page === 1 ? [] : (this.files()[id]?.items ?? [])), ...result.items],
          page: result.page,
          hasMore: result.hasMore,
          loading: false,
        });
      },
      error: () => {
        if (this.filesRequest.get(id) === token && id in this.files()) {
          this.patchFiles(id, { loading: false, error: true });
        }
      },
    });
  }

  private patchFiles(id: string, change: Partial<FilesState>): void {
    this.files.update((all) => (all[id] ? { ...all, [id]: { ...all[id], ...change } } : all));
  }

  private forgetFiles(id?: string): void {
    if (id === undefined) {
      this.filesRequest.clear();
      this.files.set({});
      return;
    }
    this.filesRequest.delete(id);
    this.files.update((all) => {
      const rest = { ...all };
      delete rest[id];
      return rest;
    });
  }

  /** Undo needs a second tap: it moves files back. */
  protected undo(entry: ActivityEntry): void {
    if (this.undoing()) {
      return;
    }
    if (this.confirmUndo() !== entry.id) {
      this.confirmUndo.set(entry.id);
      setTimeout(() => {
        if (this.confirmUndo() === entry.id) {
          this.confirmUndo.set(null);
        }
      }, 5000);
      return;
    }
    this.confirmUndo.set(null);
    this.undoing.set(entry.id);
    this.api.undo(entry.id).subscribe({
      next: (updated) => {
        this.undoing.set(null);
        this.items.update((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
        // Its moves are undone now: what was shown is out of date.
        this.forgetFiles(updated.id);
        this.notifications.success('Undone', 'The files are going back where they were.');
      },
      error: (error: { error?: { message?: string } }) => {
        this.undoing.set(null);
        this.notifications.error('Couldn’t undo', error?.error?.message ?? 'Try again.');
      },
    });
  }

  protected icon(kind: string): string {
    return ICONS[kind] ?? 'pi pi-circle';
  }

  protected time(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  private load(page: number): void {
    const request = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    if (page === 1) {
      this.items.set([]);
      this.forgetFiles();
    }
    this.api.list(page, { kind: this.kind(), q: this.query() }).subscribe({
      next: (result) => {
        if (request !== this.request) {
          return;
        }
        this.page = page;
        this.items.update((items) => (page === 1 ? result.items : [...items, ...result.items]));
        this.hasMore.set(result.hasMore);
        this.loading.set(false);
      },
      error: () => {
        if (request !== this.request) {
          return;
        }
        this.loading.set(false);
        this.error.set('Couldn’t load the activity. Try again in a moment.');
      },
    });
  }
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Earlier';
  }
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
