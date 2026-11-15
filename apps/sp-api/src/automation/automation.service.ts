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
/** The latest scenes in Stash checked for a hover preview after each run and sweep. */
const RECENT_SCENES_FOR_PREVIEWS = 40;
/** How often recent scenes are checked for previews between runs. */
const PREVIEW_SWEEP_MS = 30 * 60_000;
/** Previews are asked for a scene this many times at most (per start-up). */
const PREVIEW_TRIES = 2;
/** How long to wait for the previews a rescan makes in a job of their own. */
const SCAN_PREVIEWS_WAIT_MS = 15 * 60_000;
const SCAN_PREVIEWS_POLL_MS = 5_000;

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
  private warnedLockedToken = false;
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
  /** How often previews were asked for each scene, so a broken file isn't asked about forever. */
  private readonly previewTries = new Map<string, number>();
  private sweepingPreviews = false;
  private lastWaitingAttemptAt = 0;
  /** Used by tests to avoid real waiting. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Used by tests to move time along. */
  now: () => number = () => Date.now();

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
    // A token saved under a different secret key reads as null. It's kept
    // as stored (the right key may be back next start); until then no call
    // matches it, and Settings → Automation can make a new link.
    if (existing && !existing.webhookToken) {
      if (!this.warnedLockedToken) {
        this.warnedLockedToken = true;
        this.logger.warn(
          'The Whisparr webhook link can’t be unlocked, so Whisparr’s calls are refused. Restore the secret key, or make a new link in Settings → Automation and paste it into Whisparr.',
        );
      }
      return { ...existing, webhookToken: '' };
    }
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
    if (!settings.webhookToken) {
      return false;
    }
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
      // Recent scenes that reached Stash some other way (its own scan, a
      // scheduled one, or a run that didn't see them as new) and still have
      // no hover preview get theirs too.
      if (settings.generateNew) {
        const earlier = await this.recentWithoutPreviews(config, newIds).catch(
          (error: unknown) => {
            this.logger.debug(
              `Couldn't check recent scenes for previews: ${messageOf(error)}`,
            );
            return [] as string[];
          },
        );
        // A scene seen as new by more than one run is asked about no more
        // often than any other.
        const newForPreviews = newIds.filter((id) =>
          this.mayTryPreview(config, id),
        );
        const previewIds = [...newForPreviews, ...earlier];
        if (previewIds.length > 0) {
          await this.record(
            reason,
            'RUNNING',
            `${steps.join(', ')}. Generating previews…`,
          );
          try {
            steps.push(
              describePreviews(
                await this.generatePreviews(config, previewIds),
                newForPreviews.length,
                earlier,
              ),
            );
          } catch (error) {
            this.logger.warn(`Generating previews failed: ${messageOf(error)}`);
            steps.push(`previews skipped (${messageOf(error)})`);
          }
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
            `found ${result.proposed.length} likely ${result.proposed.length === 1 ? 'match' : 'matches'} to check in Match scenes`,
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
  /**
   * Between runs: recent scenes without a hover preview get one, whichever
   * way they reached Stash. Each is asked about a couple of times at most.
   */
  @Interval(PREVIEW_SWEEP_MS)
  async sweepPreviews(): Promise<void> {
    if (this.running || this.sweepingPreviews || this.debounceTimer) {
      return;
    }
    this.sweepingPreviews = true;
    try {
      const settings = await this.getSettings();
      if (!settings.generateNew) {
        return;
      }
      const config = await this.stashConfig().catch(() => null);
      if (!config) {
        return;
      }
      const missing = await this.recentWithoutPreviews(config, []);
      if (missing.length === 0) {
        return;
      }
      this.logger.log(
        `${missing.length} recent scene(s) have no hover preview; asking Stash to generate them.`,
      );
      const outcome = await this.generatePreviews(config, missing);
      const message = describePreviews(outcome, 0, missing);
      await this.activity?.record({
        kind: 'automation',
        title: message.charAt(0).toUpperCase() + message.slice(1),
        detail:
          'Found by the regular check for recent scenes without previews.',
        status:
          outcome.result !== 'FINISHED' ||
          outcome.stillMissing.length + outcome.unconfirmed.length > 0
            ? 'partial'
            : 'done',
      });
    } catch (error) {
      this.logger.warn(
        `Checking recent scenes for previews failed: ${messageOf(error)}`,
      );
    } finally {
      this.sweepingPreviews = false;
    }
  }

  /** The latest scenes in Stash without a hover preview, less these and those asked about enough. */
  private async recentWithoutPreviews(
    config: StashAdapterBaseConfig,
    exclude: string[],
  ): Promise<string[]> {
    const recent = await this.stash.findLocalScenes(config, {
      page: 1,
      perPage: RECENT_SCENES_FOR_PREVIEWS,
      sort: 'created_at',
      direction: 'DESC',
      sceneFilter: {},
    });
    const skip = new Set(exclude);
    const candidates = recent.items
      .map((scene) => scene.id)
      .filter((id) => !skip.has(id) && this.mayTryPreview(config, id));
    // Scenes Stash didn't answer for are left for the next check.
    return (await this.stash.scenesWithoutPreview(config, candidates)).missing;
  }

  /** Attempts are counted per Stash, so a different one starts afresh. */
  private previewTryKey(config: StashAdapterBaseConfig, id: string): string {
    return `${config.baseUrl}|${id}`;
  }

  private mayTryPreview(config: StashAdapterBaseConfig, id: string): boolean {
    return (
      (this.previewTries.get(this.previewTryKey(config, id)) ?? 0) <
      PREVIEW_TRIES
    );
  }

  /**
   * Has Stash generate for these scenes, then checks each now has a hover
   * preview: Stash's job can finish with some scenes still lacking one (a
   * file it can't read or decode), and that's worth saying.
   */
  private async generatePreviews(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
  ): Promise<PreviewOutcome> {
    const job = await this.stash.startLibraryTask(config, 'generate', sceneIds);
    if (!job) {
      // Nothing was started, so no attempt is used up.
      throw new Error("Stash didn't start a Generate job");
    }
    for (const id of sceneIds) {
      const key = this.previewTryKey(config, id);
      this.previewTries.set(key, (this.previewTries.get(key) ?? 0) + 1);
    }
    const result = await this.stash.waitForJob(config, job, {
      sleep: this.sleep,
    });
    if (result !== 'FINISHED') {
      this.logger.warn(
        `Stash's Generate job for ${sceneIds.length} scene(s) ${result.toLowerCase()}.`,
      );
      return { result, stillMissing: [], unconfirmed: [] };
    }
    let check = await this.checkPreviews(config, sceneIds);
    if (check.missing.length > 0) {
      // Some Stash builds' Generate makes no previews at all (Stash issue
      // #7341, 0.32 development builds), though a rescan that makes them
      // still works: try that for the ones still without one.
      const rescanned = await this.rescanForPreviews(config, check.missing);
      if (rescanned !== 'none') {
        const again = await this.checkPreviews(config, check.missing);
        check =
          rescanned === 'done'
            ? {
                missing: again.missing,
                unanswered: [...check.unanswered, ...again.unanswered],
              }
            : // Stash may still be making them: not known to have failed.
              {
                missing: [],
                unanswered: [
                  ...check.unanswered,
                  ...again.unanswered,
                  ...again.missing,
                ],
              };
      }
    }
    if (check.missing.length > 0) {
      this.logger.warn(
        `Stash finished generating, but scene(s) ${check.missing.join(', ')} still have no hover preview. Stash's own log says why (often a file it can't read or decode).`,
      );
    }
    return {
      result,
      stillMissing: check.missing,
      unconfirmed: check.unanswered,
    };
  }

  private async checkPreviews(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
  ): Promise<{ missing: string[]; unanswered: string[] }> {
    return this.stash
      .scenesWithoutPreview(config, sceneIds)
      .catch((error: unknown) => {
        this.logger.debug(
          `Couldn't check the new previews: ${messageOf(error)}`,
        );
        return { missing: [] as string[], unanswered: sceneIds };
      });
  }

  /**
   * Rescans with previews made by the scan. 'done' once Stash has finished
   * making them; 'unconfirmed' when the scan finished but whether Stash is
   * still generating couldn't be told in time; 'none' when nothing was made.
   */
  private async rescanForPreviews(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
  ): Promise<'done' | 'unconfirmed' | 'none'> {
    try {
      const job = await this.stash.rescanForPreviews(config, sceneIds);
      if (!job) {
        return 'none';
      }
      this.logger.log(
        `Stash's Generate left ${sceneIds.length} scene(s) without a hover preview; rescanning them with previews.`,
      );
      const result = await this.stash.waitForJob(config, job, {
        sleep: this.sleep,
      });
      if (result !== 'FINISHED') {
        return 'none';
      }
      // Newer Stash makes a scan's previews in a job of their own that
      // carries on after the scan: wait for it before checking.
      return (await this.waitForStashGenerating(config))
        ? 'done'
        : 'unconfirmed';
    } catch (error) {
      this.logger.warn(`Couldn't rescan for previews: ${messageOf(error)}`);
      return 'none';
    }
  }

  /**
   * Until Stash has no generating job left: true then, false when long
   * enough has passed without seeing that.
   */
  private async waitForStashGenerating(
    config: StashAdapterBaseConfig,
  ): Promise<boolean> {
    const deadline = this.now() + SCAN_PREVIEWS_WAIT_MS;
    while (this.now() < deadline) {
      const queue = await this.stash.getJobQueue(config).catch(() => null);
      if (queue === null) {
        // Stash didn't answer: not a sign it's done. Ask again in a moment.
        await this.sleep(SCAN_PREVIEWS_POLL_MS);
        continue;
      }
      const generating = queue.some(
        (job) =>
          /generat/i.test(job.description) &&
          !['FINISHED', 'FAILED', 'CANCELLED'].includes(job.status),
      );
      if (!generating) {
        return true;
      }
      await this.sleep(SCAN_PREVIEWS_POLL_MS);
    }
    return false;
  }

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
interface PreviewOutcome {
  result: 'FINISHED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';
  /** Scenes still without a hover preview after the job finished. */
  stillMissing: string[];
  /** Scenes Stash didn't answer for when asked afterwards. */
  unconfirmed: string[];
}

/** "previews generated" or what went wrong, for the run's summary. */
export function describePreviews(
  outcome: PreviewOutcome,
  newCount: number,
  earlierIds: string[],
): string {
  if (outcome.result !== 'FINISHED') {
    return `previews not made: Stash's Generate job ${outcome.result.toLowerCase()}`;
  }
  const notMade = new Set([...outcome.stillMissing, ...outcome.unconfirmed]);
  const made = newCount + earlierIds.length - notMade.size;
  const earlierMade = earlierIds.filter((id) => !notMade.has(id)).length;
  const scenes = (n: number) => `${n} recent ${n === 1 ? 'scene' : 'scenes'}`;
  const parts: string[] = [];
  if (made > 0) {
    parts.push(
      earlierMade === 0
        ? 'previews generated'
        : newCount === 0
          ? `previews made for ${scenes(made)} that had none`
          : `previews generated (including ${scenes(earlierMade)} that had none)`,
    );
  }
  if (outcome.stillMissing.length > 0) {
    const n = outcome.stillMissing.length;
    parts.push(
      `Stash couldn't make previews for ${n} ${n === 1 ? 'scene' : 'scenes'} (its log says why)`,
    );
  }
  if (outcome.unconfirmed.length > 0) {
    const n = outcome.unconfirmed.length;
    parts.push(
      `couldn't confirm previews for ${n} ${n === 1 ? 'scene' : 'scenes'} (Stash didn't answer)`,
    );
  }
  return parts.join(', ');
}

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
