import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  DownloadHandoff,
  DownloadHandoffSettings,
  IntegrationStatus,
} from '@prisma/client';
import * as path from 'node:path';
import { jobHeartbeats } from '../about/job-heartbeats';
import { ActivityService } from '../activity/activity.service';
import { OrganizerService } from '../organizer/organizer.service';
import { findRoot } from '../organizer/rename.util';
import { mapPath } from '../organizer/whisparr-handoff.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CATALOG_PROVIDER_KEYS,
  type CatalogProviderKey,
  getCatalogProviderLabel,
} from '../providers/catalog/catalog-provider.util';
import {
  SabnzbdAdapter,
  SabnzbdAdapterBaseConfig,
  SabnzbdHistoryEntry,
} from '../providers/sabnzbd/sabnzbd.adapter';
import {
  StashAdapter,
  StashAdapterBaseConfig,
} from '../providers/stash/stash.adapter';
import {
  findMainVideo,
  HandoffFileError,
  type JobFolderCleanup,
  placeVideo,
  removeJobFolder,
} from './download-handoff.files';
import {
  DEFAULT_HANDOFF_CATEGORY,
  HANDOFF_SETTINGS_KEY,
  OPEN_HANDOFF_STATUSES,
  type DownloadHandoffDto,
  type DownloadHandoffSettingsDto,
  type DownloadHandoffSettingsUpdate,
  type HandoffImportMode,
  type HandoffStatus,
} from './download-handoff.model';

/** How often SABnzbd is asked about open downloads. */
const WATCH_INTERVAL_MS = 2 * 60_000;
/** Open downloads looked at per check, oldest first. */
const MAX_OPEN = 50;
/** How long Stash gets to scan the destination folder. */
const SCAN_TIMEOUT_MS = 30 * 60_000;
/** Checks in a row Stash may miss the moved file (or linking may fail) before giving up. */
const MAX_LINK_ATTEMPTS = 5;
/** Not in SABnzbd's queue or history this long after sending: it was removed there. */
const FORGOTTEN_AFTER_MS = 3 * 24 * 3600_000;
const RECENT_LIMIT = 20;

/**
 * Finished downloads: "Find downloads" sends usenet releases to SABnzbd
 * under one category, and this follows them. When SABnzbd finishes one, its
 * main video is moved (or copied) into a folder in your Stash library, Stash
 * scans it, and it's linked to the exact catalog scene it was downloaded for,
 * renamed, and given previews.
 *
 * Only downloads Stashboard sent itself (by SABnzbd's id) are ever touched;
 * everything else in SABnzbd, even in the same category, is left alone, and
 * nothing in SABnzbd is ever deleted, retried or paused. Off by default.
 */
@Injectable()
export class DownloadHandoffService {
  private readonly logger = new Logger(DownloadHandoffService.name);
  private watching = false;
  /** Used by tests to avoid real waiting. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly sabnzbd: SabnzbdAdapter,
    private readonly stash: StashAdapter,
    private readonly organizer: OrganizerService,
  ) {}

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  // ---------- settings ----------

  async getSettings(): Promise<DownloadHandoffSettings> {
    return (
      (await this.prisma.downloadHandoffSettings.findUnique({
        where: { key: HANDOFF_SETTINGS_KEY },
      })) ??
      this.prisma.downloadHandoffSettings.upsert({
        where: { key: HANDOFF_SETTINGS_KEY },
        create: { key: HANDOFF_SETTINGS_KEY },
        update: {},
      })
    );
  }

  async getSettingsDto(): Promise<DownloadHandoffSettingsDto> {
    return this.toSettingsDto(await this.getSettings());
  }

  /**
   * Saves the settings. The destination has to be inside one of Stash's
   * library folders, or nothing is saved.
   */
  async updateSettings(
    update: DownloadHandoffSettingsUpdate,
  ): Promise<DownloadHandoffSettingsDto> {
    const current = await this.getSettings();
    const category =
      update.category !== undefined ? update.category.trim() : current.category;
    if (!category || category === '*') {
      throw new BadRequestException(
        'Pick a SABnzbd category of its own for Stashboard, like “stashboard”.',
      );
    }
    let destination = current.destination;
    if (update.destination !== undefined) {
      destination = update.destination.trim()
        ? await this.checkDestination(update.destination)
        : null;
    }
    const enabled = update.enabled ?? current.enabled;
    if (enabled && !destination) {
      throw new BadRequestException(
        'Pick the folder finished downloads go to first.',
      );
    }
    const saved = await this.prisma.downloadHandoffSettings.update({
      where: { key: HANDOFF_SETTINGS_KEY },
      data: {
        enabled,
        category,
        destination,
        ...(update.sabPathFrom !== undefined
          ? { sabPathFrom: cleanFolder(update.sabPathFrom) }
          : {}),
        ...(update.sabPathTo !== undefined
          ? { sabPathTo: cleanFolder(update.sabPathTo) }
          : {}),
        ...(update.importMode !== undefined
          ? { importMode: update.importMode }
          : {}),
        ...(update.dropIns !== undefined ? { dropIns: update.dropIns } : {}),
      },
    });
    this.logger.log(
      `Finished downloads settings saved: ${saved.enabled ? 'on' : 'off'}, category “${saved.category}”, destination ${saved.destination ?? 'not set'}, ${importModeOf(saved.importMode)} mode, drop-ins ${saved.dropIns ? 'on' : 'off'}.`,
    );
    return this.toSettingsDto(saved);
  }

