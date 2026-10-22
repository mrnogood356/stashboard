import { SelectionBarComponent } from '../../shared/selection-bar/selection-bar.component';
import { MatchReviewComponent } from './match-review.component';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { EMPTY, Observable, Subscription, catchError, interval, switchMap } from 'rxjs';
import {
  MatchCandidate,
  MatchConfidence,
  OrganizerApiService,
  OrganizerRun,
  OrganizerSettings,
  OrganizerSettingsUpdate,
  RenamePlan,
  RenamePreview,
  RenameState,
  SceneMatches,
  UnmatchedScene,
  UnmatchedScope,
  UnmatchedSort,
  WhisparrRepairPlan,
  WhisparrRepairScene,
} from '../../core/api/organizer.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';

type Tab = 'match' | 'rename' | 'settings';

const CONFIDENCE: Record<MatchConfidence, string> = {
  exact: 'Same video',
  strong: 'Very likely',
  likely: 'Possible',
  weak: 'Unlikely',
};

const SKIP_REASON: Record<RenameState, string> = {
  ready: '',
  same: 'Already tidy',
  missing: 'No title yet',
  whisparr: 'Whisparr’s file',
  outside: 'Outside your library folders',
  'no-file': 'No file',
  gone: 'File moved outside Stash',
  taken: 'New name already taken',
  copy: 'Extra copy',
};

const TOKEN_HELP: Record<string, string> = {
  title: 'Title',
  studio: 'Studio',
  date: 'Date (2024-05-31)',
  year: 'Year',
  performers: 'Performers',
  code: 'Studio code',
  resolution: 'Resolution (1080p)',
  stashdb: 'StashDB id',
  studioslug: 'Studio, no spaces (BrightStudio), like Whisparr',
  quality: 'Source and resolution (WEBDL-1080p), like Whisparr',
  group: 'Release group from the file name (GRP)',
};

/** How long to wait after the last key before working out names for the new pattern. */
const PREVIEW_DELAY_MS = 600;

interface MatchState {
  loading: boolean;
  result: SceneMatches | null;
  error: string | null;
  query: string;
  applying: string | null;
}

