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
import { MANUAL_HANDOFF_SOURCE } from './download-handoff.model';

/** How often unmatched files you brought in are looked up again. */
const REMATCH_EVERY_MS = 24 * 3600_000;
/** For how long after coming in: past that, a match is unlikely to appear. */
const REMATCH_FOR_MS = 14 * 24 * 3600_000;
/** Scenes looked up per run, newest first; the rest wait for the next day. */
const REMATCH_PER_RUN = 40;
/** How often it's checked whether a run is due. */
const TICK_MS = 15 * 60_000;
/** Recent imports read per run, before leaving out those already matched. */
const READ_LIMIT = 300;

/** A file you brought in yourself that wasn't matched when it came in. */
interface Unmatched {
  kind: 'drop-in' | 'download';
  id: string;
  sceneId: string;
  finalPath: string | null;
  name: string;
}

/**
 * StashDB keeps adding scenes, so a drop-in (or a download you added in
 * SABnzbd yourself) that wasn't matched when it came in is looked up again
 * once a day for two weeks: a fingerprint, or a sure name match, is saved,
 * and the file goes into its folder, named by your rename pattern, as it
 * would have on the day. Likely matches wait in "Check these matches".
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
    const unmatched = await this.unmatched();
    if (unmatched.length === 0) {
      return 0;
    }
    const result = await this.organizer.identifyNewScenes(
      unmatched.map((entry) => entry.sceneId),
      { trustNames: true },
    );
    const matched = new Set([...result.linked, ...result.matched]);
    const config = await this.handoff.stashConfig();
    let placedCount = 0;
    for (const entry of unmatched.filter((item) => matched.has(item.sceneId))) {
      // Where Stash has the file now: it may have been moved since.
      const scene = config
        ? await this.stash
            .getOrganizerScene(config, entry.sceneId)
            .catch(() => null)
        : null;
      const file =
        scene?.files.find(
          (candidate) =>
            entry.finalPath !== null &&
            samePath(candidate.path, entry.finalPath),
        ) ??
        scene?.files[0] ??
        null;
      const placed = file
        ? await this.handoff.placeInFolder(entry.sceneId, file.path)
        : { to: entry.finalPath ?? '', reason: null };
      if (file) {
        placedCount += 1;
        await this.remember(entry, placed.to);
      }
      if (placed.reason) {
        this.logger.warn(placed.reason);
      }
      this.logger.log(
        `Matched “${entry.name}” (Stash scene ${entry.sceneId}) on a later look${file && placed.to !== file.path ? `, placed in ${placed.to}` : ''}.`,
      );
      await this.activity?.record({
        kind: 'download',
        title: `Matched “${entry.name}” on a later look`,
        detail: [
          'StashDB has it now, so it was linked to its catalog scene.',
          ...(file ? placedLines(file.path, placed) : []),
        ].join('\n'),
        ...(placed.reason ? { status: 'partial' as const } : {}),
      });
    }
    this.logger.log(
      `Looked up ${unmatched.length} unmatched file${unmatched.length === 1 ? '' : 's'} you brought in again: ${matched.size} matched (${placedCount} put in their folder), ${result.proposed.length} waiting in “Check these matches”.`,
    );
    return matched.size;
  }

  /**
   * Drop-ins and your own SABnzbd downloads that came in over the last two
   * weeks and aren't linked to the catalog yet, newest first.
   */
  private async unmatched(): Promise<Unmatched[]> {
    const since = new Date(this.now() - REMATCH_FOR_MS);
    const [dropIns, downloads] = await Promise.all([
      this.prisma.downloadDropIn.findMany({
        where: {
          status: 'imported',
          stashSceneId: { not: null },
          finishedAt: { gte: since },
        },
        orderBy: { finishedAt: 'desc' },
        take: READ_LIMIT,
      }),
      this.prisma.downloadHandoff.findMany({
        where: {
          source: MANUAL_HANDOFF_SOURCE,
          status: 'imported',
          stashSceneId: { not: null },
          finishedAt: { gte: since },
        },
        orderBy: { finishedAt: 'desc' },
        take: READ_LIMIT,
      }),
    ]);
    const all: Array<Unmatched & { at: number }> = [
      ...dropIns.map((row) => ({
        kind: 'drop-in' as const,
        id: row.id,
        sceneId: row.stashSceneId!,
        finalPath: row.finalPath,
        name: path.basename(row.sourcePath),
        at: row.finishedAt?.getTime() ?? 0,
      })),
      ...downloads.map((row) => ({
        kind: 'download' as const,
        id: row.id,
        sceneId: row.stashSceneId!,
        finalPath: row.finalPath,
        name: row.releaseTitle,
        at: row.finishedAt?.getTime() ?? 0,
      })),
    ].sort((left, right) => right.at - left.at);
    if (all.length === 0) {
      return [];
    }
    // Linked by the library index: not looked up (Identify would skip them anyway).
    const linked = new Set(
      (
        await this.prisma.librarySceneIndex.findMany({
          where: {
            stashSceneId: { in: all.map((entry) => entry.sceneId) },
            linkedStashId: { not: null },
          },
          select: { stashSceneId: true },
        })
      ).map((row) => row.stashSceneId),
    );
    const seen = new Set<string>();
    return all
      .filter((entry) => {
        if (linked.has(entry.sceneId) || seen.has(entry.sceneId)) {
          return false;
        }
        seen.add(entry.sceneId);
        return true;
      })
      .slice(0, REMATCH_PER_RUN)
      .map(({ at: _at, ...entry }) => entry);
  }

  /** Where the file is now, so the Downloads page shows it. */
  private async remember(entry: Unmatched, finalPath: string): Promise<void> {
    const update = { where: { id: entry.id }, data: { finalPath } };
    await (
      entry.kind === 'drop-in'
        ? this.prisma.downloadDropIn.update(update)
        : this.prisma.downloadHandoff.update(update)
    ).catch((error: unknown) =>
      this.logger.debug(
        `Couldn't note where “${entry.name}” went: ${messageOf(error)}`,
      ),
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
