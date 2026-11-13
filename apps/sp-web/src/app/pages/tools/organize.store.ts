import { Injectable, Injector, OnDestroy, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, Observable, Subscription, catchError, interval, switchMap } from 'rxjs';
import {
  OrganizerApiService,
  OrganizerRun,
  OrganizerSettings,
  OrganizerSettingsUpdate,
} from '../../core/api/organizer.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { OrganizeListStore } from './organize-list.store';
import { OrganizeFilesStore } from './organize-files.store';
import { OrganizeTab, OrganizeDetail, OrganizeTool } from './organize.shared';

/**
 * Match scenes and Rename files, page-wide: settings, the tab, background runs and what
 * Overview counts. The page provides it with OrganizeListStore and
 * OrganizeFilesStore; each reaches the others through the page.
 */
@Injectable()
export class OrganizeStore implements OnDestroy {
  private readonly api = inject(OrganizerApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly injector = inject(Injector);
  private get list(): OrganizeListStore {
    return this.injector.get(OrganizeListStore);
  }

  private get files(): OrganizeFilesStore {
    return this.injector.get(OrganizeFilesStore);
  }

  readonly tab = signal<OrganizeTab>('overview');

  /** Matches found by name that wait for you on Review. */
  readonly waiting = signal(0);

  /** The Overview row that's open. */
  private readonly opened = signal<OrganizeDetail | null>(null);
  readonly settings = signal<OrganizerSettings | null>(null);
  readonly run = signal<OrganizerRun | null>(null);
  readonly error = signal<string | null>(null);
  readonly saving = signal<string | null>(null);

  private poll: Subscription | null = null;

  /** Match scenes or Rename files. */
  readonly tool = signal<OrganizeTool>('rename');

  /** Reads everything the page shows; the page calls this once it opens. */
  init(tool?: OrganizeTool): void {
    const requested = this.route.snapshot.queryParamMap.get('tab');
    // Without a tool from the route, the tab asked for says which.
    this.tool.set(tool ?? (requested === 'review' || requested === 'match' ? 'match' : 'rename'));
    this.tab.set(
      requested === 'settings' ? 'settings' : this.tool() === 'match' ? 'review' : 'overview',
    );
    if (requested === 'rename') {
      this.opened.set('rename');
    }
    if (this.tool() === 'match') {
      // From Fix my library: ?q= opens the scene list already searched.
      const query = this.route.snapshot.queryParamMap.get('q')?.trim();
      if (query) {
        this.list.listQuery.set(query);
        this.tab.set('review');
      }
      // ?scope=all: a scene that's matched, just to the wrong one.
      const scope = this.route.snapshot.queryParamMap.get('scope');
      if (scope === 'all' || scope === 'unlinked') {
        this.list.listScope.set(scope);
      }
      this.loadWaiting();
    }
    this.api.settings().subscribe({
      next: (settings) => {
        this.settings.set(settings);
        this.run.set(settings.run);
        this.files.pattern.set(settings.renamePattern);
        if (settings.run.running) {
          this.startPolling();
        }
        // To do counts what needs renaming, repairing and cleaning; its
        // tab shows the count from Settings too.
        if (this.tool() === 'rename') {
          this.files.loadPreview();
        }
      },
      error: (error: { error?: { message?: string } }) =>
        this.error.set(
          error?.error?.message ?? 'Couldn’t reach Stashboard. Try again in a moment.',
        ),
    });
    if (this.tool() === 'match') {
      this.list.loadScenes(1);
    }
  }

  select(tab: OrganizeTab): void {
    if (tab === this.tab()) {
      return;
    }
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      replaceUrl: true,
    });
    if (tab === 'overview' && (!this.files.preview() || this.files.renameStale)) {
      this.files.loadPreview();
    }
  }

  isOpen(detail: OrganizeDetail): boolean {
    return this.opened() === detail;
  }

  /** From Settings: the renames, open on the Overview. */
  openRename(): void {
    this.opened.set('rename');
    this.select('overview');
  }

  toggleOpen(detail: OrganizeDetail): void {
    this.opened.set(this.opened() === detail ? null : detail);
  }

  /** How many To do rows on Rename files need you. */
  readonly todoCount = computed(() => {
    const settings = this.settings();
    const preview = this.files.preview();
    return [
      this.files.stuckInWhisparr(),
      settings?.whisparrAvailable ? settings.missingInWhisparr : 0,
      this.files.repair()?.count ?? 0,
      this.files.relocation()?.count ?? 0,
      preview?.counts.ready ?? 0,
      preview ? this.files.actionableSkips(preview) : 0,
      settings?.folderAccess ? (this.files.empty()?.count ?? 0) : 0,
    ].filter((count) => count > 0).length;
  });

  /** Still finding out what needs doing. */
  readonly checking = computed(
    () => !this.settings() || (this.files.previewing() && !this.files.preview()),
  );

  /** Matches waiting on Review; the list there keeps it current. */
  loadWaiting(): void {
    this.api.proposals?.().subscribe({
      next: (list) => this.waiting.set(list.length),
      error: () => undefined,
    });
  }

  currentUrl(): string {
    return this.router.url;
  }

  toggle(
    key:
      | 'renameAfterMatch'
      | 'moveUnmatched'
      | 'cleanEmptyFolders'
      | 'skipWhisparrFiles'
      | 'autoMatchNightly'
      | 'useStashScrapers'
      | 'sendToWhisparr'
      | 'addToWhisparr',
  ): void {
    const settings = this.settings();
    if (!settings || this.saving()) {
      return;
    }
    const update: OrganizerSettingsUpdate = { [key]: !settings[key] };
    this.settings.set({ ...settings, ...update });
    this.saving.set(key);
    this.api.update(update).subscribe({
      next: (saved) => {
        this.saving.set(null);
        this.settings.set(saved);
        if (key === 'skipWhisparrFiles') {
          this.files.loadPreview();
        }
      },
      error: () => {
        this.saving.set(null);
        // Put back only this switch: other settings may have been refreshed since.
        this.restore({ [key]: settings[key] });
        this.notifications.error('Couldn’t save', 'Try again in a moment.');
      },
    });
  }

  readonly tpdbEditing = signal(false);

  setImportMode(mode: 'move' | 'copy'): void {
    const settings = this.settings();
    if (!settings || settings.whisparrImportMode === mode || this.saving()) {
      return;
    }
    this.settings.set({ ...settings, whisparrImportMode: mode });
    this.saving.set('whisparrImportMode');
    this.api.update({ whisparrImportMode: mode }).subscribe({
      next: (saved) => {
        this.saving.set(null);
        this.settings.set(saved);
      },
      error: () => {
        this.saving.set(null);
        this.restore({ whisparrImportMode: settings.whisparrImportMode });
        this.notifications.error('Couldn’t save', 'Try again in a moment.');
      },
    });
  }

  moveUnmatchedNow(): void {
    this.api.moveUnmatched().subscribe({
      next: (run) => {
        this.run.set(run);
        this.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error(
          'Couldn’t start',
          error?.error?.message ?? 'Try again in a moment.',
        ),
    });
  }

  sendAllToWhisparr(): void {
    this.api.sendAllToWhisparr().subscribe({
      next: (run) => {
        this.run.set(run);
        this.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error(
          'Couldn’t start',
          error?.error?.message ?? 'Try again in a moment.',
        ),
    });
  }

  saveTpdbKey(value: string): void {
    this.saving.set('tpdbApiKey');
    this.api.update({ tpdbApiKey: value.trim() }).subscribe({
      next: (saved) => {
        this.saving.set(null);
        this.settings.set(saved);
        this.tpdbEditing.set(false);
        this.notifications.success(
          value.trim() ? 'ThePornDB added' : 'ThePornDB removed',
          value.trim() ? 'It’s searched after your other sources.' : '',
        );
      },
      error: (error: { error?: { message?: string } }) => {
        this.saving.set(null);
        this.notifications.error('Couldn’t save the key', error?.error?.message ?? 'Try again.');
      },
    });
  }

  hasTpdbSource(settings: OrganizerSettings): boolean {
    return settings.sources.some((source) => source.kind === 'tpdb');
  }

  sourceIcon(kind: 'catalog' | 'stash-box' | 'tpdb'): string {
    return kind === 'catalog' ? 'pi-star-fill' : kind === 'tpdb' ? 'pi-globe' : 'pi-database';
  }

  /** A run the found-matches list started (saving them). */
  followRun(run: OrganizerRun): void {
    this.run.set(run);
    this.startPolling();
  }

  startRun(request: Observable<OrganizerRun>): void {
    request.subscribe({
      next: (run) => {
        this.run.set(run);
        this.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error(
          'Couldn’t start',
          error?.error?.message ?? 'Try again in a moment.',
        ),
    });
  }

  undo(): void {
    this.api.undo().subscribe({
      next: (run) => {
        this.run.set(run);
        this.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error('Couldn’t undo', error?.error?.message ?? 'Try again.'),
    });
  }

  progress(run: OrganizerRun): number {
    return run.total > 0 ? Math.min(100, Math.round((run.processed / run.total) * 100)) : 0;
  }

  duration(seconds: number | null): string | null {
    if (!seconds) {
      return null;
    }
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  size(bytes: number | null): string | null {
    if (!bytes) {
      return null;
    }
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  when(iso: string | null): string {
    if (!iso) {
      return '';
    }
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Undoes an optimistic change to just these settings. */
  restore(previous: OrganizerSettingsUpdate): void {
    this.settings.update((current) => (current ? { ...current, ...previous } : current));
  }

  startPolling(): void {
    this.poll?.unsubscribe();
    this.poll = interval(2000)
      // A failed check (a blip, a restart) is skipped, not the end of polling.
      .pipe(switchMap(() => this.api.status().pipe(catchError(() => EMPTY))))
      .subscribe({
        next: (run) => {
          this.run.set(run);
          if (!run.running) {
            // Polling only follows a run, so this is it finishing: reload once.
            this.poll?.unsubscribe();
            this.poll = null;
            this.onRunFinished(run);
          }
        },
        error: () => undefined,
      });
  }

  private onRunFinished(run: OrganizerRun): void {
    if (run.message) {
      const titles = {
        match: 'Matching finished',
        undo: 'Undone',
        whisparr: 'Sent to Whisparr',
        rename: 'Renaming finished',
        unmatched: 'Unmatched files moved',
        sync: 'Synced with Whisparr',
      } as const;
      this.notifications.success(titles[run.kind ?? 'rename'], run.message);
    }
    this.api
      .settings()
      .subscribe({ next: (settings) => this.settings.set(settings), error: () => undefined });
    if (run.kind === 'match') {
      this.list.reviewKey.update((key) => key + 1);
      this.loadWaiting();
    }
    // Every run fills in scenes or moves files: reload the lists they change.
    if (this.tool() === 'match' && run.kind !== 'rename' && run.kind !== 'whisparr') {
      // Matching, moving unmatched files or putting files back change the list on Review.
      if (run.kind !== 'undo') {
        this.list.matches.set({});
      }
      this.list.loadScenes(1);
    }
    if (this.tool() === 'match') {
      return;
    }
    if (this.tab() === 'overview' || this.files.preview()) {
      this.files.loadPreview();
    } else {
      this.files.renameStale = true;
    }
  }

  ngOnDestroy(): void {
    this.poll?.unsubscribe();
  }
}