/** Match unmatched scenes to StashDB and rename files into tidy folders. */
@Component({
  selector: 'app-organize-page',
  imports: [RouterLink, SelectionBarComponent, MatchReviewComponent],
  templateUrl: './organize-page.component.html',
  styleUrls: ['./tools-shared.scss', './organize-page.component.scss'],
})
export class OrganizePageComponent implements OnInit, OnDestroy {
  private readonly api = inject(OrganizerApiService);
  private readonly notifications = inject(AppNotificationsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  @ViewChild('folderInput') private folderInput?: ElementRef<HTMLInputElement>;
  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>;
  /** Where a placeholder button adds to: the field last typed in. */
  private lastPatternField: 'folder' | 'file' = 'file';

  protected readonly confidenceLabel = CONFIDENCE;
  protected readonly skipReason = SKIP_REASON;
  protected readonly tokenHelp = TOKEN_HELP;

  protected readonly tab = signal<Tab>('match');
  protected readonly settings = signal<OrganizerSettings | null>(null);
  protected readonly run = signal<OrganizerRun | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal<string | null>(null);

  // Match
  protected readonly scenes = signal<UnmatchedScene[]>([]);
  protected readonly total = signal<number | null>(null);
  /** The list as searched and filtered; total() is always the unmatched count. */
  protected readonly listTotal = signal<number | null>(null);
  protected readonly listQuery = signal('');
  protected readonly listSort = signal<UnmatchedSort>('added-desc');
  protected readonly listScope = signal<UnmatchedScope>('unmatched');
  protected readonly filtered = computed(
    () => this.listQuery().trim() !== '' || this.listScope() !== 'unmatched',
  );
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private listRequest = 0;
  /** Unmatched files not in an Unmatched folder yet: what "Move … now" would move. */
  protected readonly toMove = signal(0);
  protected readonly loadingScenes = signal(false);
  protected readonly hasMore = signal(false);
  protected readonly matches = signal<Record<string, MatchState>>({});
  protected readonly lookingUpPage = signal(false);
  /** Bumped when a run ends, so the found-matches list is read again. */
  protected readonly reviewKey = signal(0);
  protected readonly withoutFingerprint = computed(
    () => this.scenes().filter((scene) => !scene.hasFingerprint).length,
  );
  private page = 1;

  // Rename
  protected readonly pattern = signal('');
  protected readonly preview = signal<RenamePreview | null>(null);
  /** Why each listed file is being renamed, and which parts of its new name are new. */
  protected readonly changeReasons = computed(
    () =>
      new Map((this.preview()?.changes ?? []).map((plan) => [plan.sceneId, explainRename(plan)])),
  );
  protected readonly previewing = signal(false);
  protected readonly previewError = signal<string | null>(null);
  protected readonly confirmRename = signal(false);
  protected readonly showSkipped = signal(false);
  protected readonly fixingTaken = signal(false);
  /** The "taken" file waiting for a second tap before its copy is deleted. */
  protected readonly confirmTaken = signal<string | null>(null);
  /** The skip reason whose files are listed. */
  protected readonly openSkip = signal<RenameState | null>(null);
  protected readonly patternDirty = computed(() => {
    const saved = this.settings()?.renamePattern ?? '';
    return this.pattern().trim() !== saved;
  });
  /** The pattern the preview on screen was worked out for. */
  private readonly previewedPattern = signal<string | null>(null);
  /** The pattern was edited since the preview: renaming now would use names nobody saw. */
  protected readonly previewOutdated = computed(
    () => this.preview() !== null && this.previewedPattern() !== this.pattern().trim(),
  );
  private previewRequest = 0;
  /** A preview waits for a pause in typing. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly previewQueued = signal(false);
  /** Scenes were matched or files moved while the Rename tab wasn't open. */
  private renameStale = false;
  private relocationRequest = 0;
  private emptyRequest = 0;

  private poll: Subscription | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    const requested = this.route.snapshot.queryParamMap.get('tab');
    this.tab.set(requested === 'rename' || requested === 'settings' ? requested : 'match');
    this.api.settings().subscribe({
      next: (settings) => {
        this.settings.set(settings);
        this.run.set(settings.run);
        this.pattern.set(settings.renamePattern);
        if (settings.run.running) {
          this.startPolling();
        }
        if (this.tab() === 'rename') {
          this.loadPreview();
        }
      },
      error: (error: { error?: { message?: string } }) =>
        this.error.set(
          error?.error?.message ?? 'Couldn’t reach Stashboard. Try again in a moment.',
        ),
    });
    this.loadScenes(1);
  }

