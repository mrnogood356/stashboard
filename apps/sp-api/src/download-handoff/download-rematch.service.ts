import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as path from 'node:path';
import { ActivityService } from '../activity/activity.service';
import { OrganizerService } from '../organizer/organizer.service';
import { samePath } from '../organizer/organizer-plan.util';
import { PrismaService } from '../prisma/prisma.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import {
  DownloadHandoffService,
  placedLines,
} from './download-handoff.service';
import {
  MANUAL_HANDOFF_SOURCE,
  type MatchedBy,
} from './download-handoff.model';

/** How often unmatched files you brought in are looked up again. */
const REMATCH_EVERY_MS = 24 * 3600_000;
/** For how long after coming in: past that, a match is unlikely to appear. */
const REMATCH_FOR_MS = 14 * 24 * 3600_000;
/** Scenes looked up per run: those waiting longest since their last look. */
const REMATCH_PER_RUN = 40;
/** How often it's checked whether a run is due. */
const TICK_MS = 15 * 60_000;
/** Recent imports read per run, before leaving out those already matched. */
const READ_LIMIT = 300;

/** Not matched yet, or a likely match waiting for you. */
const UNRESOLVED: readonly MatchedBy[] = ['none', 'proposed'];

function isUnresolved(matchedBy: string | null): boolean {
  return (UNRESOLVED as readonly string[]).includes(matchedBy ?? '');
}

/** A file you brought in yourself, unmatched when it came in. */
interface Entry {
  kind: 'drop-in' | 'download';
  id: string;
  sceneId: string;
  finalPath: string | null;
  name: string;
  /** When it came in. */
  at: number;
  /** When it was last looked up again; 0 for never. */
  triedAt: number;
  /** Matched on a later look but not put in its folder yet. */
  placePending: boolean;
  matchedBy: string | null;
}

/**
 * StashDB keeps adding scenes, so a drop-in (or a download you added in
 * SABnzbd yourself) that wasn't matched when it came in is looked up again
 * once a day for two weeks, those waiting longest first: a fingerprint, or a
 * sure name match, is saved, and the file goes into its folder, named by
 * your rename pattern, as it would have on the day. One matched but not put
 * in its folder (Stash couldn't be asked, or something was in the way) is
 * tried again each day until it is. Likely matches wait in "Check these
 * matches".
 */
