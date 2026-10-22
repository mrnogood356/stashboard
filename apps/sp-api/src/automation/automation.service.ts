import {
  Inject,
  Injectable,
  Logger,
  Optional,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { LibraryAutomationSettings } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { IndexingService } from '../indexing/indexing.service';
import { OrganizerService } from '../organizer/organizer.service';
import { canSee } from '../organizer/folder-cleanup.util';
import { mapPath } from '../organizer/whisparr-handoff.service';
import { isSamplePath } from '../playback/sample.util';
import { PrismaService } from '../prisma/prisma.service';
import { jobHeartbeats } from '../about/job-heartbeats';
import { LibraryFolderWatcher } from './folder-watch.util';
import {
  StashAdapter,
  type StashAdapterBaseConfig,
} from '../providers/stash/stash.adapter';

export type AutomationReason = 'webhook' | 'detected' | 'files' | 'manual';

const AUTOMATION_STARTED_BY: Record<AutomationReason, string> = {
  webhook: 'Started by a Whisparr import.',
  detected: 'Started because scenes were waiting for import.',
  files: 'Started by new files in your library folders.',
  manual: 'Started by you.',
};

export interface AutomationSettingsDto {
  scanOnImport: boolean;
  identifyNew: boolean;
  generateNew: boolean;
  removeSamples: boolean;
  watchFolders: boolean;
  /** After a Whisparr import: rescan, remove extra copies, link waiting scenes. */
  tidyAfterImport: boolean;
  /** Whether Stashboard can see Stash's library folders to watch them; null before the first look. */
  foldersVisible: boolean | null;
  webhookPath: string;
  running: boolean;
  lastRun: {
    at: string | null;
    status: string | null;
    message: string | null;
    reason: string | null;
  };
}

export interface AutomationSettingsUpdate {
  scanOnImport?: boolean;
  identifyNew?: boolean;
  generateNew?: boolean;
  removeSamples?: boolean;
  watchFolders?: boolean;
  tidyAfterImport?: boolean;
}

const KEY = 'GLOBAL';
/** Whisparr may send several imports in a row; wait a moment and do one scan. */
const WEBHOOK_DEBOUNCE_MS = 45_000;
/** Don't rescan for the same waiting scenes more often than this (e.g. a path Stash doesn't watch). */
const SAME_SET_RETRY_MS = 60 * 60_000;
/** Look back a little: Stash and Stashboard clocks can differ slightly. */
const CLOCK_SLACK_MS = 2 * 60_000;
const MAX_NEW_SCENES = 100;

/**
 * When Whisparr imports a scene: ask Stash to scan, identify the new scene on
 * StashDB, and generate its previews, then refresh Stashboard so it shows up.
 *
 * Triggered by Whisparr's webhook (instant) or, as a backup, by noticing
 * scenes Whisparr has a file for that Stash doesn't have yet.
 */
@Injectable()
export class AutomationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AutomationService.name);
  private running = false;
  private rerunReason: AutomationReason | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where Whisparr's imports since the last scan landed (as Whisparr sees them). */
  private pendingFolders = new Set<string>();
  /** Library folders (as Stash sees them) with new files put there by hand. */
  private pendingLocalFolders = new Set<string>();
  /** The new files themselves, so their scenes are found by path after the scan. */
  private pendingLocalFiles = new Set<string>();
  /** Notices files put straight into the library folders. */
  folderWatcher = new LibraryFolderWatcher();
  private foldersVisible: boolean | null = null;
  /** An import came in without a folder: only a full scan will find it. */
  private pendingFullScan = false;
  private lastWaitingSignature: string | null = null;
  private lastWaitingAttemptAt = 0;
  /** Used by tests to avoid real waiting. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly stash: StashAdapter,
    private readonly indexing: IndexingService,
    @Optional() private readonly organizer?: OrganizerService,
  ) {}

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  async onApplicationBootstrap(): Promise<void> {
    await this.getSettings().catch((error: unknown) =>
      this.logger.warn(
        `Couldn't load automation settings at startup: ${messageOf(error)}`,
      ),
    );
  }

  onModuleDestroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  async getSettings(): Promise<LibraryAutomationSettings> {
    const existing = await this.prisma.libraryAutomationSettings.findUnique({
      where: { key: KEY },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.libraryAutomationSettings.create({
      data: { key: KEY, webhookToken: newToken() },
    });
  }

  async getSettingsDto(): Promise<AutomationSettingsDto> {
    return this.toDto(await this.getSettings());
  }

  async updateSettings(
    update: AutomationSettingsUpdate,
  ): Promise<AutomationSettingsDto> {
    await this.getSettings();
    const saved = await this.prisma.libraryAutomationSettings.update({
      where: { key: KEY },
      data: {
        ...(update.scanOnImport !== undefined
          ? { scanOnImport: update.scanOnImport }
          : {}),
        ...(update.identifyNew !== undefined
          ? { identifyNew: update.identifyNew }
          : {}),
        ...(update.generateNew !== undefined
          ? { generateNew: update.generateNew }
          : {}),
        ...(update.removeSamples !== undefined
          ? { removeSamples: update.removeSamples }
          : {}),
        ...(update.watchFolders !== undefined
          ? { watchFolders: update.watchFolders }
          : {}),
        ...(update.tidyAfterImport !== undefined
          ? { tidyAfterImport: update.tidyAfterImport }
          : {}),
      },
    });
    this.logger.log(
      `Automation settings saved: scan on import ${onOff(saved.scanOnImport)}, identify ${onOff(saved.identifyNew)}, previews ${onOff(saved.generateNew)}, remove samples ${onOff(saved.removeSamples)}, watch folders ${onOff(saved.watchFolders)}, tidy after import ${onOff(saved.tidyAfterImport)}.`,
    );
    return this.toDto(saved);
  }

  async regenerateToken(): Promise<AutomationSettingsDto> {
    await this.getSettings();
    const saved = await this.prisma.libraryAutomationSettings.update({
      where: { key: KEY },
      data: { webhookToken: newToken() },
    });
    this.logger.log('Made a new webhook token for Whisparr.');
    return this.toDto(saved);
  }

  /** True when the token matches (constant-time). */
  async verifyToken(token: string): Promise<boolean> {
    const settings = await this.getSettings();
    const expected = Buffer.from(settings.webhookToken);
    const given = Buffer.from(token ?? '');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** Whisparr told us something was imported; run shortly (several imports become one run). */
  onWebhook(
    eventType: string | null,
    folder: string | null = null,
  ): 'ignored' | 'scheduled' {
    const type = (eventType ?? '').toLowerCase();
    if (
      type &&
      !['download', 'rename', 'moviefileimport', 'import'].includes(type)
    ) {
      this.logger.debug(`Ignoring Whisparr webhook event ${eventType}.`);
      return 'ignored';
    }
    this.logger.debug(
      `Library automation scheduled after Whisparr ${eventType ?? 'event'}${folder ? ` for ${folder}` : ''}.`,
    );
    if (folder) {
      this.pendingFolders.add(folder);
    } else {
      this.pendingFullScan = true;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.run('webhook');
    }, WEBHOOK_DEBOUNCE_MS);
    return 'scheduled';
  }

  /**
   * Backup trigger: scenes Whisparr has a file for that Stash hasn't picked
   * up. With scanning on, Stash scans for them; either way they're refreshed
   * and linked (StashDB merges included), and Whisparr looks again for
   * files that are gone.
   */
  @Interval(2 * 60_000)
  async checkForWaitingScenes(): Promise<void> {
    if (this.running || this.debounceTimer) {
      return;
    }
    let waiting: Array<{ stashId: string }>;
    let scanOnImport: boolean;
    try {
      scanOnImport = (await this.getSettings()).scanOnImport;
      waiting = await this.prisma.sceneIndex.findMany({
        where: { whisparrHasFile: true, NOT: { stashAvailable: true } },
        select: { stashId: true },
        orderBy: { stashId: 'asc' },
        take: 500,
      });
    } catch (error) {
      this.logger.warn(
        `Couldn't look for scenes waiting for import: ${messageOf(error)}`,
      );
      return;
    }
    if (waiting.length === 0) {
      this.lastWaitingSignature = null;
      return;
    }
    const signature = waiting.map((row) => row.stashId).join(',');
    const now = Date.now();
    if (
      signature === this.lastWaitingSignature &&
      now - this.lastWaitingAttemptAt < SAME_SET_RETRY_MS
    ) {
      return;
    }
    this.lastWaitingSignature = signature;
    this.lastWaitingAttemptAt = now;
    this.logger.log(
      `${waiting.length} scene(s) Whisparr has a file for aren't in Stash yet; checking them.`,
    );
    if (scanOnImport) {
      await this.run(
        'detected',
        waiting.map((row) => row.stashId),
      );
    }
    await this.organizer?.checkWaitingScenes().catch((error: unknown) => {
      this.logger.warn(`Checking waiting scenes failed: ${messageOf(error)}`);
    });
  }

  /**
   * Files copied straight into a library folder, not through Whisparr or
   * Stash: once they've finished copying, Stash scans just their folders and
   * the new scenes get the same treatment as a Whisparr import.
   */
  @Interval(60_000)
  async watchLibraryFolders(): Promise<void> {
    if (this.running || this.debounceTimer) {
      return;
    }
    try {
      const settings = await this.getSettings();
      if (!settings.scanOnImport || !settings.watchFolders) {
        jobHeartbeats.record('folder-watch', 'off', 'Turned off.');
        return;
      }
      const config = await this.stashConfig().catch(() => null);
      if (!config) {
        this.logger.debug('Not watching library folders: Stash is not set up.');
        jobHeartbeats.record('folder-watch', 'off', 'Stash isn’t set up.');
        return;
      }
      const roots = await this.stash.getLibraryRoots(config);
      const visible: string[] = [];
      for (const root of roots) {
        if (await canSee(root)) {
          visible.push(root);
        }
      }
      this.foldersVisible = roots.length > 0 && visible.length > 0;
      if (visible.length === 0) {
        this.logger.debug(
          `Can't see any of Stash's ${roots.length} library folder(s) from Stashboard.`,
        );
        jobHeartbeats.record(
          'folder-watch',
          'warn',
          'Stashboard can’t see Stash’s library folders.',
        );
        return;
      }
      const files = await this.folderWatcher.check(visible);
      jobHeartbeats.record(
        'folder-watch',
        'ok',
        `Watching ${visible.length} folder${visible.length === 1 ? '' : 's'}.`,
      );
      if (files.length === 0) {
        return;
      }
      // Moved or renamed by Stash itself (the organizer, say): nothing to scan.
      const known = await this.stash.knownFilePaths(config, files);
      const fresh = files.filter((file) => !known.has(file));
      if (fresh.length === 0) {
        return;
      }
      for (const file of fresh) {
        this.pendingLocalFolders.add(parentFolder(file));
        this.pendingLocalFiles.add(file);
      }
      this.logger.log(
        `Found ${fresh.length} new file(s) in the library folders.`,
      );
      await this.run('files');
    } catch (error) {
      jobHeartbeats.record('folder-watch', 'failed', messageOf(error));
      this.logger.warn(`Watching library folders failed: ${messageOf(error)}`);
    }
  }

  /** Scan → identify new scenes → generate their previews → refresh Stashboard. */
  async run(
    reason: AutomationReason,
    waitingStashIds: string[] = [],
  ): Promise<void> {
    if (this.running) {
      this.logger.debug(
        `Library automation is busy; running again (${reason}) afterwards.`,
      );
      this.rerunReason = reason;
      return;
    }
    // Claimed before the first await, so two triggers at once can't both start a run.
    this.running = true;
    const settings = await this.getSettings().catch((error: unknown) => {
      this.running = false;
      throw error;
    });
    if (!settings.scanOnImport && reason !== 'manual') {
      this.running = false;
      // A Run now that came in meanwhile still runs.
      const rerun = this.rerunReason;
      this.rerunReason = null;
      if (rerun) {
        void this.run(rerun);
      }
      return;
    }
    const config = await this.stashConfig().catch(() => null);
    this.logger.log(`Library automation started (${reason}).`);
    try {
      if (!config) {
        await this.record(
          reason,
          'FAILED',
          'Stash is not set up in Stashboard.',
        );
        return;
      }
      const since = new Date(Date.now() - CLOCK_SLACK_MS);
      // After a Whisparr import, scan just the folders it imported into; a big
      // library takes much longer to scan whole.
      const watchedFiles = [...this.pendingLocalFiles];
      this.pendingLocalFiles = new Set();
      const folders = await this.foldersToScan(reason, config);
      await this.record(
        reason,
        'RUNNING',
        folders
          ? reason === 'files'
            ? `Scanning ${folders.length === 1 ? 'a folder' : `${folders.length} folders`} with new files in Stash…`
            : `Scanning ${folders.length === 1 ? 'the imported folder' : `${folders.length} imported folders`} in Stash…`
          : 'Scanning Stash for new files…',
      );

      const scanJob = folders
        ? await this.stash.scanLibraryFolders(config, folders)
        : await this.stash.startLibraryTask(config, 'scan');
      const scanResult = scanJob
        ? await this.stash.waitForJob(config, scanJob, { sleep: this.sleep })
        : 'FINISHED';
      if (scanResult !== 'FINISHED') {
        await this.record(
          reason,
          'FAILED',
          `Stash scan ${scanResult.toLowerCase()}.`,
        );
        return;
      }

      const created = await this.stash.findLocalScenes(config, {
        page: 1,
        perPage: MAX_NEW_SCENES,
        sort: 'created_at',
        direction: 'DESC',
        sceneFilter: {
          created_at: {
            value: stashTimestamp(since),
            modifier: 'GREATER_THAN',
          },
        },
      });
      // New files the watcher saw are looked up by path too: "created since"
      // depends on Stash's clock and time zone agreeing with ours.
      const byPath =
        watchedFiles.length > 0
          ? await this.stash
              .sceneIdsForPaths(config, watchedFiles)
              .catch((error: unknown) => {
                this.logger.debug(
                  `Couldn't look up new files by path in Stash: ${messageOf(error)}`,
                );
                return [] as string[];
              })
          : [];
      let newIds = [
        ...new Set([...created.items.map((scene) => scene.id), ...byPath]),
      ];
      // Sample clips that came with the download: gone before anything else
      // spends time on them.
      let samplesRemoved = 0;
      if (newIds.length > 0 && settings.removeSamples) {
        const removed = await this.removeSamples(config, newIds);
        samplesRemoved = removed.length;
        newIds = newIds.filter((id) => !removed.includes(id));
      }
      const steps: string[] = [
        newIds.length === 0
          ? 'No new scenes found'
          : `Found ${newIds.length} new ${newIds.length === 1 ? 'scene' : 'scenes'}`,
        ...(samplesRemoved
          ? [
              `removed ${samplesRemoved} ${samplesRemoved === 1 ? 'sample' : 'samples'}`,
            ]
          : []),
      ];

      // Previews first: they give the new files the fingerprints matching uses.
      if (newIds.length > 0 && settings.generateNew) {
        await this.record(
          reason,
          'RUNNING',
          `${steps.join(', ')}. Generating previews…`,
        );
        try {
          const generateJob = await this.stash.startLibraryTask(
            config,
            'generate',
            newIds,
          );
          if (generateJob) {
            await this.stash.waitForJob(config, generateJob, {
              sleep: this.sleep,
            });
          }
          steps.push('previews generated');
        } catch (error) {
          this.logger.warn(`Generating previews failed: ${messageOf(error)}`);
          steps.push(`previews skipped (${messageOf(error)})`);
        }
      }

      if (newIds.length > 0 && settings.identifyNew) {
        await this.record(
          reason,
          'RUNNING',
          `${steps.join(', ')}. Identifying…`,
        );
        steps.push(...(await this.identify(config, newIds)));
      }

      // Scenes Whisparr has a file for that Stash's copy was never linked to:
      // they wait for an import that already happened.
      if (waitingStashIds.length > 0 && this.organizer) {
        const linked = await this.organizer
          .linkWaitingScenes(waitingStashIds)
          .catch((error: unknown) => {
            this.logger.warn(
              `Linking scenes waiting for import failed: ${messageOf(error)}`,
            );
            return [] as string[];
          });
        if (linked.length > 0) {
          steps.push(`linked ${linked.length} waiting for import`);
        }
      }

      if (newIds.length > 0 && this.organizer) {
        try {
          const renamed = await this.organizer.afterImport(newIds);
          if (renamed > 0) {
            steps.push(
              `renamed ${renamed} ${renamed === 1 ? 'file' : 'files'}`,
            );
          }
        } catch (error) {
          this.logger.warn(`Renaming new scenes failed: ${messageOf(error)}`);
          steps.push(`rename skipped (${messageOf(error)})`);
        }
      }

      // Whisparr's imports can leave copies behind: tidy up after them.
      if (
        settings.tidyAfterImport &&
        this.organizer &&
        (reason === 'webhook' || reason === 'detected')
      ) {
        await this.record(
          reason,
          'RUNNING',
          `${steps.join(', ')}. Tidying up after Whisparr…`,
        );
        steps.push(...(await this.tidyAfterWhisparr()));
      }

      await this.refreshStashboard(waitingStashIds);
      await this.record(reason, 'DONE', `${steps.join(', ')}.`);
    } catch (error) {
      await this.record(reason, 'FAILED', messageOf(error), error);
    } finally {
      this.running = false;
      const rerun = this.rerunReason;
      this.rerunReason = null;
      if (rerun) {
        void this.run(rerun);
      }
    }
  }

  /** "Sync with Whisparr" after an import; returns the steps for the summary. */
  private async tidyAfterWhisparr(): Promise<string[]> {
    if (!this.organizer) {
      return [];
    }
    if (this.organizer.status().running) {
      return ['tidy-up skipped (the organizer was busy)'];
    }
    try {
      return (await this.organizer.syncWithWhisparr()).steps;
    } catch (error) {
      this.logger.warn(`Tidying up after Whisparr failed: ${messageOf(error)}`);
      return [`tidy-up skipped (${messageOf(error)})`];
    }
  }

  /**
   * Names new scenes. Files Whisparr imported are linked to the StashDB scene
   * they were downloaded for, the rest get the organizer's sure-only
   * matching, and Stash's own Identify tries whatever is still left.
   * Returns the steps for the run's summary.
   */
  private async identify(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
  ): Promise<string[]> {
    const steps: string[] = [];
    let left = sceneIds;
    if (this.organizer) {
      try {
        const result = await this.organizer.identifyNewScenes(sceneIds);
        if (result.linked.length) {
          steps.push(`linked ${result.linked.length} from Whisparr`);
        }
        if (result.matched.length) {
          steps.push(`matched ${result.matched.length}`);
        }
        if (result.proposed?.length) {
          steps.push(
            `found ${result.proposed.length} likely ${result.proposed.length === 1 ? 'match' : 'matches'} to check in Match & rename`,
          );
        }
        left = result.left;
      } catch (error) {
        this.logger.warn(`Matching new scenes failed: ${messageOf(error)}`);
        steps.push(`matching skipped (${messageOf(error)})`);
      }
    }
    if (left.length === 0) {
      return steps.length ? steps : ['already identified'];
    }
    try {
      const identifyJob = await this.stash.startLibraryTask(
        config,
        'identify',
        left,
      );
      if (identifyJob) {
        await this.stash.waitForJob(config, identifyJob, {
          sleep: this.sleep,
        });
      }
      steps.push(
        left.length === sceneIds.length
          ? 'identified'
          : `asked Stash to identify ${left.length} more`,
      );
    } catch (error) {
      this.logger.warn(`Stash's Identify failed: ${messageOf(error)}`);
      steps.push(`identify skipped (${messageOf(error)})`);
    }
    return steps;
  }

  /**
   * The imported folders as Stash sees them, or null for a full scan: for a
   * manual or catch-up run, an import without a folder, or a folder that
   * isn't inside one of Stash's library folders (after the Whisparr path
   * mapping from the organizer's settings).
   */
  private async foldersToScan(
    reason: AutomationReason,
    config: StashAdapterBaseConfig,
  ): Promise<string[] | null> {
    const folders = [...this.pendingFolders];
    const local = [...this.pendingLocalFolders];
    const fullScan = this.pendingFullScan;
    this.pendingFolders = new Set();
    this.pendingLocalFolders = new Set();
    this.pendingFullScan = false;
    if (
      !['webhook', 'files'].includes(reason) ||
      fullScan ||
      folders.length + local.length === 0
    ) {
      return null;
    }
    try {
      const [settings, roots] = await Promise.all([
        this.organizer?.getSettings() ?? Promise.resolve(null),
        this.stash.getLibraryRoots(config),
      ]);
      const mapped = folders.map((folder) =>
        mapPath(folder, settings?.whisparrPathTo, settings?.whisparrPathFrom),
      );
      const inLibrary = (folder: string) =>
        roots.some((root) => isInsideFolder(folder, root));
      const all = [...new Set([...mapped, ...local])];
      if (!all.every(inLibrary)) {
        this.logger.debug(
          'An imported folder is outside Stash’s library folders; scanning everything.',
        );
        return null;
      }
      return all;
    } catch (error) {
      this.logger.debug(
        `Couldn't work out which folders to scan, so scanning everything: ${messageOf(error)}`,
      );
      return null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private async refreshStashboard(waitingStashIds: string[]): Promise<void> {
    try {
      await this.indexing.syncLibraryProjection('automation');
      if (waitingStashIds.length > 0) {
        await this.indexing.requestImmediateRefresh(
          waitingStashIds,
          'automation',
        );
      }
    } catch (error) {
      this.logger.warn(`Refresh after automation failed: ${messageOf(error)}`);
    }
  }

  private async record(
    reason: AutomationReason,
    status: string,
    message: string,
    error?: unknown,
  ): Promise<void> {
    if (status === 'RUNNING') {
      this.logger.debug(`Library automation (${reason}): ${message}`);
    } else if (status === 'FAILED') {
      this.logger.error(
        `Library automation (${reason}) failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
    } else if (reason === 'detected' && /^No new scenes/.test(message)) {
      this.logger.debug(`Library automation (${reason}) finished: ${message}`);
    } else {
      this.logger.log(`Library automation (${reason}) finished: ${message}`);
    }
    // Finished runs go in the activity log, except the regular check for
    // waiting scenes when it found nothing.
    if (
      status !== 'RUNNING' &&
      (reason !== 'detected' ||
        status !== 'DONE' ||
        !/^No new scenes/.test(message))
    ) {
      await this.activity?.record({
        kind: 'automation',
        title: message,
        detail: AUTOMATION_STARTED_BY[reason],
        status: status === 'FAILED' ? 'failed' : 'done',
      });
    }
    await this.prisma.libraryAutomationSettings
      .update({
        where: { key: KEY },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: status,
          lastRunMessage: message,
          lastRunReason: reason,
        },
      })
      .catch((cause: unknown) =>
        this.logger.debug(
          `Couldn't save automation's last run: ${messageOf(cause)}`,
        ),
      );
  }

  private async stashConfig(): Promise<{
    baseUrl: string;
    apiKey?: string | null;
  }> {
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
      throw new Error('Stash is not set up.');
    }
    return { baseUrl, apiKey: integration.apiKey };
  }

  /**
   * Deletes the new scenes that are sample clips ("sample" as a word in the
   * file or folder name), file and all. Returns the ids it removed.
   */
  private async removeSamples(
    config: StashAdapterBaseConfig,
    newIds: string[],
  ): Promise<string[]> {
    const fresh = new Set(newIds);
    const samples = (
      await this.stash.findSampleScenes(config, 0).catch((error: unknown) => {
        this.logger.warn(
          `Couldn't look for sample clips in Stash: ${messageOf(error)}`,
        );
        return [];
      })
    ).filter(
      (scene) => fresh.has(scene.id) && isSamplePath(scene.file?.path ?? ''),
    );
    const removed: string[] = [];
    for (const sample of samples) {
      try {
        await this.stash.deleteScene(config, sample.id, true);
        removed.push(sample.id);
      } catch (error) {
        this.logger.warn(
          `Couldn't remove sample ${sample.file?.path ?? sample.id}: ${messageOf(error)}`,
        );
      }
    }
    if (removed.length > 0) {
      this.logger.log(`Removed ${removed.length} sample clip(s) from Stash.`);
    }
    return removed;
  }

  private toDto(settings: LibraryAutomationSettings): AutomationSettingsDto {
    return {
      scanOnImport: settings.scanOnImport,
      identifyNew: settings.identifyNew,
      generateNew: settings.generateNew,
      removeSamples: settings.removeSamples,
      watchFolders: settings.watchFolders,
      tidyAfterImport: settings.tidyAfterImport,
      foldersVisible: settings.watchFolders ? this.foldersVisible : null,
      webhookPath: `/api/hooks/whisparr/${settings.webhookToken}`,
      running: this.running,
      lastRun: {
        at: settings.lastRunAt?.toISOString() ?? null,
        status: settings.lastRunStatus,
        message: settings.lastRunMessage,
        reason: settings.lastRunReason,
      },
    };
  }
}

function newToken(): string {
  return randomBytes(24).toString('hex');
}

/** Stash timestamp filter format (RFC 3339 without milliseconds). */
export function stashTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parentFolder(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return cut > 0 ? file.slice(0, cut) : file;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'unknown error';
}

function isInsideFolder(path: string, folder: string): boolean {
  const inner = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const outer = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  return inner === outer || inner.startsWith(`${outer}/`);
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}
