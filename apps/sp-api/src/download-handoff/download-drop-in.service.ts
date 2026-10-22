import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DownloadDropIn, DownloadHandoffSettings } from '@prisma/client';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ActivityService } from '../activity/activity.service';
import { SettleTracker } from '../automation/folder-watch.util';
import { OrganizerService } from '../organizer/organizer.service';
import { mapPath } from '../organizer/whisparr-handoff.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SabnzbdAdapter,
  SabnzbdAdapterBaseConfig,
} from '../providers/sabnzbd/sabnzbd.adapter';
import { StashAdapter } from '../providers/stash/stash.adapter';
import {
  type DropInSkipReason,
  isInside,
  placeVideo,
  scanDropInFolder,
} from './download-handoff.files';
import {
  DownloadHandoffService,
  insideLibrary,
  placedLines,
  type SabFolders,
} from './download-handoff.service';
import {
  DEFAULT_HANDOFF_CATEGORY,
  type DownloadDropInDto,
  type DropInSkippedDto,
  type DropInSkippedReason,
  type DropInStatus,
  type DropInWatchReason,
  type DropInWatchState,
  type DropInWatchStatusDto,
} from './download-handoff.model';

/** How often the category's folder is looked at when nothing is settling. */
const WATCH_INTERVAL_MS = 2 * 60_000;
/** How often the schedule is looked at; a check runs only when it's due. */
const TICK_MS = 15_000;
/**
 * How long a file has to stay the same (size and modified time) before it's
 * brought in. While files are settling, the folder is looked at this often,
 * so a dropped file is in within a minute or so of being noticed.
 */
const SETTLE_MS = 45_000;
/** Settled files brought in per check; the rest wait for the next one. */
const MAX_PER_CHECK = 10;
/** Checks in a row Stash may miss the file before giving up. */
const MAX_LINK_ATTEMPTS = 5;
/** Finished SABnzbd downloads remembered, so their folders are never taken. */
const TRACKED_LIMIT = 500;
const RECENT_LIMIT = 20;

const MAPPING_HINT =
  'Make sure that folder is mounted into Stashboard’s container. If Stashboard sees it at a different path than SABnzbd does, set “Path in SABnzbd” and “Same folder in Stashboard” in Settings → Integrations → SABnzbd → Finished downloads.';

const SKIP_DETAILS: Record<DropInSkipReason, string> = {
  'sab-job':
    'SABnzbd’s own download (in its queue or history); Finished downloads takes care of it.',
  'sab-working': 'SABnzbd is still unpacking this, or it failed there.',
  sample: 'Looks like a sample (“sample” in its name or folder).',
  'not-video': 'Not a video file Stash would scan.',
  hidden:
    'A hidden file (its name starts with a dot); a copy still in progress often looks like this.',
  link: 'A link; links aren’t followed.',
  'too-deep': 'Nested more than 4 folders deep, so it isn’t looked inside.',
};

/** The watcher's state, kept in memory and shown on the Processing page. */
interface WatchStatus {
  state: DropInWatchState;
  reason: DropInWatchReason | null;
  message: string | null;
  hint: string | null;
  folder: string | null;
  sabFolder: string | null;
}

/**
 * Drop-ins: with "Also bring in files I put in this folder" on, videos put
 * straight into SABnzbd's folder for Stashboard's category (by hand, or by
 * anything but SABnzbd) are brought into the library too, like finished
 * downloads: moved (or copied) into the destination, found by Stash,
 * identified the way new files are, given previews, and put in their
 * pattern folder once matched.
 *
 * Never touched: SABnzbd's own downloads (anything in its queue or history
 * for the category, or tracked as a finished download), files still being
 * written, samples and links. A copied file is remembered, so it isn't
 * brought in twice. Off by default.
 *
 * What it's doing is kept in memory (status()) for the Processing page:
 * whether it's watching and why not, the folder, what's settling and what
 * was left alone. Starting, stopping and problems are logged once each, and
 * noticed, brought-in and failed files go to Activity.
 */
@Injectable()
export class DownloadDropInService {
  private readonly logger = new Logger(DownloadDropInService.name);
  private running: Promise<void> | null = null;
  /** Files seen in the folder, until they stop changing. */
  readonly settling: SettleTracker;