  /** A folder inside one of Stash's library folders, or a plain refusal. */
  private async checkDestination(value: string): Promise<string> {
    const wanted = value.trim().replace(/[\\/]+$/, '');
    if (
      !/^([\\/]|[a-z]:[\\/])/i.test(wanted) ||
      wanted.split(/[\\/]/).some((part) => part === '..' || part === '.')
    ) {
      throw new BadRequestException(
        'Write the destination as a full folder path, like /data/downloads.',
      );
    }
    const config = await this.stashConfig();
    if (!config) {
      throw new ConflictException(
        'Set up Stash first: the destination has to be one of its library folders.',
      );
    }
    let roots: string[];
    try {
      roots = await this.stash.getLibraryRoots(config);
    } catch (error) {
      this.logger.warn(
        `Couldn't read Stash's library folders to check the destination: ${messageOf(error)}`,
      );
      throw new ConflictException(
        'Couldn’t ask Stash for its library folders, so the destination wasn’t saved.',
      );
    }
    if (!insideLibrary(wanted, roots)) {
      throw new BadRequestException(
        `Pick a folder inside one of Stash’s library folders (${roots.join(', ') || 'none set up'}), so Stash finds what’s downloaded.`,
      );
    }
    return wanted;
  }

  // ---------- sending ----------

  /** True when "Find downloads" should send usenet releases to SABnzbd. */
  async isActive(): Promise<boolean> {
    try {
      const settings = await this.getSettings();
      return (
        settings.enabled &&
        !!settings.destination &&
        (await this.sabConfig()) !== null
      );
    } catch (error) {
      this.logger.debug(
        `Couldn't tell whether Finished downloads is on: ${messageOf(error)}`,
      );
      return false;
    }
  }

  /**
   * Hands an NZB to SABnzbd under Stashboard's category and remembers it, so
   * it's moved into the library once it finishes.
   */
  async send(input: {
    nzb: { content: Uint8Array; fileName: string | null };
    releaseTitle: string;
    scene: { id: string; provider: CatalogProviderKey; title: string | null };
  }): Promise<DownloadHandoffDto> {
    const [settings, config] = await Promise.all([
      this.getSettings(),
      this.sabConfig(),
    ]);
    if (!config) {
      this.logger.warn('SABnzbd is not set up, so the download was not sent.');
      throw new ConflictException(
        'Set up SABnzbd in Settings → Integrations to send downloads to it.',
      );
    }
    const releaseTitle = input.releaseTitle.trim() || 'Download';
    const nzoId = await this.sabnzbd.addNzb(config, {
      content: input.nzb.content,
      fileName: nzbFileName(input.nzb.fileName, releaseTitle),
      category: settings.category,
      name: releaseTitle,
    });
    const row = await this.prisma.downloadHandoff.create({
      data: {
        nzoId,
        sceneId: input.scene.id,
        provider: input.scene.provider,
        releaseTitle,
        status: 'sent',
      },
    });
    const label = getCatalogProviderLabel(input.scene.provider);
    this.logger.log(
      `Sent “${releaseTitle}” to SABnzbd (job ${nzoId}, category “${settings.category}”) for ${label} scene ${input.scene.id}.`,
    );
    await this.activity?.record({
      kind: 'download',
      title: input.scene.title
        ? `Sent “${input.scene.title}” to SABnzbd`
        : 'Sent a release to SABnzbd',
      detail: [
        releaseTitle,
        `For ${label} scene ${input.scene.id}, in SABnzbd’s “${settings.category}” category.`,
        `Once it’s done it goes to ${settings.destination ?? 'your library'}.`,
      ].join('\n'),
    });
    return toDto(row);
  }

