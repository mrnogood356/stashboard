import {
  BadRequestException,
  ConflictException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { OrganizerSettings } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import {
  ACTIVITY_KINDS,
  type ActivityKind,
  type NewActivity,
} from '../activity/activity.model';
import { IndexingService } from '../indexing/indexing.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import {
  StashAdapter,
  StashAdapterBaseConfig,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import {
  canSee,
  foldersLeftBehind,
  removeEmptyFolders,
} from './folder-cleanup.util';
import {
  HandoffResult,
  WhisparrHandoffService,
} from './whisparr-handoff.service';
import {
  findRoot,
  formatResolution,
  splitPath,
  validatePattern,
} from './rename.util';
import { stashMediaUrl } from '../media/media-url.util';
import {
  IDLE_RUN,
  KEY,
  MAX_BACKLOG,
  TPDB_ENDPOINT,
  type CachedCandidate,
  type Context,
  type MatchSource,
  type OrganizerRunDto,
  type OrganizerSettingsDto,
  type OrganizerSettingsUpdate,
  type UnmatchedSceneDto,
} from './organizer.model';
import {
  fingerprintGroup,
  hostOf,
  labelFor,
  messageOf,
  normalizeFolder,
  pickTargetRoot,
} from './organizer-plan.util';

/**
 * What every part of the organizer shares: its settings, the background
 * run's state, and the helpers for Stash, folders and Whisparr.
 */
/** How often a running job's progress is saved, for a restart to report. */
const PROGRESS_SAVE_MS = 10_000;

export abstract class OrganizerCore {
  protected readonly logger = new Logger('OrganizerService');

  protected readonly candidates = new Map<string, CachedCandidate>();

  protected runState: OrganizerRunDto = { ...IDLE_RUN };

  protected refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** The activity log; finished runs are added to it. */
  @Optional()
  @Inject(ActivityService)
  protected readonly activity?: ActivityService;

  /** Used by tests to skip the pause between StashDB searches. */
  pause: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly stash: StashAdapter,
    protected readonly stashdb: StashdbAdapter,
    protected readonly catalogProvider: CatalogProviderService,
    protected readonly indexing: IndexingService,
    protected readonly handoff: WhisparrHandoffService,
  ) {}

  protected progressTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * A run interrupted by a restart: say so, with how far it got. Running it
   * again picks up what's left. While a run goes, save its progress now and
   * then so a restart has something to report.
   */
  async onModuleInit(): Promise<void> {
    this.activity?.registerUndo('rename-batch', (undo) =>
      this.undoBatch(String(undo.batchId)),
    );
    const settings = await this.prisma.organizerSettings
      .findUnique({ where: { key: KEY } })
      .catch(() => null);
    if (settings?.lastRunStatus === 'RUNNING') {
      await this.record(
        settings.lastRunKind ?? 'match',
        'FAILED',
        `Stopped by a restart${settings.lastRunMessage ? ` (${settings.lastRunMessage.replace(/[.…]+$/, '')})` : ''}. Run it again to finish what's left.`,
      );
    }
    this.progressTimer = setInterval(() => {
      const run = this.runState;
      if (run.running && run.kind && run.message) {
        void this.record(run.kind, 'RUNNING', run.message);
      }
    }, PROGRESS_SAVE_MS);
    this.progressTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
    }
  }

  // ---------- settings ----------

  async getSettings(): Promise<OrganizerSettings> {
    const existing = await this.prisma.organizerSettings.findUnique({
      where: { key: KEY },
    });
    return (
      existing ?? this.prisma.organizerSettings.create({ data: { key: KEY } })
    );
  }

  async getSettingsDto(): Promise<OrganizerSettingsDto> {
    return this.toDto(await this.getSettings());
  }

  async updateSettings(
    update: OrganizerSettingsUpdate,
  ): Promise<OrganizerSettingsDto> {
    if (update.renamePattern !== undefined) {
      // A format copied from Whisparr's settings is kept as is and named
      // the way Whisparr names it.
      const renamePattern = update.renamePattern.trim();
      const problem = validatePattern(renamePattern);
      if (problem) {
        throw new BadRequestException(problem);
      }
      update = { ...update, renamePattern };
    }
    await this.getSettings();
    const saved = await this.prisma.organizerSettings.update({
      where: { key: KEY },
      data: {
        ...(update.renamePattern !== undefined
          ? { renamePattern: update.renamePattern.trim() }
          : {}),
        ...(update.renameRoot !== undefined
          ? { renameRoot: await this.checkRoot(update.renameRoot) }
          : {}),
        ...(update.renameAfterMatch !== undefined
          ? { renameAfterMatch: update.renameAfterMatch }
          : {}),
        ...(update.moveUnmatched !== undefined
          ? { moveUnmatched: update.moveUnmatched }
          : {}),
        ...(update.cleanEmptyFolders !== undefined
          ? { cleanEmptyFolders: update.cleanEmptyFolders }
          : {}),
        ...(update.skipWhisparrFiles !== undefined
          ? { skipWhisparrFiles: update.skipWhisparrFiles }
          : {}),
        ...(update.autoMatchNightly !== undefined
          ? { autoMatchNightly: update.autoMatchNightly }
          : {}),
        ...(update.useStashScrapers !== undefined
          ? { useStashScrapers: update.useStashScrapers }
          : {}),
        ...(update.tpdbApiKey !== undefined
          ? { tpdbApiKey: update.tpdbApiKey.trim() || null }
          : {}),
        ...(update.sendToWhisparr !== undefined
          ? { sendToWhisparr: update.sendToWhisparr }
          : {}),
        ...(update.addToWhisparr !== undefined
          ? { addToWhisparr: update.addToWhisparr }
          : {}),
        ...(update.whisparrImportMode !== undefined
          ? { whisparrImportMode: update.whisparrImportMode }
          : {}),
        ...(update.whisparrPathFrom !== undefined
          ? { whisparrPathFrom: update.whisparrPathFrom.trim() || null }
          : {}),
        ...(update.whisparrPathTo !== undefined
          ? { whisparrPathTo: update.whisparrPathTo.trim() || null }
          : {}),
      },
    });
    return this.toDto(saved);
  }

  /** Empty, or one of Stash's library folders. */
  protected async checkRoot(value: string): Promise<string | null> {
    const wanted = value.trim();
    if (!wanted) {
      return null;
    }
    const roots = await this.stash.getLibraryRoots(await this.stashConfig());
    const match = pickTargetRoot(wanted, roots);
    if (!match) {
      throw new BadRequestException(
        'Pick one of Stash’s library folders (Stash → Settings → Library).',
      );
    }
    return match;
  }

  status(): OrganizerRunDto {
    return { ...this.runState };
  }

  // ---------- matching ----------

  /** True when Stash's library folders are mounted into Stashboard's container too. */
  protected async folderAccess(): Promise<boolean> {
    const config = await this.stashConfig();
    const roots = await this.stash.getLibraryRoots(config);
    if (roots.length === 0) {
      return false;
    }
    const seen = await Promise.all(roots.map((root) => canSee(root)));
    return seen.every(Boolean);
  }

  protected async protectedFolders(
    config: StashAdapterBaseConfig,
    settings: OrganizerSettings,
  ): Promise<string[]> {
    const [roots, whisparrRoots] = await Promise.all([
      this.stash.getLibraryRoots(config),
      this.handoff.rootFoldersAsStashSees(settings).catch((error) => {
        throw new ConflictException(
          `Couldn’t ask Whisparr for its root folders, so no folders were removed: ${messageOf(error)}`,
        );
      }),
    ]);
    return [...roots, ...whisparrRoots];
  }

  /** After moves: remove the folders those files left empty (only if truly empty). */
  protected async cleanUpAfterMoves(
    config: StashAdapterBaseConfig,
    settings: OrganizerSettings,
    fromPaths: string[],
  ): Promise<number> {
    if (!settings.cleanEmptyFolders || fromPaths.length === 0) {
      return 0;
    }
    try {
      const roots = await this.stash.getLibraryRoots(config);
      const keep = new Set(
        (await this.protectedFolders(config, settings)).map((folder) =>
          folder.replace(/[\\/]+$/, ''),
        ),
      );
      const candidates = new Set<string>();
      for (const from of fromPaths) {
        const root = findRoot(from, roots);
        if (!root || !(await canSee(root))) {
          continue;
        }
        foldersLeftBehind(from, root)
          .filter((folder) => !keep.has(folder.replace(/[\\/]+$/, '')))
          .forEach((folder) => candidates.add(folder));
      }
      // Deepest first; each is removed only if nothing real is left in it.
      const { removed } = await removeEmptyFolders(
        (await this.withoutGalleries(config, [...candidates])).folders,
      );
      return removed.length;
    } catch (error) {
      this.logger.warn(`Couldn’t clean up empty folders: ${messageOf(error)}`);
      return 0;
    }
  }

  /**
   * Leaves out folders where Stash has a gallery (in the folder or below it),
   * so a photo set Stash knows about is never removed. If Stash can't list its
   * galleries, nothing is removed and the reason is returned.
   */
  protected async withoutGalleries(
    config: StashAdapterBaseConfig,
    folders: string[],
  ): Promise<{ folders: string[]; galleries: number; error: string | null }> {
    if (folders.length === 0) {
      return { folders, galleries: 0, error: null };
    }
    let galleryFolders: string[];
    try {
      galleryFolders = (await this.stash.listGalleryFolders(config)).map(
        (folder) => normalizeFolder(folder),
      );
    } catch (error) {
      return {
        folders: [],
        galleries: 0,
        error: `Couldn’t check Stash’s galleries: ${messageOf(error)}`,
      };
    }
    const kept = folders.filter((folder) => {
      const own = normalizeFolder(folder);
      return !galleryFolders.some(
        (gallery) => gallery === own || gallery.startsWith(`${own}/`),
      );
    });
    return {
      folders: kept,
      galleries: folders.length - kept.length,
      error: null,
    };
  }

  /**
   * StashDB ids Whisparr looks after: what Stashboard knows has a file in
   * Whisparr, plus every scene Whisparr itself says it tracks (asked fresh,
   * so a stale index can't let the renamer move Whisparr's files).
   */
  protected async whisparrManaged(): Promise<{
    ids: Set<string>;
    folders: string[];
  }> {
    const fail = (error: unknown) => {
      throw new ConflictException(
        `Couldn’t ask Whisparr which files it manages, so nothing was renamed: ${messageOf(error)}. Try again once Whisparr is reachable, or turn off “Leave Whisparr’s files alone”.`,
      );
    };
    const [rows, tracked, folders] = await Promise.all([
      this.prisma.sceneIndex
        .findMany({
          where: { whisparrHasFile: true },
          select: { stashId: true },
        })
        .catch(() => [] as Array<{ stashId: string }>),
      this.handoff.trackedStashIds().catch(fail),
      this.getSettings()
        .then((settings) => this.handoff.trackedFolders(settings))
        .catch(fail),
    ]);
    return {
      ids: new Set([...rows.map((row) => row.stashId), ...tracked]),
      folders,
    };
  }

  // ---------- helpers ----------

  protected async collectIds(
    config: StashAdapterBaseConfig,
    sceneFilter: Record<string, unknown>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; page <= MAX_BACKLOG / 100; page += 1) {
      const result = await this.stash.findOrganizerScenes(config, {
        page,
        perPage: 100,
        sceneFilter,
      });
      ids.push(...result.items.map((scene) => scene.id));
      if (page * 100 >= result.total || result.items.length === 0) {
        break;
      }
    }
    return ids;
  }

  protected toUnmatched(scene: StashOrganizerScene): UnmatchedSceneDto {
    const file = scene.files[0] ?? null;
    const split = file ? splitPath(file.path) : null;
    return {
      id: scene.id,
      title: scene.title,
      fileName: file?.basename ?? scene.title ?? `Scene #${scene.id}`,
      folder: split?.folder ?? '',
      duration: file?.duration ?? null,
      size: file?.size ?? null,
      resolution: file
        ? formatResolution(file.width, file.height) || null
        : null,
      imageUrl: scene.screenshotVersion
        ? stashMediaUrl(
            `scenes/${encodeURIComponent(scene.id)}/screenshot`,
            scene.screenshotVersion,
            480,
          )
        : null,
      hasFingerprint: fingerprintGroup(scene.files).length > 0,
    };
  }

  protected assertIdle(): void {
    if (this.runState.running) {
      throw new ConflictException(
        'The organizer is already busy. Wait for it to finish.',
      );
    }
  }

  protected finish(message: string): void {
    this.runState = { ...this.runState, running: false, message };
  }

  /** Stashboard's own view of the library catches up a little after changes. */
  protected scheduleRefresh(delayMs = 20_000): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.indexing
        .syncLibraryProjection('organizer')
        .catch((error: unknown) => {
          this.logger.warn(
            `Refresh after organizing failed: ${messageOf(error)}`,
          );
        });
    }, delayMs);
  }

  /** Puts the files from one rename (or move) batch back where they were. */
  abstract undoBatch(batchId: string): Promise<OrganizerRunDto>;

  protected async record(
    kind: string,
    status: string,
    message: string,
    activity?: Partial<NewActivity>,
    error?: unknown,
  ): Promise<void> {
    const line = `Organizer ${kind}: ${message}`;
    if (status === 'RUNNING') {
      this.logger.debug(line);
    } else if (status === 'FAILED') {
      this.logger.error(
        `Organizer ${kind} failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    } else if (status === 'PARTIAL') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
    if (status !== 'RUNNING') {
      await this.activity?.record({
        kind: activityKind(kind),
        title: message,
        status: status === 'FAILED' ? 'failed' : 'done',
        ...activity,
      });
    }
    await this.prisma.organizerSettings
      .update({
        where: { key: KEY },
        data: {
          lastRunKind: kind,
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunMessage: message,
        },
      })
      .catch((cause: unknown) =>
        this.logger.debug(
          `Couldn't save the organizer's last run: ${messageOf(cause)}`,
        ),
      );
  }

  protected async context(): Promise<Context> {
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    const sources = await this.buildSources(config, settings);
    if (sources.length === 0) {
      throw new ConflictException(
        'Nothing to match against. Set up StashDB in Settings → Integrations, or add a stash-box in Stash.',
      );
    }
    const identify = await this.stash
      .getIdentifyDefaults(config)
      .catch(() => undefined);
    return { config, sources, identify };
  }

  /**
   * Your main catalog first, then every other stash-box set up in Stash
   * (FansDB, ThePornDB…), then ThePornDB from its key here if Stash doesn't
   * already have it.
   */
  protected async buildSources(
    config: StashAdapterBaseConfig,
    settings: OrganizerSettings,
  ): Promise<MatchSource[]> {
    const [provider, boxes] = await Promise.all([
      this.catalogProvider.getInstanceCatalogProvider().catch(() => null),
      this.stash.listStashBoxes(config).catch(
        () =>
          [] as Array<{
            name: string;
            endpoint: string;
            apiKey: string | null;
          }>,
      ),
    ]);
    const sources: MatchSource[] = [];
    const seenHosts = new Set<string>();
    if (provider?.baseUrl) {
      const host = hostOf(provider.baseUrl);
      const box = boxes.find((entry) => hostOf(entry.endpoint) === host);
      const base = provider.baseUrl.replace(/\/+$/, '');
      sources.push({
        key: 's0',
        name: box?.name || labelFor(provider.baseUrl),
        kind: 'catalog',
        api: { baseUrl: provider.baseUrl, apiKey: provider.apiKey ?? null },
        endpoint:
          box?.endpoint ??
          (base.endsWith('/graphql') ? base : `${base}/graphql`),
        primary: true,
      });
      if (host) seenHosts.add(host);
    }
    for (const box of boxes) {
      const host = hostOf(box.endpoint);
      if (!host || seenHosts.has(host)) {
        continue;
      }
      seenHosts.add(host);
      sources.push({
        key: `s${sources.length}`,
        name: box.name || labelFor(box.endpoint),
        kind: host.includes('theporndb') ? 'tpdb' : 'stash-box',
        api: { baseUrl: box.endpoint, apiKey: box.apiKey },
        endpoint: box.endpoint,
        primary: false,
      });
    }
    if (
      settings.tpdbApiKey &&
      ![...seenHosts].some((host) => host.includes('theporndb'))
    ) {
      sources.push({
        key: `s${sources.length}`,
        name: 'ThePornDB',
        kind: 'tpdb',
        api: { baseUrl: TPDB_ENDPOINT, apiKey: settings.tpdbApiKey },
        endpoint: TPDB_ENDPOINT,
        primary: false,
      });
    }
    return sources;
  }

  protected async stashConfig(): Promise<StashAdapterBaseConfig> {
    const integration = await this.prisma.integrationConfig.findUnique({
      where: { type: 'STASH' },
    });
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== 'CONFIGURED' ||
      !baseUrl
    ) {
      throw new ConflictException(
        'Set up Stash in Settings → Integrations first.',
      );
    }
    return { baseUrl, apiKey: integration.apiKey };
  }

  protected async describeSources(
    settings: OrganizerSettings,
  ): Promise<Pick<OrganizerSettingsDto, 'sources' | 'scrapers'>> {
    try {
      const config = await this.stashConfig();
      const [sources, scrapers] = await Promise.all([
        this.buildSources(config, settings),
        this.stash
          .listFragmentSceneScrapers(config)
          .catch(() => [] as Array<{ id: string; name: string }>),
      ]);
      return {
        sources: sources.map((source) => ({
          name: source.name,
          kind: source.kind,
        })),
        scrapers: scrapers.map((scraper) => scraper.name),
      };
    } catch {
      return { sources: [], scrapers: [] };
    }
  }

  protected async toDto(
    settings: OrganizerSettings,
  ): Promise<OrganizerSettingsDto> {
    // Independent lookups (Stash, Whisparr, the folders): ask them all at once.
    const [
      undo,
      libraryRoots,
      folderAccess,
      whisparrAvailable,
      missingInWhisparr,
      sources,
      whisparrLeavesCopies,
    ] = await Promise.all([
      this.lastUndoBatch(),
      this.stashConfig()
        .then((config) => this.stash.getLibraryRoots(config))
        .catch(() => [] as string[]),
      this.folderAccess().catch(() => false),
      this.handoff.isAvailable().catch(() => false),
      this.handoff
        .missingInWhisparr()
        .then((ids) => ids.length)
        .catch(() => 0),
      this.describeSources(settings),
      this.handoff.leavesCopies(settings).catch(() => null),
    ]);
    return {
      renamePattern: settings.renamePattern,
      renameRoot: settings.renameRoot ?? '',
      libraryRoots,
      renameAfterMatch: settings.renameAfterMatch,
      moveUnmatched: settings.moveUnmatched,
      cleanEmptyFolders: settings.cleanEmptyFolders,
      folderAccess,
      skipWhisparrFiles: settings.skipWhisparrFiles,
      autoMatchNightly: settings.autoMatchNightly,
      useStashScrapers: settings.useStashScrapers,
      hasTpdbKey: Boolean(settings.tpdbApiKey),
      sendToWhisparr: settings.sendToWhisparr,
      addToWhisparr: settings.addToWhisparr,
      whisparrImportMode:
        settings.whisparrImportMode === 'copy' ? 'copy' : 'move',
      whisparrPathFrom: settings.whisparrPathFrom ?? '',
      whisparrPathTo: settings.whisparrPathTo ?? '',
      whisparrAvailable,
      missingInWhisparr,
      whisparrLeavesCopies,
      ...sources,
      tokens: [
        'title',
        'studio',
        'date',
        'year',
        'performers',
        'code',
        'resolution',
        'stashdb',
      ],
      run: this.status(),
      lastRun: {
        kind: settings.lastRunKind,
        at: settings.lastRunAt?.toISOString() ?? null,
        status: settings.lastRunStatus,
        message: settings.lastRunMessage,
      },
      undo,
    };
  }

  /** The newest rename batch that can still be undone. */
  protected async lastUndoBatch(): Promise<OrganizerSettingsDto['undo']> {
    const last = await this.prisma.organizerRename
      .findFirst({ where: { undoneAt: null }, orderBy: { createdAt: 'desc' } })
      .catch(() => null);
    if (!last) {
      return null;
    }
    const count = await this.prisma.organizerRename
      .count({ where: { batchId: last.batchId, undoneAt: null } })
      .catch(() => 0);
    return count > 0
      ? { batchId: last.batchId, count, at: last.createdAt.toISOString() }
      : null;
  }

  protected async handOff(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
    settings: OrganizerSettings,
  ): Promise<HandoffResult> {
    const scenes = (
      await Promise.all(
        sceneIds.map((id) =>
          this.stash.getOrganizerScene(config, id).catch(() => null),
        ),
      )
    ).filter((scene): scene is StashOrganizerScene => scene !== null);
    return this.handoff.send(config, scenes, settings);
  }
}

/** The activity log's kind for an organizer run ("unmatched" moves files; repairs are Whisparr's). */
function activityKind(kind: string): ActivityKind {
  if (kind === 'unmatched') {
    return 'move';
  }
  return (ACTIVITY_KINDS as readonly string[]).includes(kind)
    ? (kind as ActivityKind)
    : 'whisparr';
}