  private watchStatus: WatchStatus = {
    state: 'off',
    reason: 'starting',
    message: 'Stashboard hasn’t looked at the folder yet since it started.',
    hint: null,
    folder: null,
    sabFolder: null,
  };
  /** The state last logged, so each change is said once, not every check. */
  private announcedKey: string | null = null;
  private category = DEFAULT_HANDOFF_CATEGORY;
  private lastCheckAt: number | null = null;
  private lastResult: string | null = null;
  private nextCheckAt = Date.now() + TICK_MS;
  private lastError: { message: string; at: number } | null = null;
  private skipped: DropInSkippedDto[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly handoff: DownloadHandoffService,
    private readonly sabnzbd: SabnzbdAdapter,
    private readonly stash: StashAdapter,
    private readonly organizer: OrganizerService,
  ) {
    this.settling = new SettleTracker(undefined, SETTLE_MS);
  }

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  /** The latest videos brought in, newest first. */
  async recent(limit = RECENT_LIMIT): Promise<DownloadDropInDto[]> {
    const rows = await this.prisma.downloadDropIn.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toDropInDto);
  }

  /** What the watcher is doing, as of its last check. */
  status(): DropInWatchStatusDto {
    const iso = (value: number | null) =>
      value === null ? null : new Date(value).toISOString();
    const status = this.watchStatus;
    return {
      state: status.state,
      reason: status.state === 'watching' ? null : status.reason,
      message: status.state === 'watching' ? null : status.message,
      hint: status.state === 'watching' ? null : status.hint,
      category: this.category,
      folder: status.folder,
      sabFolder: status.sabFolder,
      checking: this.running !== null,
      lastCheckAt: iso(this.lastCheckAt),
      lastResult: this.lastResult,
      nextCheckAt: iso(this.nextCheckAt),
      settleSeconds: Math.round(SETTLE_MS / 1000),
      settling: this.settling.list().map((file) => ({
        path: file.path,
        name: path.basename(file.path),
        size: file.size,
        firstSeenAt: new Date(file.firstSeen).toISOString(),
        unchangedSince: iso(file.stableSince),
      })),
      skipped: this.skipped,
      lastError: this.lastError
        ? {
            message: this.lastError.message,
            at: new Date(this.lastError.at).toISOString(),
          }
        : null,
    };
  }

  /** Looks at the folder now, instead of waiting for the next check. */
  async checkNow(): Promise<DropInWatchStatusDto> {
    if (this.running) {
      // One is already on its way; wait for it, then look again so what
      // was dropped just now is seen.
      await this.running;
    }
    await this.watch();
    return this.status();
  }

  /**
   * Tries a failed drop-in again: one already moved goes back to waiting
   * for Stash; one that never moved is forgotten, so it's picked up again
   * if it's still in the folder.
   */
  async retry(id: string): Promise<DownloadDropInDto | null> {
    const row = await this.prisma.downloadDropIn.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('That file isn’t listed any more.');
    }
    if (row.status !== 'failed') {
      return toDropInDto(row);
    }
    this.logger.log(`Trying drop-in ${row.sourcePath} again.`);
    let result: DownloadDropInDto | null;
    if (row.finalPath) {
      result = toDropInDto(
        await this.prisma.downloadDropIn.update({
          where: { id },
          data: {
            status: 'placed',
            attempts: 0,
            error: null,
            finishedAt: null,
          },
        }),
      );
    } else {
      await this.prisma.downloadDropIn.delete({ where: { id } });
      result = null;
    }
    this.nextCheckAt = Date.now();
    return result;
  }

  /** Runs a check when one is due (every 2 minutes, sooner while files settle). */
  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (Date.now() >= this.nextCheckAt) {
      await this.watch();
    }
  }

  /**
   * One check, unless one is running. Never throws: a problem is logged and
   * tried again next time.
   */
  async watch(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = this.check()
      .catch((error: unknown) => {
        this.lastError = { message: messageOf(error), at: Date.now() };
        this.logger.warn(`Checking drop-ins failed: ${messageOf(error)}`);
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }

  /** One pass; exposed for tests. */
  async check(now = Date.now()): Promise<void> {
    this.lastCheckAt = now;
    try {
      await this.look(now);
    } finally {
      this.nextCheckAt =
        Date.now() + (this.settling.size > 0 ? SETTLE_MS : WATCH_INTERVAL_MS);
    }
  }

  private async look(now: number): Promise<void> {
    const settings = await this.handoff.getSettings();
    this.category = settings.category || DEFAULT_HANDOFF_CATEGORY;
    const off = offReason(settings);
    if (off) {
      this.settling.keepOnly(new Set());
      this.skipped = [];
      this.setOff(off.reason, off.message);
      return;
    }
    // Moved on an earlier check: Stash still has to pick them up.
    const placed = await this.prisma.downloadDropIn.findMany({
      where: { status: 'placed' },
      orderBy: { createdAt: 'asc' },
      take: MAX_PER_CHECK,
    });
    for (const row of placed) {
      await this.identify(row).catch((error: unknown) =>
        this.logger.warn(
          `Identifying ${row.sourcePath} failed: ${messageOf(error)}`,
        ),
      );
    }

    const config = await this.handoff.sabConfig();
    if (!config) {
      await this.setProblem({
        reason: 'sab-not-set-up',
        message:
          'SABnzbd isn’t set up, so Stashboard can’t tell which folder to watch.',
        hint: 'Add SABnzbd in Settings → Integrations and Save & Test it.',
      });
      return;
    }
    const found = await this.candidates(config, settings);
    if (!found) {
      return;
    }
    this.setWatching(found.folder, found.sabFolder);
    this.lastError = null;
    for (const file of found.files) {
      if (this.settling.add(file, now)) {
        await this.noticed(file);
      }
    }
    this.settling.keepOnly(new Set(found.files));
    const ready = (await this.settling.settled(now)).slice(0, MAX_PER_CHECK);
    this.lastResult = summary(found.files.length, ready.length, found.skipped);
    if (found.files.length > 0) {
      this.logger.debug(
        `Drop-ins in ${found.folder}: ${found.files.length} new video(s), ${ready.length} ready to bring in.`,
      );
    }
    for (const file of ready) {
      await this.bringIn(config, settings, file, found.folder).catch(
        (error: unknown) => {
          this.lastError = {
            message: `Bringing in ${file} failed: ${messageOf(error)}`,
            at: Date.now(),
          };
          this.logger.warn(`Bringing in ${file} failed: ${messageOf(error)}`);
        },
      );
    }
  }

  /**
   * Videos in the category's folder that are fair game: not SABnzbd's own
   * (queued, unpacking, finished or tracked), not brought in before. Null
   * when that can't be told (SABnzbd or the folder can't be read); the
   * status says why.
   */
  private async candidates(
    config: SabnzbdAdapterBaseConfig,
    settings: DownloadHandoffSettings,
  ): Promise<{
    folder: string;
    sabFolder: string;
    files: string[];
    skipped: DropInSkippedDto[];
  } | null> {
    let folders: SabFolders;
    try {
      folders = await this.handoff.sabFolders(config, settings);
    } catch (error) {
      await this.setProblem({
        reason: 'sab-unreachable',
        message: `Couldn’t ask SABnzbd where its “${settings.category}” downloads go: ${messageOf(error)}`,
        hint: 'Check that SABnzbd is running and its address and API key in Settings → Integrations still work.',
      });
      return null;
    }
    const folder = folders.category?.replace(/(.)[\\/]+$/, '$1') ?? null;
    const sabFolder = folders.sabCategory;
    const where = { folder, sabFolder };
    if (!folders.found) {
      await this.setProblem({
        reason: 'category-missing',
        message: `SABnzbd has no “${settings.category}” category.`,
        hint: `Add a “${settings.category}” category in SABnzbd (Settings → Categories) with a folder of its own, like “stashboard-downloads”, or pick the right category in Settings → Integrations → SABnzbd → Finished downloads.`,
        ...where,
      });
      return null;
    }
    if (!folder || !sabFolder) {
      await this.setProblem({
        reason: 'folder-unknown',
        message: `SABnzbd didn’t say where its “${settings.category}” downloads go.`,
        hint: 'Check the Completed Download Folder in SABnzbd (Settings → Folders) and the category’s folder (Settings → Categories).',
        ...where,
      });
      return null;
    }
    if (!folders.ownFolder) {
      // Everything SABnzbd finishes, for every category, lands there.
      await this.setProblem({
        reason: 'shared-folder',
        message: `SABnzbd’s “${settings.category}” category has no folder of its own, so its downloads land in the shared Completed Download Folder (${sabFolder}) with everything else; Stashboard won’t take files from there.`,
        hint: `Give the category a folder in SABnzbd (Settings → Categories → Folder/Path), like “stashboard-downloads”, and drop files there.`,
        ...where,
      });
      return null;
    }
    if (!folders.jobFolders) {
      await this.setProblem({
        reason: 'no-job-folders',
        message: `SABnzbd’s “${settings.category}” folder ends in “*”, so its downloads don’t get folders of their own and can’t be told apart from files you put there.`,
        hint: 'Remove the “*” from the category’s Folder/Path in SABnzbd (Settings → Categories).',
        ...where,
      });
      return null;
    }
    if (!path.isAbsolute(folder)) {
      await this.setProblem({
        reason: 'relative-folder',
        message: `SABnzbd gives its folder as ${sabFolder}, which isn’t a full path, so Stashboard can’t tell where it is.`,
        hint: 'Set the Completed Download Folder in SABnzbd (Settings → Folders) to a full path like /downloads/complete.',
        ...where,
      });
      return null;
    }
    try {
      const stat = await fs.stat(folder);
      if (!stat.isDirectory()) {
        throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
      }
      await fs.readdir(folder);
    } catch (error) {
      await this.setProblem({
        reason: 'folder-unreadable',
        message: `Stashboard can’t open the drop-in folder ${folder}${folder !== sabFolder ? ` (SABnzbd calls it ${sabFolder})` : ''}: ${fsProblem(error)}.`,
        hint:
          folder === sabFolder && !settings.sabPathFrom
            ? `No folder mapping is set, so Stashboard looks for SABnzbd’s path as is. ${MAPPING_HINT}`
            : codeOf(error) === 'EACCES' || codeOf(error) === 'EPERM'
              ? 'Give Stashboard’s user (its PUID/PGID) permission to read and write that folder.'
              : MAPPING_HINT,
        ...where,
      });
      return null;
    }

    const [history, queue] = await Promise.all([
      this.sabnzbd.history(config, settings.category).catch(() => null),
      this.sabnzbd.queue(config, settings.category).catch(() => null),
    ]);
    if (!history || !queue) {
      await this.setProblem({
        reason: 'sab-lists-unreadable',
        message:
          'Couldn’t read SABnzbd’s queue or history, so its own downloads can’t be told apart from yours; nothing is brought in until it can.',
        hint: 'Check that SABnzbd is running and reachable.',
        ...where,
      });
      return null;
    }
    const tracked = await this.prisma.downloadHandoff.findMany({
      where: { sabPath: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: TRACKED_LIMIT,
      select: { sabPath: true },
    });
    const mapped = (value: string) =>
      mapPath(value, settings.sabPathFrom, settings.sabPathTo);
    const skip = [
      ...history.flatMap((entry) => (entry.storage ? [entry.storage] : [])),
      ...tracked.flatMap((row) => (row.sabPath ? [row.sabPath] : [])),
    ]
      .map(mapped)
      // A job's folder once it's done is named after the job.
      .concat(
        queue.flatMap((entry) =>
          entry.name ? [path.join(folder, entry.name)] : [],
        ),
      )
      .concat(settings.destination ? [settings.destination] : [])
      .map((entry) => entry.replace(/[\\/]+$/, ''))
      // Never the whole folder, or anything holding it.
      .filter((entry) => entry && !isInside(folder, entry));
    const scan = await scanDropInFolder(folder, skip);
    const skipped: DropInSkippedDto[] = scan.skipped.map((entry) =>
      skippedDto(entry.path, entry.reason, SKIP_DETAILS[entry.reason]),
    );
    const known = new Map(
      scan.videos.length === 0
        ? []
        : (
            await this.prisma.downloadDropIn.findMany({
              where: { sourcePath: { in: scan.videos } },
              select: {
                sourcePath: true,
                size: true,
                status: true,
                error: true,
              },
            })
          ).map((row) => [row.sourcePath, row]),
    );
    const fresh: string[] = [];
    for (const file of scan.videos) {
      const row = known.get(file);
      if (!row) {
        fresh.push(file);
        continue;
      }
      // Brought in before (a copy, or one that couldn't be moved): only a
      // different file at the same path counts as new.
      const stat = await fs.stat(file).catch(() => null);
      if (stat && BigInt(stat.size) !== row.size) {
        fresh.push(file);
      } else if (row.status === 'failed') {
        skipped.push(
          skippedDto(
            file,
            'failed-before',
            `Couldn’t be brought in before${row.error ? `: ${row.error}` : ''}. Retry it on the Processing page.`,
          ),
        );
      } else {
        skipped.push(
          skippedDto(file, 'brought-in', 'Already brought in (same file).'),
        );
      }
    }
    if (scan.truncated) {
      this.logger.warn(
        `The drop-in folder ${folder} holds too many files to look through in one check; some were left for later.`,
      );
    }
    this.skipped = skipped;
    return { folder, sabFolder, files: fresh, skipped };
  }

  /** First sight of a file: said once, in the log and in Activity. */
  private async noticed(file: string): Promise<void> {
    const name = path.basename(file);
    this.logger.log(
      `Noticed ${file} in the drop-in folder; bringing it in once it stops changing.`,
    );
    await this.activity?.record({
      kind: 'download',
      title: `Noticed “${name}” in the drop-in folder`,
      detail: `${file}\nIt’s brought in once it has stopped changing for ${Math.round(SETTLE_MS / 1000)} seconds.`,
    });
  }

  private setWatching(folder: string, sabFolder: string): void {
    const key = `watching:${folder}`;
    if (this.announcedKey !== key) {
      const before = this.watchStatus;
      this.logger.log(
        before.state === 'watching' && before.folder !== folder
          ? `The drop-in folder changed to ${folder} (SABnzbd: ${sabFolder}); watching that instead of ${before.folder}.`
          : `Watching ${folder} (SABnzbd: ${sabFolder}) for drop-ins; videos put there are brought in once they stop changing.`,
      );
      this.announcedKey = key;
    }
    this.watchStatus = {
      state: 'watching',
      reason: null,
      message: null,
      hint: null,
      folder,
      sabFolder,
    };
  }

  private setOff(reason: DropInWatchReason, message: string): void {
    const key = `off:${reason}`;
    if (this.announcedKey !== key) {
      // Said only when it was on (or trying to be): not at every start.
      if (this.announcedKey !== null) {
        this.logger.log(`Stopped watching for drop-ins: ${message}`);
      }
      this.announcedKey = key;
    }
    this.watchStatus = {
      state: 'off',
      reason,
      message,
      hint: offHint(reason),
      folder: null,
      sabFolder: null,
    };
    this.lastResult = message;
  }

  /** Warned once per distinct problem, not every check. */
  private async setProblem(problem: {
    reason: DropInWatchReason;
    message: string;
    hint: string;
    folder?: string | null;
    sabFolder?: string | null;
  }): Promise<void> {
    this.settling.keepOnly(new Set());
    this.skipped = [];
    this.watchStatus = {
      state: 'problem',
      reason: problem.reason,
      message: problem.message,
      hint: problem.hint,
      folder: problem.folder ?? null,
      sabFolder: problem.sabFolder ?? null,
    };
    this.lastResult = problem.message;
    const key = `problem:${problem.reason}:${problem.folder ?? ''}`;
    if (this.announcedKey === key) {
      return;
    }
    this.announcedKey = key;
    this.logger.warn(
      `Can't watch for drop-ins: ${problem.message} ${problem.hint}`,
    );
    await this.activity?.record({
      kind: 'download',
      title: 'Can’t watch the drop-in folder',
      detail: `${problem.message}\n${problem.hint}`,
      status: 'failed',
    });
  }

  /** Moves (or copies) one settled video into the destination, then identifies it. */
  private async bringIn(
    config: SabnzbdAdapterBaseConfig,
    settings: DownloadHandoffSettings,
    file: string,
    folder: string,
  ): Promise<void> {
    const destination = settings.destination;
    const stat = await fs.stat(file).catch(() => null);
    if (!destination || !stat?.isFile()) {
      return;
    }
    // The destination is checked again: Stash's library folders can change.
    const stash = await this.handoff.stashConfig();
    const roots = stash
      ? await this.stash.getLibraryRoots(stash).catch((error: unknown) => {
          this.logger.warn(
            `Couldn't read Stash's library folders: ${messageOf(error)}`,
          );
          return null;
        })
      : null;
    if (!roots) {
      // Stash can't be asked right now; it's looked at again next time.
      const reason = `Waiting to bring in ${file}: Stash ${stash ? 'could not be reached' : 'is not set up'}.`;
      this.lastError = { message: reason, at: Date.now() };
      this.logger.warn(reason);
      return;
    }
    const name = path.basename(file);
    this.logger.log(`Picked up drop-in ${file}.`);
    const mode = settings.importMode === 'copy' ? 'copy' : 'move';
    let finalPath: string;
    try {
      if (!insideLibrary(destination, roots)) {
        throw new Error(
          `The destination ${destination} isn’t inside one of Stash’s library folders any more; left it where it is.`,
        );
      }
      finalPath = await placeVideo({
        source: file,
        destination,
        mode,
        tag: `dropin-${createHash('sha1').update(file).digest('hex').slice(0, 16)}`,
        within: folder,
      });
    } catch (error) {
      this.logger.error(
        `Couldn't bring in drop-in ${file}: ${messageOf(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.save(file, stat.size, {
        status: 'failed',
        error: messageOf(error),
        finishedAt: new Date(),
      });
      await this.activity?.record({
        kind: 'download',
        title: `Couldn’t bring in “${name}”`,
        detail: `${file}\n${messageOf(error)}`,
        status: 'failed',
      });
      return;
    }
    const row = await this.save(file, stat.size, {
      status: 'placed',
      finalPath,
      error: null,
    });
    this.logger.log(
      `${mode === 'copy' ? 'Copied' : 'Moved'} drop-in “${name}” to ${finalPath}.`,
    );

    // Moved out of a folder of its own: tidy that folder away, like a
    // finished download's. Other videos in it are brought in next, and the
    // last one out removes it, so those aren't worth a word.
    const inner = path.relative(folder, file).split(/[\\/]/);
    if (mode === 'move' && inner.length > 1) {
      await this.handoff.cleanUpJobFolder(
        config,
        settings,
        path.join(folder, inner[0]),
        name,
        { quietAboutVideos: true },
      );
    }
    await this.identify(row);
  }

  /**
   * Has Stash scan the folder the file went to, finds its scene by the
   * exact path, and identifies it the same way as new files: a fingerprint
   * match is saved, a likely one waits in "Check these matches". Matched,
   * it goes into its pattern folder. Previews follow Automation's setting.
   */
  private async identify(row: DownloadDropIn): Promise<void> {
    const config = await this.handoff.stashConfig();
    if (!config || !row.finalPath) {
      this.logger.debug(
        `Can't identify drop-in ${row.sourcePath} yet: ${config ? 'its new path is unknown' : 'Stash is not set up'}.`,
      );
      return;
    }
    const finalPath = row.finalPath;
    let sceneId: string | undefined;
    try {
      sceneId = await this.handoff.findInStash(config, finalPath);
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

    let outcome: string;
    let identified = false;
    try {
      const result = await this.organizer.identifyNewScenes([sceneId]);
      identified = !result.left.includes(sceneId);
      outcome = identified
        ? 'Identified and linked to its catalog scene.'
        : result.proposed.includes(sceneId)
          ? 'Found a likely match: check it in Library Tools → Check these matches.'
          : 'No match found yet; it’s with the unmatched scenes in Library Tools.';
    } catch (error) {
      outcome = `Couldn’t identify it: ${messageOf(error)}`;
      this.logger.warn(
        `Couldn't identify drop-in ${row.sourcePath} (Stash scene ${sceneId}): ${messageOf(error)}`,
      );
    }
    const placed = identified
      ? await this.handoff.placeInFolder(sceneId, finalPath)
      : { to: finalPath, reason: null };
    await this.handoff.generatePreviews(config, sceneId);

    await this.prisma.downloadDropIn.update({
      where: { id: row.id },
      data: {
        status: 'imported',
        stashSceneId: sceneId,
        finalPath: placed.to,
        error: null,
        finishedAt: new Date(),
      },
    });
    this.logger.log(
      `Brought drop-in “${path.basename(row.sourcePath)}” into the library as Stash scene ${sceneId}: ${outcome}`,
    );
    if (placed.reason) {
      this.logger.warn(placed.reason);
    }
    await this.activity?.record({
      kind: 'download',
      title: `Brought “${path.basename(row.sourcePath)}” into your library`,
      detail: [
        `${row.sourcePath} → ${finalPath}`,
        ...placedLines(finalPath, placed),
        outcome,
      ].join('\n'),
      ...(placed.reason ? { status: 'partial' as const } : {}),
    });
  }

  /** Waits for the next check; after a few misses, gives up with the reason. */
  private async retryLater(row: DownloadDropIn, reason: string): Promise<void> {
    const attempts = row.attempts + 1;
    if (attempts < MAX_LINK_ATTEMPTS) {
      this.logger.warn(
        `Drop-in ${path.basename(row.sourcePath)}: ${reason} Trying again (attempt ${attempts} of ${MAX_LINK_ATTEMPTS}).`,
      );
      await this.prisma.downloadDropIn.update({
        where: { id: row.id },
        data: { attempts, error: `${reason} Trying again shortly.` },
      });
      return;
    }
    this.logger.error(
      `Gave up bringing in drop-in ${path.basename(row.sourcePath)}: ${reason}`,
    );
    await this.prisma.downloadDropIn.update({
      where: { id: row.id },
      data: {
        attempts,
        status: 'failed',
        error: reason,
        finishedAt: new Date(),
      },
    });
    await this.activity?.record({
      kind: 'download',
      title: `Couldn’t bring “${path.basename(row.sourcePath)}” into your library`,
      detail: `${reason} Scan it in Stash and identify it in Library Tools.`,
      status: 'failed',
    });
  }

  /** Remembers a file by its path (a different file there replaces the old row). */
  private save(
    sourcePath: string,
    size: number,
    data: Partial<
      Pick<DownloadDropIn, 'status' | 'finalPath' | 'error' | 'finishedAt'>
    >,
  ): Promise<DownloadDropIn> {
    const fields = {
      size: BigInt(size),
      attempts: 0,
      stashSceneId: null,
      finalPath: null,
      finishedAt: null,
      ...data,
    };
    return this.prisma.downloadDropIn.upsert({
      where: { sourcePath },
      create: { sourcePath, ...fields },
      update: fields,
    });
  }
}

/** Why drop-ins are off by the settings; null when they're on. */
function offReason(
  settings: DownloadHandoffSettings,
): { reason: DropInWatchReason; message: string } | null {
  if (!settings.enabled) {
    return {
      reason: 'handoff-off',
      message:
        'Finished downloads is off, so the drop-in folder isn’t watched.',
    };
  }
  if (!settings.dropIns) {
    return {
      reason: 'drop-ins-off',
      message:
        '“Also bring in files I put in this folder” is off, so the folder isn’t watched.',
    };
  }
  if (!settings.destination) {
    return {
      reason: 'no-destination',
      message:
        'No destination folder is set, so there’s nowhere to bring files in to.',
    };
  }
  return null;
}

function offHint(reason: DropInWatchReason): string | null {
  switch (reason) {
    case 'handoff-off':
    case 'drop-ins-off':
      return 'Turn it on in Settings → Integrations → SABnzbd → Finished downloads.';
    case 'no-destination':
      return 'Pick where files go (“Move them to”) in Settings → Integrations → SABnzbd → Finished downloads.';
    default:
      return null;
  }
}

function summary(
  fresh: number,
  ready: number,
  skipped: DropInSkippedDto[],
): string {
  const parts = [
    fresh === 0
      ? 'No new videos'
      : `${fresh} new video${fresh === 1 ? '' : 's'}${ready > 0 ? `, ${ready} ready to bring in` : ', waiting for them to stop changing'}`,
  ];
  if (skipped.length > 0) {
    parts.push(`${skipped.length} left alone`);
  }
  return `${parts.join('; ')}.`;
}

function skippedDto(
  file: string,
  reason: DropInSkippedReason,
  detail: string,
): DropInSkippedDto {
  return { path: file, name: path.basename(file), reason, detail };
}

export function toDropInDto(row: DownloadDropIn): DownloadDropInDto {
  return {
    id: row.id,
    sourcePath: row.sourcePath,
    status: row.status as DropInStatus,
    error: row.error,
    finalPath: row.finalPath,
    stashSceneId: row.stashSceneId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function fsProblem(error: unknown): string {
  switch (codeOf(error)) {
    case 'ENOENT':
      return 'it doesn’t exist inside Stashboard’s container';
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'ENOTDIR':
      return 'it isn’t a folder';
    default:
      return messageOf(error);
  }
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'unknown error';
}