  // ---------- what's happening ----------

  /** The latest downloads sent to SABnzbd, newest first. */
  async recent(limit = RECENT_LIMIT): Promise<DownloadHandoffDto[]> {
    const rows = await this.prisma.downloadHandoff.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toDto);
  }

  /** Downloads sent for these catalog scenes, newest first. */
  async forScenes(
    sceneIds: string[],
    limit = 5,
  ): Promise<DownloadHandoffDto[]> {
    if (sceneIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.downloadHandoff.findMany({
      where: { sceneId: { in: sceneIds } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toDto);
  }

  /** Stops watching one download. Nothing in SABnzbd or on disk changes. */
  async ignore(id: string): Promise<DownloadHandoffDto> {
    const row = await this.prisma.downloadHandoff.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('That download isn’t listed any more.');
    }
    if (!OPEN_HANDOFF_STATUSES.includes(row.status as HandoffStatus)) {
      return toDto(row);
    }
    this.logger.log(`Stopped watching download “${row.releaseTitle}”.`);
    return toDto(
      await this.prisma.downloadHandoff.update({
        where: { id },
        data: {
          status: 'ignored',
          error: 'You stopped watching it.',
          finishedAt: new Date(),
        },
      }),
    );
  }

  /**
   * Tries a failed download again: one already moved goes back to waiting
   * for Stash; one that wasn't is looked for in SABnzbd's history again on
   * the next check, which runs straight away.
   */
  async retry(id: string): Promise<DownloadHandoffDto> {
    const row = await this.prisma.downloadHandoff.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('That download isn’t listed any more.');
    }
    if (row.status !== 'failed') {
      return toDto(row);
    }
    const status: HandoffStatus = row.finalPath ? 'completed' : 'sent';
    this.logger.log(`Trying download “${row.releaseTitle}” again.`);
    const updated = await this.prisma.downloadHandoff.update({
      where: { id },
      data: { status, attempts: 0, error: null, finishedAt: null },
    });
    // In the background: the answer doesn't wait for SABnzbd or Stash.
    void this.watch();
    return toDto(updated);
  }

  // ---------- watching ----------

  /**
   * Looks at SABnzbd for the downloads Stashboard sent, when there are any.
   * Never throws: a problem is logged and tried again next time.
   */
  @Interval(WATCH_INTERVAL_MS)
  async watch(): Promise<void> {
    if (this.watching) {
      return;
    }
    this.watching = true;
    try {
      await this.checkOpen();
      jobHeartbeats.record('download-watch', 'ok');
    } catch (error) {
      jobHeartbeats.record('download-watch', 'failed', messageOf(error));
      this.logger.warn(
        `Checking finished downloads failed: ${messageOf(error)}`,
      );
    } finally {
      this.watching = false;
    }
  }

  /** One pass over the open downloads; exposed for tests. */
  async checkOpen(): Promise<void> {
    const open = await this.prisma.downloadHandoff.findMany({
      where: { status: { in: OPEN_HANDOFF_STATUSES } },
      orderBy: { createdAt: 'asc' },
      take: MAX_OPEN,
    });
    if (open.length === 0) {
      return;
    }
    const settings = await this.getSettings();
    // Turned off: nothing is moved until it's turned back on.
    if (!settings.enabled) {
      this.logger.debug(
        `${open.length} download(s) waiting, but Finished downloads is off.`,
      );
      return;
    }
    this.logger.debug(`Checking ${open.length} open download(s).`);

    const waiting = open.filter((row) => row.status !== 'completed');
    // Moved on an earlier check: Stash still has to find it, and it has to
    // be linked. (Ones moved now are tried straight away.)
    const moved = open.filter((row) => row.status === 'completed');
    if (waiting.length > 0) {
      const config = await this.sabConfig();
      if (config) {
        await this.checkWithSabnzbd(config, settings, waiting);
      } else {
        this.logger.warn(
          `${waiting.length} download(s) waiting, but SABnzbd is not set up.`,
        );
      }
    }

    for (const row of moved) {
      await this.linkMoved(row).catch((error: unknown) =>
        this.logger.warn(
          `Linking download ${row.nzoId} failed: ${messageOf(error)}`,
        ),
      );
    }
  }

  private async checkWithSabnzbd(
    config: SabnzbdAdapterBaseConfig,
    settings: DownloadHandoffSettings,
    rows: DownloadHandoff[],
  ): Promise<void> {
    const history = await this.sabnzbd.history(config, settings.category);
    // Only SABnzbd's ids Stashboard sent itself; everything else is ignored.
    const ours = new Map(
      history
        .filter((entry) => rows.some((row) => row.nzoId === entry.nzoId))
        .map((entry) => [entry.nzoId, entry]),
    );
    // Read once, when needed; null when SABnzbd's queue couldn't be read.
    let queued: Set<string> | null | undefined;
    for (const row of rows) {
      const entry = ours.get(row.nzoId);
      try {
        if (entry) {
          await this.handleHistoryEntry(config, row, entry, settings);
          continue;
        }
        if (queued === undefined) {
          const queue = await this.sabnzbd
            .queue(config, settings.category)
            .catch((error: unknown) => {
              this.logger.warn(
                `Couldn't read SABnzbd's queue: ${messageOf(error)}`,
              );
              return null;
            });
          queued = queue ? new Set(queue.map((item) => item.nzoId)) : null;
        }
        if (!queued) {
          // Can't tell whether SABnzbd still has it; ask again next time.
          continue;
        }
        if (queued.has(row.nzoId)) {
          if (row.status !== 'downloading') {
            this.logger.log(`SABnzbd is downloading “${row.releaseTitle}”.`);
            await this.setStatus(row, 'downloading');
          }
        } else if (Date.now() - row.createdAt.getTime() > FORGOTTEN_AFTER_MS) {
          this.logger.warn(
            `SABnzbd no longer lists “${row.releaseTitle}” (job ${row.nzoId}); stopped watching it.`,
          );
          await this.setStatus(row, 'ignored', {
            error:
              'SABnzbd doesn’t list it any more (removed from its queue or history), so Stashboard stopped watching it.',
            finishedAt: new Date(),
          });
        }
      } catch (error) {
        this.logger.warn(
          `Checking download ${row.nzoId} failed: ${messageOf(error)}`,
        );
      }
    }
  }

  private async handleHistoryEntry(
    config: SabnzbdAdapterBaseConfig,
    row: DownloadHandoff,
    entry: SabnzbdHistoryEntry,
    settings: DownloadHandoffSettings,
  ): Promise<void> {
    // Moved to another category in SABnzbd: someone else's now.
    if (
      entry.category &&
      entry.category.toLowerCase() !== settings.category.toLowerCase()
    ) {
      await this.fail(
        row,
        `SABnzbd has it in the “${entry.category}” category now, so Stashboard left it alone.`,
      );
      return;
    }
    const status = entry.status.toLowerCase();
    if (status === 'failed') {
      await this.fail(
        row,
        `SABnzbd couldn’t download it: ${entry.failMessage ?? 'it gave no reason'}.`,
      );
      return;
    }
    if (status !== 'completed') {
      // Still verifying, repairing or unpacking.
      if (row.status !== 'downloading') {
        await this.setStatus(row, 'downloading');
      }
      return;
    }
    this.logger.log(`SABnzbd finished downloading “${row.releaseTitle}”.`);
    const moved = await this.moveFinished(config, row, entry, settings);
    if (moved) {
      await this.linkMoved(moved);
    }
  }

  /** Moves the finished video into the destination folder; null when it couldn't. */
  private async moveFinished(
    config: SabnzbdAdapterBaseConfig,
    row: DownloadHandoff,
    entry: SabnzbdHistoryEntry,
    settings: DownloadHandoffSettings,
  ): Promise<DownloadHandoff | null> {
    if (!entry.storage) {
      await this.fail(row, 'SABnzbd didn’t say where it put the download.');
      return null;
    }
    if (!settings.destination) {
      await this.fail(row, 'No destination folder is set.');
      return null;
    }
    // The destination is checked again: Stash's library folders can change.
    const stash = await this.stashConfig();
    const roots = stash
      ? await this.stash.getLibraryRoots(stash).catch((error: unknown) => {
          this.logger.warn(
            `Couldn't read Stash's library folders: ${messageOf(error)}`,
          );
          return null;
        })
      : null;
    if (!roots) {
      // Stash can't be asked right now; try again next time.
      this.logger.warn(
        `Waiting to move “${row.releaseTitle}”: Stash ${stash ? 'could not be reached' : 'is not set up'}. Trying again next check.`,
      );
      return null;
    }
    if (!insideLibrary(settings.destination, roots)) {
      await this.fail(
        row,
        `The destination ${settings.destination} isn’t inside one of Stash’s library folders any more; left the download in SABnzbd’s folder.`,
      );
      return null;
    }
    const folder = mapPath(
      entry.storage,
      settings.sabPathFrom,
      settings.sabPathTo,
    );
    try {
      const video = await findMainVideo(folder);
      if (!video) {
        throw new HandoffFileError(
          `No video file in ${folder}. If Stashboard can’t see that folder, check the folder mapping.`,
        );
      }
      const finalPath = await placeVideo({
        source: video,
        destination: settings.destination,
        mode: importModeOf(settings.importMode),
        tag: row.id,
        within: settings.sabPathTo || folder,
      });
      const updated = await this.prisma.downloadHandoff.update({
        where: { id: row.id },
        data: {
          status: 'completed',
          sabPath: entry.storage,
          finalPath,
          error: null,
          attempts: 0,
        },
      });
      this.logger.log(
        `${importModeOf(settings.importMode) === 'copy' ? 'Copied' : 'Moved'} “${row.releaseTitle}” to ${finalPath}.`,
      );
      // Moved, not copied: SABnzbd's folder for it is only leftovers now.
      if (importModeOf(settings.importMode) === 'move' && video !== folder) {
        await this.cleanUpJobFolder(config, settings, folder, row.releaseTitle);
      }
      return updated;
    } catch (error) {
      await this.fail(row, messageOf(error), { sabPath: entry.storage });
      return null;
    }
  }

  /**
   * Removes a download's own folder in SABnzbd's category folder once its
   * video is out, with the leftovers (see removeJobFolder). When it has to
   * stay, Activity says why. Never throws.
   */
  async cleanUpJobFolder(
    config: SabnzbdAdapterBaseConfig,
    settings: DownloadHandoffSettings,
    folder: string,
    name: string,
    options: { quietAboutVideos?: boolean } = {},
  ): Promise<JobFolderCleanup | null> {
    try {
      const folders = await this.sabFolders(config, settings);
      const result: JobFolderCleanup = folders.category
        ? await removeJobFolder({
            folder,
            categoryFolder: folders.category,
            completedFolder: folders.completed,
          })
        : {
            result: 'kept',
            folder,
            reason: `SABnzbd didn’t say where its “${settings.category}” downloads go.`,
            videos: [],
          };
      if (result.result === 'removed') {
        this.logger.log(`Removed SABnzbd's folder ${folder}.`);
      } else if (result.result === 'kept') {
        this.logger.log(
          `Left SABnzbd's folder ${folder} for “${name}”: ${result.reason}`,
        );
      }
      if (
        result.result === 'kept' &&
        !(options.quietAboutVideos && result.videos.length > 0)
      ) {
        await this.activity?.record({
          kind: 'download',
          title: `Left SABnzbd’s folder for “${name}”`,
          detail: result.reason,
          status: 'partial',
        });
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Cleaning up SABnzbd's folder ${folder} failed: ${messageOf(error)}`,
      );
      return null;
    }
  }

  /**
   * SABnzbd's completed folder and the category's folder, as Stashboard sees
   * them (through the folder mapping); null where SABnzbd doesn't say.
   */
  async sabFolders(
    config: SabnzbdAdapterBaseConfig,
    settings: DownloadHandoffSettings,
  ): Promise<SabFolders> {
    const folders = await this.sabnzbd.categoryFolders(
      config,
      settings.category,
    );
    const map = (value: string | null) =>
      value ? mapPath(value, settings.sabPathFrom, settings.sabPathTo) : null;
    return {
      completed: map(folders.completed),
      category: map(folders.category),
      sabCompleted: folders.completed,
      sabCategory: folders.category,
      found: folders.found ?? true,
      ownFolder: folders.ownFolder ?? folders.category !== folders.completed,
      jobFolders: folders.jobFolders ?? true,
    };
  }

  /**
   * Has Stash scan the folder the file went to, finds the new scene by its
   * exact path, and links it to the catalog scene it was downloaded for.
   */
  private async linkMoved(row: DownloadHandoff): Promise<void> {
    if (!row.finalPath) {
      await this.fail(row, 'Stashboard lost track of where the file went.');
      return;
    }
    const config = await this.stashConfig();
    if (!config) {
      this.logger.warn(
        `Can't link “${row.releaseTitle}” yet: Stash is not set up.`,
      );
      return;
    }
    const finalPath = row.finalPath;
    let sceneId: string | undefined;
    try {
      sceneId = await this.findInStash(config, finalPath);
    } catch (error) {
      await this.retryLater(
        row,
        `Moved to ${finalPath}, but Stash couldn’t scan it: ${messageOf(error)}`,
      );
      return;
    }
    if (!sceneId) {
      await this.retryLater(
        row,
        `Moved to ${finalPath}, but Stash hasn’t picked it up.`,
      );
      return;
    }

    const provider = providerOf(row.provider);
    let linked: { title: string | null };
    try {
      linked = await this.organizer.linkDownloadedScene(sceneId, {
        provider,
        sceneId: row.sceneId,
      });
    } catch (error) {
      await this.retryLater(
        row,
        `Moved to ${finalPath}, but linking it failed: ${messageOf(error)}`,
        sceneId,
      );
      return;
    }
    const placed = await this.placeInFolder(sceneId, finalPath);
    await this.generatePreviews(config, sceneId);

    await this.prisma.downloadHandoff.update({
      where: { id: row.id },
      data: {
        status: 'imported',
        stashSceneId: sceneId,
        finalPath: placed.to,
        error: null,
        finishedAt: new Date(),
      },
    });
    const label = getCatalogProviderLabel(provider);
    this.logger.log(
      `Imported “${linked.title ?? row.releaseTitle}” into the library as Stash scene ${sceneId}, linked to ${label} scene ${row.sceneId}${placed.to !== finalPath ? `, placed in ${placed.to}` : ''}.`,
    );
    if (placed.reason) {
      this.logger.warn(placed.reason);
    }
    await this.activity?.record({
      kind: 'download',
      title: linked.title
        ? `Downloaded “${linked.title}” into your library`
        : 'Downloaded a scene into your library',
      detail: [
        `${row.sabPath ?? row.releaseTitle} → ${finalPath}`,
        ...placedLines(finalPath, placed),
        `Linked to ${label} scene ${row.sceneId}.`,
      ].join('\n'),
      ...(placed.reason ? { status: 'partial' as const } : {}),
    });
  }

  /**
   * Has Stash scan the folder a file went to and finds its scene by the
   * exact path; undefined when Stash hasn't picked it up. Throws when Stash
   * couldn't scan.
   */
  async findInStash(
    config: StashAdapterBaseConfig,
    file: string,
  ): Promise<string | undefined> {
    const job = await this.stash.scanLibraryFolders(config, [
      path.dirname(file),
    ]);
    this.logger.log(`Started a Stash scan of ${path.dirname(file)}.`);
    if (job) {
      await this.stash.waitForJob(config, job, {
        sleep: this.sleep,
        timeoutMs: SCAN_TIMEOUT_MS,
      });
    }
    const [sceneId] = await this.stash.sceneIdsForPaths(config, [file]);
    this.logger.debug(
      sceneId
        ? `Stash matched ${file} to scene ${sceneId}.`
        : `Stash has no scene for ${file} yet.`,
    );
    return sceneId;
  }

  /**
   * Puts a linked scene's file into its own folder inside the destination,
   * named by the rename pattern. Never throws: when it can't, the file stays
   * and the reason comes back.
   */
  async placeInFolder(
    sceneId: string,
    file: string,
  ): Promise<{ to: string; reason: string | null }> {
    const { destination } = await this.getSettings();
    if (!destination) {
      return { to: file, reason: null };
    }
    return this.organizer
      .placeInSceneFolder(sceneId, file, destination)
      .catch((error: unknown) => ({
        to: file,
        reason: `Couldn’t put it in its own folder: ${messageOf(error)}`,
      }));
  }

  /** Previews for the new scene, if Automation makes them for new scenes. */
  async generatePreviews(
    config: StashAdapterBaseConfig,
    sceneId: string,
  ): Promise<void> {
    const automation = await this.prisma.libraryAutomationSettings
      .findUnique({ where: { key: 'GLOBAL' } })
      .catch((error: unknown) => {
        this.logger.debug(
          `Couldn't read automation settings: ${messageOf(error)}`,
        );
        return null;
      });
    // Automation's own default is on.
    if (automation && !automation.generateNew) {
      this.logger.debug(
        `Skipping previews for scene ${sceneId}: automation doesn't generate for new scenes.`,
      );
      return;
    }
    await this.stash
      .startLibraryTask(config, 'generate', [sceneId])
      .then(() =>
        this.logger.debug(`Started generating previews for scene ${sceneId}.`),
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `Couldn't start previews for scene ${sceneId}: ${messageOf(error)}`,
        ),
      );
  }

  /** Waits for the next check; after a few misses, gives up with the reason. */
  private async retryLater(
    row: DownloadHandoff,
    reason: string,
    stashSceneId?: string,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    if (attempts < MAX_LINK_ATTEMPTS) {
      this.logger.warn(
        `“${row.releaseTitle}”: ${reason} Trying again (attempt ${attempts} of ${MAX_LINK_ATTEMPTS}).`,
      );
    }
    if (attempts >= MAX_LINK_ATTEMPTS) {
      await this.fail(row, `${reason} Link it in Library Tools.`, {
        attempts,
        ...(stashSceneId ? { stashSceneId } : {}),
      });
      return;
    }
    await this.prisma.downloadHandoff.update({
      where: { id: row.id },
      data: {
        attempts,
        error: `${reason} Trying again shortly.`,
        ...(stashSceneId ? { stashSceneId } : {}),
      },
    });
  }

  private async fail(
    row: DownloadHandoff,
    reason: string,
    extra: Partial<
      Pick<DownloadHandoff, 'sabPath' | 'attempts' | 'stashSceneId'>
    > = {},
  ): Promise<void> {
    this.logger.error(
      `Couldn't bring “${row.releaseTitle}” into the library: ${reason}`,
    );
    await this.setStatus(row, 'failed', {
      ...extra,
      error: reason,
      finishedAt: new Date(),
    });
    await this.activity?.record({
      kind: 'download',
      title: `Couldn’t bring “${row.releaseTitle}” into your library`,
      detail: reason,
      status: 'failed',
    });
  }

  private async setStatus(
    row: DownloadHandoff,
    status: HandoffStatus,
    data: Partial<DownloadHandoff> = {},
  ): Promise<void> {
    await this.prisma.downloadHandoff.update({
      where: { id: row.id },
      data: { ...data, status },
    });
  }

  // ---------- connections ----------

  /** SABnzbd's address and key, when it's turned on and passed its test. */
  async sabConfig(): Promise<SabnzbdAdapterBaseConfig | null> {
    const integration = await this.prisma.integrationConfig
      .findUnique({ where: { type: 'SABNZBD' } })
      .catch(() => null);
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== IntegrationStatus.CONFIGURED ||
      !baseUrl
    ) {
      return null;
    }
    return { baseUrl, apiKey: integration.apiKey };
  }

  async stashConfig(): Promise<StashAdapterBaseConfig | null> {
    const integration = await this.prisma.integrationConfig
      .findUnique({ where: { type: 'STASH' } })
      .catch(() => null);
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== IntegrationStatus.CONFIGURED ||
      !baseUrl
    ) {
      return null;
    }
    return { baseUrl, apiKey: integration.apiKey };
  }

  private async toSettingsDto(
    settings: DownloadHandoffSettings,
  ): Promise<DownloadHandoffSettingsDto> {
    const [sab, stash] = await Promise.all([
      this.sabConfig(),
      this.stashConfig(),
    ]);
    const libraryRoots = stash
      ? await this.stash.getLibraryRoots(stash).catch(() => [] as string[])
      : [];
    const folders = sab
      ? await this.sabFolders(sab, settings).catch(() => null)
      : null;
    return {
      enabled: settings.enabled,
      category: settings.category || DEFAULT_HANDOFF_CATEGORY,
      destination: settings.destination,
      sabPathFrom: settings.sabPathFrom,
      sabPathTo: settings.sabPathTo,
      importMode: importModeOf(settings.importMode),
      dropIns: settings.dropIns,
      dropInFolder: folders?.category ?? null,
      sabnzbdReady: sab !== null,
      libraryRoots,
    };
  }
}

