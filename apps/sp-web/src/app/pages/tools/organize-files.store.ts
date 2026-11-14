import { Injectable, Injector, OnDestroy, computed, inject, signal } from '@angular/core';
import {
  OrganizerApiService,
  OrganizerSettings,
  RenamePlan,
  RenamePreview,
  RenameState,
  WhisparrRepairPlan,
  WhisparrRepairScene,
  MissingInWhisparrScene,
} from '../../core/api/organizer.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { DownloadHandoffApiService } from '../../core/api/download-handoff.service';
import { explainRename, fileName, folderName, folderPath } from './explain-rename.util';
import { OrganizeStore } from './organize.store';
import { OrganizeListStore } from './organize-list.store';
import { SKIP_REASON, TOKEN_HELP, PREVIEW_DELAY_MS } from './organize.shared';

/** Rename files: the naming pattern, the rename preview and renames, folders, and Whisparr's folders. */
@Injectable()
export class OrganizeFilesStore implements OnDestroy {
  private readonly api = inject(OrganizerApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly downloads = inject(DownloadHandoffApiService);
  private readonly store = inject(OrganizeStore);

  private readonly injector = inject(Injector);
  private get list(): OrganizeListStore {
    return this.injector.get(OrganizeListStore);
  }

  /** Downloads stuck at Whisparr's import step (Downloads → Waiting in Whisparr). */
  readonly stuckInWhisparr = signal(0);

  /** In Stash, not in Whisparr: each scene and why it hasn't gone. */
  readonly missingInWhisparr = signal<MissingInWhisparrScene[] | null>(null);

  loadMissingInWhisparr(): void {
    this.api.missingInWhisparr?.().subscribe({
      next: (scenes) => this.missingInWhisparr.set(scenes),
      error: () => this.missingInWhisparr.set([]),
    });
  }

  /** Where a placeholder button adds to: the field last typed in. */
  lastPatternField: 'folder' | 'file' = 'file';

  readonly skipReason = SKIP_REASON;
  readonly tokenHelp = TOKEN_HELP;

  readonly pattern = signal('');
  readonly preview = signal<RenamePreview | null>(null);

  /** Why each listed file is being renamed, and which parts of its new name are new. */
  readonly changeReasons = computed(
    () =>
      new Map((this.preview()?.changes ?? []).map((plan) => [plan.sceneId, explainRename(plan)])),
  );

  readonly previewing = signal(false);
  readonly previewError = signal<string | null>(null);
  readonly confirmRename = signal(false);
  readonly showSkipped = signal(false);
  readonly fixingTaken = signal(false);

  /** The "taken" file waiting for a second tap before its copy is deleted. */
  readonly confirmTaken = signal<string | null>(null);

  /** The skip reason whose files are listed. */
  readonly openSkip = signal<RenameState | null>(null);

  readonly patternDirty = computed(() => {
    const saved = this.store.settings()?.renamePattern ?? '';
    return this.pattern().trim() !== saved;
  });

  /** The pattern the preview on screen was worked out for. */
  private readonly previewedPattern = signal<string | null>(null);

  /** Names come from Whisparr's naming, not a pattern typed here. */
  readonly followsWhisparr = computed(() => this.store.settings()?.naming?.source === 'whisparr');

  /** The pattern was edited since the preview: renaming now would use names nobody saw. */
  readonly previewOutdated = computed(
    () =>
      !this.followsWhisparr() &&
      this.preview() !== null &&
      this.previewedPattern() !== this.pattern().trim(),
  );

  private previewRequest = 0;

  /** A preview waits for a pause in typing. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;

  readonly previewQueued = signal(false);

  /** Scenes were matched or files moved while the Overview wasn't open. */
  renameStale = false;

  private relocationRequest = 0;

  private emptyRequest = 0;

  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  private loadStuckInWhisparr(): void {
    this.downloads.whisparrImports?.().subscribe({
      next: (imports) =>
        this.stuckInWhisparr.set(
          imports.configured && !imports.unreachable ? imports.items.length : 0,
        ),
      error: () => this.stuckInWhisparr.set(0),
    });
  }

  /**
   * Skips with a fix on the Overview (extra copies, taken names, files gone).
   * Whisparr's own files, files outside the library and unmatched scenes are
   * shown there too but aren't something to do.
   */
  actionableSkips(preview: RenamePreview): number {
    return (['copy', 'taken', 'gone'] as RenameState[]).reduce(
      (sum, state) => sum + (preview.counts[state] ?? 0),
      0,
    );
  }

  skippedTotal(preview: RenamePreview): number {
    return this.skipBreakdown(preview).reduce((sum, entry) => sum + entry.count, 0);
  }

  /** The biggest reasons, in a few words. */
  skipSummary(preview: RenamePreview): string {
    return this.skipBreakdown(preview)
      .slice(0, 2)
      .map((entry) => `${entry.label} (${entry.count})`)
      .join(' · ');
  }

  setRenameRoot(value: string): void {
    const settings = this.store.settings();
    if (!settings || settings.renameRoot === value) {
      return;
    }
    this.store.settings.set({ ...settings, renameRoot: value });
    this.store.saving.set('renameRoot');
    this.api.update({ renameRoot: value }).subscribe({
      next: (saved) => {
        this.store.saving.set(null);
        this.store.settings.set(saved);
        this.loadPreview();
      },
      error: (error: { error?: { message?: string } }) => {
        this.store.saving.set(null);
        this.store.restore({ renameRoot: settings.renameRoot });
        this.notifications.error('Couldn’t save', error?.error?.message ?? 'Try again.');
      },
    });
  }

  /** The pattern's folders, like Whisparr's Scene Folder Format: everything before the last /. */
  readonly folderPart = computed(() => {
    const parts = this.pattern().split('/');
    return parts.slice(0, -1).join('/');
  });

  /** The file name, like Whisparr's Standard Scene Format: after the last /. */
  readonly filePart = computed(() => this.pattern().split('/').pop() ?? '');

  setPattern(value: string): void {
    this.pattern.set(value);
    this.confirmRename.set(false);
    this.queuePreview();
  }

  setFolderFocus(): void {
    this.lastPatternField = 'folder';
  }

  setFileFocus(): void {
    this.lastPatternField = 'file';
  }

  setFolderPart(value: string): void {
    this.lastPatternField = 'folder';
    const folders = value.replace(/^\/+|\/+$/g, '');
    this.setPattern(folders ? `${folders}/${this.filePart()}` : this.filePart());
  }

  setFilePart(value: string): void {
    this.lastPatternField = 'file';
    // A file name has no folders; those go in the field above.
    const name = value.replace(/\//g, '');
    const folders = this.folderPart();
    this.setPattern(folders ? `${folders}/${name}` : name);
  }

  usePreset(pattern: string): void {
    this.setPattern(pattern);
    this.loadPreview();
  }

  readonly loadingWhisparrNaming = signal(false);

  /** Fills both fields from Whisparr's Scene Folder Format and Standard Scene Format. */
  useWhisparrNaming(): void {
    this.loadingWhisparrNaming.set(true);
    this.api.whisparrNaming().subscribe({
      next: (naming) => {
        this.loadingWhisparrNaming.set(false);
        if (!naming) {
          this.notifications.error(
            'Couldn’t read Whisparr’s naming',
            'Set up Whisparr in Settings → Integrations first.',
          );
          return;
        }
        if (!naming.pattern) {
          this.notifications.error(
            'Couldn’t use Whisparr’s naming',
            naming.problem ?? 'Try again.',
          );
          return;
        }
        this.usePreset(naming.pattern);
      },
      error: (error) => {
        this.loadingWhisparrNaming.set(false);
        this.notifications.error(
          'Couldn’t read Whisparr’s naming',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  readonly relocation = signal<{
    destination: string;
    count: number;
    examples: string[];
  } | null>(null);

  readonly confirmRelocate = signal(false);
  readonly repair = signal<WhisparrRepairPlan | null>(null);
  readonly showRepairScenes = signal(false);

  readonly repairAction: Record<WhisparrRepairScene['action'], string> = {
    move: 'Whisparr moves it, with its file',
    path: 'Missing in Whisparr: only its path changes',
    reimport: 'Imported again from where Stash has the file',
  };

  /** Whisparr's folders and the repair plan follow the saved pattern and folder. */
  loadRelocation(): void {
    // Only the latest answers count: an older one is for settings since changed.
    const request = ++this.relocationRequest;
    const set = <T>(target: { set(value: T): void }, value: T) => {
      if (request === this.relocationRequest) {
        target.set(value);
      }
    };
    this.api.whisparrRelocation?.().subscribe({
      next: (plan) => set(this.relocation, plan),
      error: () => set(this.relocation, null),
    });
    this.loadEmptyFolders();
    this.api.whisparrRepair?.().subscribe({
      next: (plan) => set(this.repair, plan),
      error: () => set(this.repair, null),
    });
  }

  readonly empty = signal<{
    available: boolean;
    count: number;
    folders: string[];
    galleries?: number;
    error?: string | null;
  } | null>(null);

  readonly confirmClean = signal(false);
  readonly cleaning = signal(false);

  loadEmptyFolders(): void {
    const request = ++this.emptyRequest;
    const set = (value: Parameters<typeof this.empty.set>[0]) => {
      if (request === this.emptyRequest) {
        this.empty.set(value);
      }
    };
    this.api.emptyFolders?.().subscribe({
      next: (result) => set(result),
      error: () => set(null),
    });
  }

  cleanFolders(): void {
    if (!this.confirmClean()) {
      this.confirmClean.set(true);
      setTimeout(() => this.confirmClean.set(false), 5000);
      return;
    }
    this.confirmClean.set(false);
    this.cleaning.set(true);
    this.api.cleanEmptyFolders().subscribe({
      next: (result) => {
        this.cleaning.set(false);
        this.notifications.success(
          'Cleaned up',
          `Removed ${result.removed} empty ${result.removed === 1 ? 'folder' : 'folders'}.`,
        );
        this.loadEmptyFolders();
      },
      error: (error: { error?: { message?: string } }) => {
        this.cleaning.set(false);
        this.notifications.error('Couldn’t clean up', error?.error?.message ?? 'Try again.');
        // Some may have gone before it stopped.
        this.loadEmptyFolders();
      },
    });
  }

  /** The folder typed into "Never remove". */
  readonly keepInput = signal('');

  /** Adds a folder to "Never remove": typed in, or from the empty-folder list. */
  keepFolder(folder = this.keepInput()): void {
    const settings = this.store.settings();
    const wanted = folder.trim();
    if (!settings || !wanted || this.store.saving()) {
      return;
    }
    if (!settings.keepFolders.includes(wanted)) {
      this.saveKeepFolders([...settings.keepFolders, wanted], () => this.keepInput.set(''));
    }
  }

  unkeepFolder(folder: string): void {
    const settings = this.store.settings();
    if (!settings || this.store.saving()) {
      return;
    }
    this.saveKeepFolders(settings.keepFolders.filter((kept) => kept !== folder));
  }

  private saveKeepFolders(keepFolders: string[], saved?: () => void): void {
    this.store.saving.set('keepFolders');
    this.api.update({ keepFolders }).subscribe({
      next: (result) => {
        this.store.saving.set(null);
        this.store.settings.set(result);
        saved?.();
        this.loadEmptyFolders();
      },
      error: (error: { error?: { message?: string } }) => {
        this.store.saving.set(null);
        this.notifications.error(
          'Couldn’t save',
          error?.error?.message ?? 'Try again in a moment.',
        );
      },
    });
  }

  /** Rescan, remove extra copies and link waiting scenes, in the background. */
  syncWithWhisparr(): void {
    this.store.startRun(this.api.syncWithWhisparr());
  }

  readonly renamingOne = signal<string | null>(null);

  /** Renames just this one scene from the preview list. */
  renameOne(sceneId: string): void {
    if (this.renamingOne() || this.previewOutdated()) {
      return;
    }
    this.renamingOne.set(sceneId);
    const start = () =>
      this.api.rename([sceneId]).subscribe({
        next: (result) => {
          this.renamingOne.set(null);
          const failed = result.failed[0];
          if (failed) {
            this.notifications.error('Couldn’t rename it', failed.reason);
          } else {
            this.notifications.success('Renamed', result.moved[0]?.to ?? 'Done.');
          }
          this.loadPreview();
        },
        error: (error: { error?: { message?: string } }) => {
          this.renamingOne.set(null);
          this.notifications.error('Couldn’t rename it', error?.error?.message ?? 'Try again.');
        },
      });
    // The server names it from the saved pattern: save the one previewed first.
    if (this.followsWhisparr() || !this.patternDirty()) {
      start();
      return;
    }
    const pattern = this.pattern().trim();
    this.api.update({ renamePattern: pattern }).subscribe({
      next: (saved) => {
        this.store.settings.set(saved);
        this.useSavedPattern(pattern, saved);
        start();
      },
      error: (error: { error?: { message?: string } }) => {
        this.renamingOne.set(null);
        this.notifications.error(
          'Couldn’t save the pattern',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  repairWhisparr(): void {
    this.api.repairWhisparr().subscribe({
      next: (run) => {
        this.store.run.set(run);
        this.store.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error(
          'Couldn’t start',
          error?.error?.message ?? 'Try again in a moment.',
        ),
    });
  }

  relocateWhisparr(): void {
    if (!this.confirmRelocate()) {
      this.confirmRelocate.set(true);
      setTimeout(() => this.confirmRelocate.set(false), 5000);
      return;
    }
    this.confirmRelocate.set(false);
    this.api.relocateWhisparr().subscribe({
      next: (run) => {
        this.store.run.set(run);
        this.store.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error(
          'Couldn’t start',
          error?.error?.message ?? 'Try again in a moment.',
        ),
    });
  }

  /** Works out names for the pattern now, and reloads what follows the saved settings. */
  loadPreview(): void {
    this.renameStale = false;
    this.loadStuckInWhisparr();
    this.loadRelocation();
    this.previewNames();
  }

  /** Just the names for the pattern as typed. */
  private previewNames(): void {
    this.cancelQueuedPreview();
    // Following Whisparr, the server uses its naming: nothing typed is sent.
    const pattern = this.followsWhisparr() ? '' : this.pattern().trim();
    this.previewing.set(true);
    this.previewError.set(null);
    this.confirmRename.set(false);
    // Only the latest request counts: an older, slower answer is for another pattern.
    const request = ++this.previewRequest;
    this.api.preview(pattern || undefined).subscribe({
      next: (preview) => {
        if (request !== this.previewRequest) {
          return;
        }
        this.previewing.set(false);
        this.preview.set(preview);
        this.previewedPattern.set(pattern);
      },
      error: (error: { error?: { message?: string } }) => {
        if (request !== this.previewRequest) {
          return;
        }
        this.previewing.set(false);
        this.previewError.set(
          error?.error?.message ?? 'Couldn’t work out new names. Check that Stash is running.',
        );
      },
    });
  }

  savePattern(): void {
    const pattern = this.pattern().trim();
    this.store.saving.set('renamePattern');
    this.api.update({ renamePattern: pattern }).subscribe({
      next: (saved) => {
        this.store.saving.set(null);
        this.store.settings.set(saved);
        this.useSavedPattern(pattern, saved);
        this.notifications.success('Pattern saved', 'New matches will use it.');
        // The repair plan and Whisparr's folders follow the saved pattern.
        this.loadPreview();
      },
      error: (error: { error?: { message?: string } }) => {
        this.store.saving.set(null);
        this.notifications.error(
          'Couldn’t save the pattern',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  readonly removingCopies = signal(false);
  readonly confirmRemoveCopies = signal(false);

  /** Deletes the extra copies (tap twice); each scene keeps its correctly named file. */
  removeExtraCopies(): void {
    if (this.removingCopies()) {
      return;
    }
    if (!this.confirmRemoveCopies()) {
      this.confirmRemoveCopies.set(true);
      setTimeout(() => this.confirmRemoveCopies.set(false), 5000);
      return;
    }
    this.confirmRemoveCopies.set(false);
    this.removingCopies.set(true);
    this.api.removeExtraCopies().subscribe({
      next: (result) => {
        this.removingCopies.set(false);
        const removed = `Removed ${result.removed} extra ${result.removed === 1 ? 'copy' : 'copies'}`;
        if (result.failed.length) {
          this.notifications.error(
            `${removed}, ${result.failed.length} couldn’t be removed`,
            result.failed[0].reason,
          );
        } else {
          this.notifications.success(removed, 'Each scene kept its correctly named file.');
        }
        this.loadPreview();
      },
      error: (error: { error?: { message?: string } }) => {
        this.removingCopies.set(false);
        this.notifications.error(
          'Couldn’t remove the copies',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  renameAll(): void {
    const preview = this.preview();
    if (!preview || preview.counts.ready === 0 || this.previewOutdated()) {
      return;
    }
    if (!this.confirmRename()) {
      this.confirmRename.set(true);
      if (this.confirmTimer) {
        clearTimeout(this.confirmTimer);
      }
      this.confirmTimer = setTimeout(() => this.confirmRename.set(false), 5000);
      return;
    }
    this.confirmRename.set(false);
    const start = () =>
      this.api.renameAll().subscribe({
        next: (run) => {
          this.store.run.set(run);
          this.store.startPolling();
        },
        error: (error: { error?: { message?: string } }) =>
          this.notifications.error(
            'Couldn’t start renaming',
            error?.error?.message ?? 'Try again.',
          ),
      });
    if (this.patternDirty()) {
      const pattern = this.pattern().trim();
      this.api.update({ renamePattern: pattern }).subscribe({
        next: (saved) => {
          this.store.settings.set(saved);
          this.useSavedPattern(pattern, saved);
          start();
        },
        error: (error: { error?: { message?: string } }) =>
          this.notifications.error(
            'Couldn’t save the pattern',
            error?.error?.message ?? 'Try again.',
          ),
      });
    } else {
      start();
    }
  }

  fileName(path: string | null): string {
    return path ? fileName(path) : '';
  }

  folderOf(plan: RenamePlan): { from: string; to: string; moved: boolean } {
    const from = folderPath(plan.from ?? '');
    const to = folderPath(plan.to ?? '');
    // Show the whole new folder when any part of it changes, not just the last
    // one: a move to another library folder would otherwise look like nothing.
    return {
      from: folderName(plan.from ?? ''),
      to: from === to ? folderName(plan.to ?? '') : to,
      moved: from !== to,
    };
  }

  /** Why files were skipped, biggest reason first. */
  skipBreakdown(
    preview: RenamePreview,
  ): Array<{ state: RenameState; count: number; label: string; hint: string | null }> {
    const hints: Partial<Record<RenameState, string>> = {
      whisparr:
        'Whisparr names these itself. Turn off “Leave Whisparr’s files alone” in Settings to include them.',
      missing:
        'Not matched yet, or missing something the pattern uses. Match them on Review first.',
      outside: 'Not inside a folder Stash has as a library.',
      'no-file': 'The scene in Stash has no file.',
      copy: 'The scene already has a file with the new name (Whisparr’s copy, say), so this older file is a second copy of the same scene. Removing it deletes only that file; the scene keeps the correctly named one.',
      taken:
        'Another file already has the new name, usually Whisparr’s own copy, so these are probably left-behind duplicates. Stashboard checked each other file itself: open the files to see what it found and the safe fix.',
      gone: 'Stash still lists these files at the path below, but nothing is there anymore: they were moved or deleted outside Stash (by Whisparr, say). Stash rescans those folders; if they stay here, run Clean in Stash jobs to drop the missing files.',
    };
    return (['copy', 'taken', 'gone', 'whisparr', 'missing', 'outside', 'no-file'] as RenameState[])
      .map((state) => ({
        state,
        count: preview.counts[state] ?? 0,
        label: SKIP_REASON[state],
        hint: hints[state] ?? null,
      }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count);
  }

  /**
   * A "taken" file: scans the other file's folder, or (after a second tap)
   * merges the other scene into this one and deletes this extra copy.
   */
  fixTaken(sceneIds: string[], fix: 'scan' | 'merge'): void {
    if (fix === 'merge' && this.confirmTaken() !== sceneIds[0]) {
      this.confirmTaken.set(sceneIds[0]);
      return;
    }
    this.confirmTaken.set(null);
    this.fixingTaken.set(true);
    // The fix agreed to: if Stash's view changed since, the server says so
    // and the preview below shows what fixing it takes now.
    this.api.fixTaken(sceneIds, fix).subscribe({
      next: (result) => {
        this.fixingTaken.set(false);
        if (result.merged || result.scanned) {
          this.notifications.success(
            result.merged ? 'Extra copy removed' : 'Stash is scanning',
            result.merged ? 'Kept the correctly named file.' : 'Preview again once Stash is done.',
          );
        } else if (result.skipped[0]) {
          this.notifications.error('Left it alone', result.skipped[0].reason);
        }
        this.loadPreview();
      },
      error: (error: { error?: { message?: string } }) => {
        this.fixingTaken.set(false);
        this.notifications.error('Couldn’t fix it', error?.error?.message ?? 'Try again.');
      },
    });
  }

  /** The skipped files with this reason (the preview sends up to a few hundred). */
  skippedIn(preview: RenamePreview, state: RenameState): RenamePlan[] {
    return preview.skipped.filter((plan) => plan.state === state);
  }

  /** A full example path, so it's clear which library folder files land in. */
  example(): string | null {
    const change = this.preview()?.changes[0];
    return change?.to ?? null;
  }

  private queuePreview(): void {
    this.cancelQueuedPreview();
    this.previewQueued.set(true);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      this.previewNames();
    }, PREVIEW_DELAY_MS);
  }

  private cancelQueuedPreview(): void {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewQueued.set(false);
  }

  /**
   * Stashboard tidies a pattern as it saves it (Whisparr's placeholders become
   * ours). Show what was saved, unless it was edited again since Save.
   */
  private useSavedPattern(sent: string, saved: OrganizerSettings): void {
    if (saved.renamePattern === sent) {
      return;
    }
    if (this.previewedPattern() === sent) {
      // Same names: the server reads both the same way.
      this.previewedPattern.set(saved.renamePattern);
    }
    if (this.pattern().trim() === sent) {
      this.pattern.set(saved.renamePattern);
    }
  }

  ngOnDestroy(): void {
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
    }
    this.cancelQueuedPreview();
  }
}