  ngOnDestroy(): void {
    this.poll?.unsubscribe();
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
    }
    this.cancelQueuedPreview();
  }

  protected select(tab: Tab): void {
    if (tab === this.tab()) {
      return;
    }
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      replaceUrl: true,
    });
    if (tab === 'rename' && (!this.preview() || this.renameStale)) {
      this.loadPreview();
    }
  }

  protected currentUrl(): string {
    return this.router.url;
  }

  // ---------- settings ----------

  protected toggle(
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
          this.loadPreview();
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

  protected readonly tpdbEditing = signal(false);

  protected setImportMode(mode: 'move' | 'copy'): void {
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

  protected moveUnmatchedNow(): void {
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

  protected sendAllToWhisparr(): void {
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

  protected saveTpdbKey(value: string): void {
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

  protected hasTpdbSource(settings: OrganizerSettings): boolean {
    return settings.sources.some((source) => source.kind === 'tpdb');
  }

  protected sourceIcon(kind: 'catalog' | 'stash-box' | 'tpdb'): string {
    return kind === 'catalog' ? 'pi-star-fill' : kind === 'tpdb' ? 'pi-globe' : 'pi-database';
  }

  // ---------- match ----------

  protected readonly scraping = signal<ReadonlySet<string>>(new Set());

  protected tryScrapers(scene: UnmatchedScene): void {
    this.scraping.update((ids) => new Set([...ids, scene.id]));
    this.api.scrape(scene.id).subscribe({
      next: (result) => {
        this.scraping.update((ids) => new Set([...ids].filter((id) => id !== scene.id)));
        if (result.filled) {
          this.renameStale = true;
          this.scenes.update((scenes) => scenes.filter((entry) => entry.id !== scene.id));
          this.total.update((total) => (total === null ? total : Math.max(0, total - 1)));
          this.notifications.success(
            'Filled in by a scraper',
            result.renamedTo
              ? `${result.title} — renamed to ${fileName(result.renamedTo)}.`
              : `${result.title ?? 'Scene'} is filled in.`,
          );
        } else {
          this.notifications.info('No luck', 'None of Stash’s scrapers recognised this file.');
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.scraping.update((ids) => new Set([...ids].filter((id) => id !== scene.id)));
        this.notifications.error(
          'Couldn’t ask the scrapers',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  protected isScraping(id: string): boolean {
    return this.scraping().has(id);
  }

  protected search(value: string): void {
    this.listQuery.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    // Wait for a pause in typing before asking Stash.
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.loadScenes(1);
    }, 350);
  }

  protected setSort(value: string): void {
    this.listSort.set(value as UnmatchedSort);
    this.loadScenes(1);
  }

  protected setScope(value: string): void {
    this.listScope.set(value as UnmatchedScope);
    this.loadScenes(1);
  }

  protected loadMore(): void {
    this.loadScenes(this.page + 1);
  }

  protected matchState(id: string): MatchState | null {
    return this.matches()[id] ?? null;
  }

  protected lookup(scene: UnmatchedScene, query?: string): void {
    const current = this.matchState(scene.id);
    this.setMatch(scene.id, {
      loading: true,
      error: null,
      result: current?.result ?? null,
      query: query ?? current?.query ?? '',
    });
    this.api.lookup([scene.id], query?.trim() || undefined).subscribe({
      next: ([result]) => this.setMatch(scene.id, { loading: false, result: result ?? null }),
      error: (error: { error?: { message?: string } }) =>
        this.setMatch(scene.id, {
          loading: false,
          error: error?.error?.message ?? 'StashDB didn’t answer. Try again.',
        }),
    });
  }

  protected lookupPage(): void {
    const ids = this.scenes()
      .filter((scene) => !this.matchState(scene.id)?.result)
      .slice(0, 20)
      .map((scene) => scene.id);
    if (ids.length === 0) {
      return;
    }
    this.lookingUpPage.set(true);
    ids.forEach((id) => this.setMatch(id, { loading: true, error: null }));
    this.api.lookup(ids).subscribe({
      next: (results) => {
        this.lookingUpPage.set(false);
        for (const id of ids) {
          this.setMatch(id, {
            loading: false,
            result: results.find((result) => result.sceneId === id) ?? null,
          });
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.lookingUpPage.set(false);
        ids.forEach((id) =>
          this.setMatch(id, {
            loading: false,
            error: error?.error?.message ?? 'StashDB didn’t answer.',
          }),
        );
      },
    });
  }

  protected searchOwn(scene: UnmatchedScene, value: string): void {
    if (value.trim().length >= 2) {
      this.lookup(scene, value);
    }
  }

  protected apply(scene: UnmatchedScene, candidate: MatchCandidate): void {
    this.setMatch(scene.id, { applying: candidate.id });
    this.api.apply(scene.id, candidate.id).subscribe({
      next: (result) => {
        // A matched scene can be renamed now, or already was.
        this.renameStale = true;
        this.scenes.update((scenes) => scenes.filter((entry) => entry.id !== scene.id));
        this.total.update((total) => (total === null ? total : Math.max(0, total - 1)));
        this.notifications.success(
          'Matched',
          result.sentToWhisparr
            ? `${candidate.title ?? 'Scene'} is filled in and sent to Whisparr.`
            : result.renamedTo
              ? `${candidate.title ?? 'Scene'} is filled in and renamed to ${fileName(result.renamedTo)}.`
              : `${candidate.title ?? 'Scene'} is filled in from ${candidate.source}.`,
        );
        if (!result.sentToWhisparr && result.whisparrNote) {
          this.notifications.info('Not sent to Whisparr', result.whisparrNote);
        }
      },
      error: (error: { error?: { message?: string } }) => {
        this.setMatch(scene.id, { applying: null });
        this.notifications.error('Couldn’t save the match', error?.error?.message ?? 'Try again.');
      },
    });
  }

  /** A run the found-matches list started (saving them). */
  protected followRun(run: OrganizerRun): void {
    this.run.set(run);
    this.startPolling();
  }

  protected matchAll(): void {
    this.api.matchAll().subscribe({
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

  // ---------- rename ----------

  protected setRenameRoot(value: string): void {
    const settings = this.settings();
    if (!settings || settings.renameRoot === value) {
      return;
    }
    this.settings.set({ ...settings, renameRoot: value });
    this.saving.set('renameRoot');
    this.api.update({ renameRoot: value }).subscribe({
      next: (saved) => {
        this.saving.set(null);
        this.settings.set(saved);
        this.loadPreview();
      },
      error: (error: { error?: { message?: string } }) => {
        this.saving.set(null);
        this.restore({ renameRoot: settings.renameRoot });
        this.notifications.error('Couldn’t save', error?.error?.message ?? 'Try again.');
      },
    });
  }

  /** The pattern's folders, like Whisparr's Scene Folder Format: everything before the last /. */
  protected readonly folderPart = computed(() => {
    const parts = this.pattern().split('/');
    return parts.slice(0, -1).join('/');
  });
  /** The file name, like Whisparr's Standard Scene Format: after the last /. */
  protected readonly filePart = computed(() => this.pattern().split('/').pop() ?? '');

  protected setPattern(value: string): void {
    this.pattern.set(value);
    this.confirmRename.set(false);
    this.queuePreview();
  }

  protected setFolderFocus(): void {
    this.lastPatternField = 'folder';
  }

  protected setFileFocus(): void {
    this.lastPatternField = 'file';
  }

  protected setFolderPart(value: string): void {
    this.lastPatternField = 'folder';
    const folders = value.replace(/^\/+|\/+$/g, '');
    this.setPattern(folders ? `${folders}/${this.filePart()}` : this.filePart());
  }

  protected setFilePart(value: string): void {
    this.lastPatternField = 'file';
    // A file name has no folders; those go in the field above.
    const name = value.replace(/\//g, '');
    const folders = this.folderPart();
    this.setPattern(folders ? `${folders}/${name}` : name);
  }

  protected insertToken(token: string): void {
    const field = this.lastPatternField;
    const input = (field === 'folder' ? this.folderInput : this.fileInput)?.nativeElement;
    const value = field === 'folder' ? this.folderPart() : this.filePart();
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}{${token}}${value.slice(end)}`;
    if (field === 'folder') {
      this.setFolderPart(next);
    } else {
      this.setFilePart(next);
    }
    setTimeout(() => {
      const caret = start + token.length + 2;
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  }

  protected usePreset(pattern: string): void {
    this.setPattern(pattern);
    this.loadPreview();
  }

  protected readonly loadingWhisparrNaming = signal(false);

  /** Fills both fields from Whisparr's Scene Folder Format and Standard Scene Format. */
  protected useWhisparrNaming(): void {
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

  protected readonly relocation = signal<{
    destination: string;
    count: number;
    examples: string[];
  } | null>(null);
  protected readonly confirmRelocate = signal(false);

  protected readonly repair = signal<WhisparrRepairPlan | null>(null);
  protected readonly showRepairScenes = signal(false);
  protected readonly repairAction: Record<WhisparrRepairScene['action'], string> = {
    move: 'Whisparr moves it, with its file',
    path: 'Missing in Whisparr: only its path changes',
    reimport: 'Imported again from where Stash has the file',
  };

  /** Whisparr's folders and the repair plan follow the saved pattern and folder. */
  protected loadRelocation(): void {
    // Only the latest answers count: an older one is for settings since changed.
    const request = ++this.relocationRequest;
    const set = <T>(target: { set(value: T): void }, value: T) => {
      if (request === this.relocationRequest) {
        target.set(value);
      }
    };
    this.api.whisparrRelocation().subscribe({
      next: (plan) => set(this.relocation, plan),
      error: () => set(this.relocation, null),
    });
    this.loadEmptyFolders();
    this.api.whisparrRepair?.().subscribe({
      next: (plan) => set(this.repair, plan),
      error: () => set(this.repair, null),
    });
  }

  protected readonly empty = signal<{
    available: boolean;
    count: number;
    folders: string[];
    galleries?: number;
    error?: string | null;
  } | null>(null);
  protected readonly confirmClean = signal(false);
  protected readonly cleaning = signal(false);

  protected loadEmptyFolders(): void {
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

  protected cleanFolders(): void {
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

  /** Rescan, remove extra copies and link waiting scenes, in the background. */
  protected syncWithWhisparr(): void {
    this.startRun(this.api.syncWithWhisparr());
  }

  protected readonly renamingOne = signal<string | null>(null);

  /** Renames just this one scene from the preview list. */
  protected renameOne(sceneId: string): void {
    if (this.renamingOne() || this.previewOutdated()) {
      return;
    }
    this.renamingOne.set(sceneId);
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
  }

  // ---------- picking scenes in the Match list ----------

  protected readonly selecting = signal(false);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly confirmMovePicked = signal(false);

  protected startSelecting(): void {
    this.selecting.set(true);
    this.picked.set(new Set());
  }

  protected stopSelecting(): void {
    this.selecting.set(false);
    this.picked.set(new Set());
    this.confirmMovePicked.set(false);
  }

  protected isPicked(id: string): boolean {
    return this.picked().has(id);
  }

  protected togglePick(id: string): void {
    const next = new Set(this.picked());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.picked.set(next);
    this.confirmMovePicked.set(false);
  }

  protected pickAll(): void {
    this.picked.set(new Set(this.scenes().map((scene) => scene.id)));
  }

  protected pickNone(): void {
    this.picked.set(new Set());
  }

  /** Saves the sure matches for the picked scenes, in the background. */
  protected matchPicked(): void {
    const ids = [...this.picked()];
    if (ids.length === 0) {
      return;
    }
    this.stopSelecting();
    this.startRun(this.api.matchSelected(ids.slice(0, 500)));
  }

  /** Moves the picked scenes' files to Unmatched (tap twice). */
  protected movePicked(): void {
    const ids = [...this.picked()];
    if (ids.length === 0) {
      return;
    }
    if (!this.confirmMovePicked()) {
      this.confirmMovePicked.set(true);
      setTimeout(() => this.confirmMovePicked.set(false), 5000);
      return;
    }
    this.stopSelecting();
    this.startRun(this.api.moveUnmatched(ids.slice(0, 500)));
  }

  private startRun(request: Observable<OrganizerRun>): void {
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

  protected repairWhisparr(): void {
    this.api.repairWhisparr().subscribe({
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

  protected relocateWhisparr(): void {
    if (!this.confirmRelocate()) {
      this.confirmRelocate.set(true);
      setTimeout(() => this.confirmRelocate.set(false), 5000);
      return;
    }
    this.confirmRelocate.set(false);
    this.api.relocateWhisparr().subscribe({
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

  /** Works out names for the pattern now, and reloads what follows the saved settings. */
  protected loadPreview(): void {
    this.renameStale = false;
    this.loadRelocation();
    this.previewNames();
  }

  /** Just the names for the pattern as typed. */
  private previewNames(): void {
    this.cancelQueuedPreview();
    const pattern = this.pattern().trim();
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

  protected savePattern(): void {
    const pattern = this.pattern().trim();
    this.saving.set('renamePattern');
    this.api.update({ renamePattern: pattern }).subscribe({
      next: (saved) => {
        this.saving.set(null);
        this.settings.set(saved);
        this.useSavedPattern(pattern, saved);
        this.notifications.success('Pattern saved', 'New matches will use it.');
        // The repair plan and Whisparr's folders follow the saved pattern.
        this.loadPreview();
      },
      error: (error: { error?: { message?: string } }) => {
        this.saving.set(null);
        this.notifications.error(
          'Couldn’t save the pattern',
          error?.error?.message ?? 'Try again.',
        );
      },
    });
  }

  protected readonly removingCopies = signal(false);
  protected readonly confirmRemoveCopies = signal(false);

  /** Deletes the extra copies (tap twice); each scene keeps its correctly named file. */
  protected removeExtraCopies(): void {
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

  protected renameAll(): void {
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
          this.run.set(run);
          this.startPolling();
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
          this.settings.set(saved);
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

  protected undo(): void {
    this.api.undo().subscribe({
      next: (run) => {
        this.run.set(run);
        this.startPolling();
      },
      error: (error: { error?: { message?: string } }) =>
        this.notifications.error('Couldn’t undo', error?.error?.message ?? 'Try again.'),
    });
  }

  // ---------- display helpers ----------

  protected progress(run: OrganizerRun): number {
    return run.total > 0 ? Math.min(100, Math.round((run.processed / run.total) * 100)) : 0;
  }

  protected duration(seconds: number | null): string | null {
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

  protected size(bytes: number | null): string | null {
    if (!bytes) {
      return null;
    }
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  protected lengthDiff(scene: UnmatchedScene, candidate: MatchCandidate): string | null {
    if (!scene.duration || !candidate.duration) {
      return null;
    }
    const diff = Math.round(candidate.duration - scene.duration);
    if (Math.abs(diff) <= 2) {
      return null;
    }
    return `${diff > 0 ? '+' : '−'}${this.duration(Math.abs(diff))} vs file`;
  }

  protected fileName(path: string | null): string {
    return path ? fileName(path) : '';
  }

  protected folderOf(plan: RenamePlan): { from: string; to: string; moved: boolean } {
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
  protected skipBreakdown(
    preview: RenamePreview,
  ): Array<{ state: RenameState; count: number; label: string; hint: string | null }> {
    const hints: Partial<Record<RenameState, string>> = {
      whisparr:
        'Whisparr names these itself. Turn off “Leave Whisparr’s files alone” above to include them.',
      missing: 'Match them first (Match tab), then they can be named.',
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
  protected fixTaken(sceneIds: string[], fix: 'scan' | 'merge'): void {
    if (fix === 'merge' && this.confirmTaken() !== sceneIds[0]) {
      this.confirmTaken.set(sceneIds[0]);
      return;
    }
    this.confirmTaken.set(null);
    this.fixingTaken.set(true);
    this.api.fixTaken(sceneIds).subscribe({
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
  protected skippedIn(preview: RenamePreview, state: RenameState): RenamePlan[] {
    return preview.skipped.filter((plan) => plan.state === state);
  }

  /** A full example path, so it's clear which library folder files land in. */
  protected example(): string | null {
    const change = this.preview()?.changes[0];
    return change?.to ?? null;
  }

  protected when(iso: string | null): string {
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

  // ---------- internals ----------

  private loadScenes(page: number): void {
    this.loadingScenes.set(true);
    // Only the newest request counts when the search changes mid-flight.
    const request = ++this.listRequest;
    const options = {
      q: this.listQuery(),
      sort: this.listSort(),
      scope: this.listScope(),
    };
    this.api.unmatched(page, options).subscribe({
      next: (result) => {
        if (request !== this.listRequest) {
          return;
        }
        this.page = page;
        this.listTotal.set(result.total);
        if (!this.filtered()) {
          this.total.set(result.total);
        }
        if (result.toMove !== undefined) {
          this.toMove.set(result.toMove);
        }
        this.hasMore.set(result.hasMore);
        this.scenes.update((scenes) => (page === 1 ? result.items : [...scenes, ...result.items]));
        this.loadingScenes.set(false);
      },
      error: (error: { error?: { message?: string } }) => {
        if (request !== this.listRequest) {
          return;
        }
        this.loadingScenes.set(false);
        this.error.set(error?.error?.message ?? 'Couldn’t load scenes from Stash.');
      },
    });
  }

  private setMatch(id: string, patch: Partial<MatchState>): void {
    const empty: MatchState = {
      loading: false,
      result: null,
      error: null,
      query: '',
      applying: null,
    };
    this.matches.update((all) => ({ ...all, [id]: { ...empty, ...(all[id] ?? {}), ...patch } }));
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

  /** Undoes an optimistic change to just these settings. */
  private restore(previous: OrganizerSettingsUpdate): void {
    this.settings.update((current) => (current ? { ...current, ...previous } : current));
  }

  private startPolling(): void {
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
      this.reviewKey.update((key) => key + 1);
    }
    // Every run fills in scenes or moves files: reload the lists they change.
    if (run.kind !== 'rename' && run.kind !== 'whisparr') {
      // Matching, moving unmatched files or putting files back change the Match list.
      if (run.kind !== 'undo') {
        this.matches.set({});
      }
      this.loadScenes(1);
    }
    if (this.tab() === 'rename' || this.preview()) {
      this.loadPreview();
    } else {
      this.renameStale = true;
    }
  }
}

export interface RenameExplanation {
  reasons: string[];
  /** The new file name in pieces, with what wasn't in the old name marked. */
  name: Array<{ text: string; added: boolean }>;
}

const WORD_SEPARATORS = /([ ._-]+)/;

/** Plain words for what a rename changes: the folder, the name, or both. */
export function explainRename(plan: RenamePlan): RenameExplanation {
  const from = plan.from ?? '';
  const to = plan.to ?? '';
  const reasons: string[] = [];
  const fromFolder = folderPath(from);
  const toFolder = folderPath(to);
  if (fromFolder !== toFolder) {
    if (fromFolder.toLowerCase() === toFolder.toLowerCase()) {
      reasons.push('Folder name changes letter case');
    } else if (toFolder.startsWith(`${fromFolder}/`) || toFolder.startsWith(`${fromFolder}\\`)) {
      reasons.push(`Goes into its own folder: ${toFolder.slice(fromFolder.length + 1)}`);
    } else {
      const fromParts = fromFolder.split(/[\\/]/);
      const toParts = toFolder.split(/[\\/]/);
      let shared = 0;
      while (
        shared < Math.min(fromParts.length, toParts.length) &&
        fromParts[shared] === toParts[shared]
      ) {
        shared += 1;
      }
      reasons.push(
        `Moves from …/${fromParts.slice(shared).join('/') || '.'} to …/${toParts.slice(shared).join('/') || '.'}`,
      );
    }
  }

  const stem = (name: string) => name.replace(/\.[^.]+$/, '');
  const oldName = stem(fileName(from));
  const newName = stem(fileName(to));
  const words = (name: string) =>
    name
      .split(WORD_SEPARATORS)
      .filter((part, index) => index % 2 === 0 && part)
      .map((word) => word.toLowerCase());
  const oldWords = new Set(words(oldName));
  const newWords = new Set(words(newName));
  if (oldName !== newName) {
    if (oldName.toLowerCase() === newName.toLowerCase()) {
      reasons.push('Only the letter case changes');
    } else {
      const added = [...newWords].filter((word) => !oldWords.has(word));
      const dropped = [...oldWords].filter((word) => !newWords.has(word));
      const original = (list: string[], name: string) =>
        list.map(
          (word) => name.split(WORD_SEPARATORS).find((part) => part.toLowerCase() === word) ?? word,
        );
      const listed = (list: string[]) =>
        list.length > 4 ? `${list.slice(0, 4).join(', ')} +${list.length - 4}` : list.join(', ');
      if (added.length === 0 && dropped.length === 0) {
        const separator = (name: string) =>
          name.includes('.') && !name.includes(' ') ? 'dots' : 'spaces';
        reasons.push(
          separator(oldName) === separator(newName)
            ? 'Same words, punctuation tidied'
            : `Same words, ${separator(oldName)} become ${separator(newName)}`,
        );
      } else {
        if (added.length) {
          reasons.push(`Adds ${listed(original(added, newName))}`);
        }
        if (dropped.length) {
          reasons.push(`Drops ${listed(original(dropped, oldName))}`);
        }
      }
    }
  }
  if (reasons.length === 0) {
    reasons.push('Name changes');
  }

  const name = fileName(to)
    .split(WORD_SEPARATORS)
    .filter((part) => part)
    .map((part, index, all) => {
      const isExtension =
        index === all.length - 1 && /^[a-z0-9]{2,4}$/i.test(part) && all[index - 1] === '.';
      return {
        text: part,
        added:
          !isExtension &&
          !WORD_SEPARATORS.test(part) &&
          oldName !== newName &&
          !oldWords.has(part.toLowerCase()),
      };
    });
  return { reasons, name };
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function folderPath(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '';
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : '';
}