/** SABnzbd's folders for Stashboard's category (see sabFolders). */
export interface SabFolders {
  /** The Completed Download Folder, as Stashboard sees it. */
  completed: string | null;
  /** The category's folder, as Stashboard sees it. */
  category: string | null;
  /** The same two, as SABnzbd sees them. */
  sabCompleted: string | null;
  sabCategory: string | null;
  /** SABnzbd has a category by that name. */
  found: boolean;
  /** The category has a folder of its own. */
  ownFolder: boolean;
  /** Each download gets a folder of its own. */
  jobFolders: boolean;
}

/** True when folder is one of Stash's library folders or inside one. */
export function insideLibrary(folder: string, roots: string[]): boolean {
  const clean = folder.replace(/[\\/]+$/, '');
  return (
    roots.some((root) => root.replace(/[\\/]+$/, '') === clean) ||
    findRoot(clean, roots) !== null
  );
}

/** Activity lines for where a file went after "placeInFolder". */
export function placedLines(
  from: string,
  placed: { to: string; reason: string | null },
): string[] {
  return [
    ...(placed.to !== from ? [`Put in its folder: ${placed.to}`] : []),
    ...(placed.reason ? [placed.reason] : []),
  ];
}

export function toDto(row: DownloadHandoff): DownloadHandoffDto {
  return {
    id: row.id,
    sceneId: row.sceneId,
    provider: providerOf(row.provider),
    releaseTitle: row.releaseTitle,
    status: row.status as HandoffStatus,
    error: row.error,
    finalPath: row.finalPath,
    stashSceneId: row.stashSceneId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function providerOf(value: string): CatalogProviderKey {
  return (CATALOG_PROVIDER_KEYS as readonly string[]).includes(value)
    ? (value as CatalogProviderKey)
    : 'STASHDB';
}

function importModeOf(value: string): HandoffImportMode {
  return value === 'copy' ? 'copy' : 'move';
}

function cleanFolder(value: string): string | null {
  return value.trim().replace(/[\\/]+$/, '') || null;
}

/** A name SABnzbd accepts for the uploaded file; it has to end in .nzb. */
function nzbFileName(given: string | null, title: string): string {
  const base = (given?.trim() || title)
    .replace(/\.nzb$/i, '')
    .replace(/[\\/:*?"<>|\0]+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${base || 'download'}.nzb`;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'unknown error';
}