@Injectable()
export class DownloadRematchService {
  private readonly logger = new Logger(DownloadRematchService.name);
  private lastRunAt = 0;
  private running: Promise<number> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizer: OrganizerService,
    private readonly handoff: DownloadHandoffService,
    private readonly stash: StashAdapter,
  ) {}

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  /** Exposed for tests. */
  now(): number {
    return Date.now();
  }

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (this.running || this.now() - this.lastRunAt < REMATCH_EVERY_MS) {
      return;
    }
    this.lastRunAt = this.now();
    this.running = this.run()
      .catch((error: unknown) => {
        this.logger.warn(
          `Looking up unmatched drop-ins again failed: ${messageOf(error)}`,
        );
        return 0;
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }

  /** One run: how many were matched. */
  async run(): Promise<number> {
    const { toLookUp: selected, toPlace } = await this.select();
    let matchedCount = 0;
    let proposed = 0;
    // Marked to place before the look-up, which may save a link: should
    // anything stop it from finishing, a later run checks each one (an
    // unlinked one is just unmarked) rather than leave a match unplaced.
    // One that couldn't be marked waits for another day.
    const toLookUp: Entry[] = [];
    for (const entry of selected) {
      if (await this.save(entry, { placePending: true })) {
        toLookUp.push(entry);
      }
    }
    if (toLookUp.length > 0) {
      const result = await this.organizer.identifyNewScenes(
        toLookUp.map((entry) => entry.sceneId),
        { trustNames: true },
      );
      const matched = new Set([...result.linked, ...result.matched]);
      matchedCount = matched.size;
      proposed = result.proposed.length;
      const unmatched = new Set(result.left);
      const waiting = new Set(result.proposed);
      for (const entry of toLookUp) {
        // Only one the look-up says is still unmatched is unmarked. Matched
        // ones, and one linked meanwhile some other way (the look-up skips
        // those), stay marked and are placed below.
        const stillUnmatched = unmatched.has(entry.sceneId);
        // Linked meanwhile some other way: by you, most likely.
        const matchedBy: MatchedBy | undefined = !stillUnmatched
          ? matched.has(entry.sceneId)
            ? 'later'
            : 'stash'
          : waiting.has(entry.sceneId)
            ? 'proposed'
            : undefined;
        await this.save(entry, {
          rematchTriedAt: new Date(this.now()),
          placePending: !stillUnmatched,
          matchedBy,
        });
        if (!stillUnmatched) {
          toPlace.push({
            ...entry,
            placePending: true,
            matchedBy: matchedBy ?? entry.matchedBy,
          });
        }
        if (matched.has(entry.sceneId)) {
          this.logger.log(
            `Matched “${entry.name}” (Stash scene ${entry.sceneId}) on a later look.`,
          );
        }
      }
    }
    let placedCount = 0;
    for (const entry of toPlace) {
      if (await this.place(entry)) {
        placedCount += 1;
      }
    }
    if (toLookUp.length + toPlace.length > 0) {
      this.logger.log(
        `Looked up ${toLookUp.length} unmatched file${toLookUp.length === 1 ? '' : 's'} you brought in again: ${matchedCount} matched, ${proposed} waiting in “Check these matches”; ${placedCount} of ${toPlace.length} matched put in their folder.`,
      );
    }
    return matchedCount;
  }

  /**
   * Puts a matched file into its folder, named by your rename pattern. True
   * when it's done (or there's nothing left to place); false leaves it
   * marked, to try again on the next run.
   */
  private async place(entry: Entry): Promise<boolean> {
    const config = await this.handoff.stashConfig();
    // Where Stash has the file now: it may have been moved since.
    const scene = config
      ? await this.stash
          .getOrganizerScene(config, entry.sceneId)
          .catch((error: unknown) => {
            this.logger.warn(
              `Couldn't read Stash scene ${entry.sceneId} to place “${entry.name}”: ${messageOf(error)}. Tried again tomorrow.`,
            );
            return undefined;
          })
      : undefined;
    if (scene === undefined) {
      return false;
    }
    if (scene && scene.stashIds.length === 0) {
      // Not linked after all (a run stopped part way): looked up again instead.
      await this.save(entry, { placePending: false });
      return true;
    }
    const file =
      scene?.files.find(
        (candidate) =>
          entry.finalPath !== null && samePath(candidate.path, entry.finalPath),
      ) ??
      scene?.files[0] ??
      null;
    if (!file) {
      // The scene or its file is gone from Stash: nothing left to place.
      await this.save(entry, { placePending: false });
      return true;
    }
    const placed = await this.handoff.placeInFolder(entry.sceneId, file.path);
    if (placed.reason) {
      this.logger.warn(`${placed.reason} Tried again tomorrow.`);
      return false;
    }
    await this.save(entry, {
      placePending: false,
      finalPath: placed.to,
      // Linked by a look-up that stopped part way: say it's matched, without
      // losing how, when that was noted.
      ...(isUnresolved(entry.matchedBy) ? { matchedBy: 'stash' as const } : {}),
    });
    await this.activity?.record({
      kind: 'download',
      title: `Matched “${entry.name}” on a later look`,
      detail: [
        'StashDB has it now, so it was linked to its catalog scene.',
        ...placedLines(file.path, placed),
      ].join('\n'),
    });
    return true;
  }

  /**
   * From the drop-ins and your own SABnzbd downloads of the last two weeks:
   * the unlinked ones waiting longest since their last look (then the
   * newest), and every one matched but not yet placed.
   */
  private async select(): Promise<{ toLookUp: Entry[]; toPlace: Entry[] }> {
    const since = new Date(this.now() - REMATCH_FOR_MS);
    const where = {
      status: 'imported',
      stashSceneId: { not: null },
      finishedAt: { gte: since },
    };
    const downloadWhere = { ...where, source: MANUAL_HANDOFF_SOURCE };
    // Every one waiting to be placed, however many came in since, and the
    // newest of the rest to look up.
    const [dropIns, downloads, pendingDropIns, pendingDownloads] =
      await Promise.all([
        this.prisma.downloadDropIn.findMany({
          where: { ...where, placePending: false },
          orderBy: { finishedAt: 'desc' },
          take: READ_LIMIT,
        }),
        this.prisma.downloadHandoff.findMany({
          where: { ...downloadWhere, placePending: false },
          orderBy: { finishedAt: 'desc' },
          take: READ_LIMIT,
        }),
        this.prisma.downloadDropIn.findMany({
          where: { ...where, placePending: true },
        }),
        this.prisma.downloadHandoff.findMany({
          where: { ...downloadWhere, placePending: true },
        }),
      ]);
    const all: Entry[] = [
      ...[...pendingDropIns, ...dropIns].map((row) => ({
        kind: 'drop-in' as const,
        id: row.id,
        sceneId: row.stashSceneId!,
        finalPath: row.finalPath,
        name: path.basename(row.sourcePath),
        at: row.finishedAt?.getTime() ?? 0,
        triedAt: row.rematchTriedAt?.getTime() ?? 0,
        placePending: row.placePending,
        matchedBy: row.matchedBy,
      })),
      ...[...pendingDownloads, ...downloads].map((row) => ({
        kind: 'download' as const,
        id: row.id,
        sceneId: row.stashSceneId!,
        finalPath: row.finalPath,
        name: row.releaseTitle,
        at: row.finishedAt?.getTime() ?? 0,
        triedAt: row.rematchTriedAt?.getTime() ?? 0,
        placePending: row.placePending,
        matchedBy: row.matchedBy,
      })),
    ];
    const toPlace = all.filter((entry) => entry.placePending);
    const rest = all.filter((entry) => !entry.placePending);
    if (rest.length === 0) {
      return { toLookUp: [], toPlace };
    }
    // Linked by the library index: not looked up (Identify would skip them anyway).
    const linked = new Set(
      (
        await this.prisma.librarySceneIndex.findMany({
          where: {
            stashSceneId: { in: rest.map((entry) => entry.sceneId) },
            linkedStashId: { not: null },
          },
          select: { stashSceneId: true },
        })
      ).map((row) => row.stashSceneId),
    );
    // Linked since (by you, most likely): no longer "not matched yet".
    await this.noteLinked(
      rest.filter(
        (entry) => linked.has(entry.sceneId) && isUnresolved(entry.matchedBy),
      ),
    );
    const seen = new Set(toPlace.map((entry) => entry.sceneId));
    const toLookUp = rest
      .filter((entry) => !linked.has(entry.sceneId))
      .sort((left, right) => left.triedAt - right.triedAt || right.at - left.at)
      .filter((entry) => {
        if (seen.has(entry.sceneId)) {
          return false;
        }
        seen.add(entry.sceneId);
        return true;
      })
      .slice(0, REMATCH_PER_RUN);
    return { toLookUp, toPlace };
  }

  /** Notes files linked some other way since as matched. */
  private async noteLinked(entries: Entry[]): Promise<void> {
    const ids = (kind: Entry['kind']) =>
      entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
    const data = { matchedBy: 'stash' };
    const where = (list: string[]) => ({
      id: { in: list },
      matchedBy: { in: [...UNRESOLVED] },
    });
    await Promise.all([
      ids('drop-in').length
        ? this.prisma.downloadDropIn.updateMany({
            where: where(ids('drop-in')),
            data,
          })
        : null,
      ids('download').length
        ? this.prisma.downloadHandoff.updateMany({
            where: where(ids('download')),
            data,
          })
        : null,
    ]).catch((error: unknown) =>
      this.logger.warn(
        `Couldn't note files linked since as matched: ${messageOf(error)}`,
      ),
    );
  }

  private async save(
    entry: Entry,
    data: {
      rematchTriedAt?: Date;
      placePending?: boolean;
      finalPath?: string;
      matchedBy?: MatchedBy;
    },
  ): Promise<boolean> {
    const update = { where: { id: entry.id }, data };
    return (
      entry.kind === 'drop-in'
        ? this.prisma.downloadDropIn.update(update)
        : this.prisma.downloadHandoff.update(update)
    ).then(
      () => true,
      (error: unknown) => {
        this.logger.warn(
          `Couldn't note the later look at “${entry.name}”: ${messageOf(error)}`,
        );
        return false;
      },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
