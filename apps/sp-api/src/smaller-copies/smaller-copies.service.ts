import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { SmallerCopyAttempt, SmallerCopySettings } from '@prisma/client';
import {
  DownloadHandoffService,
  releaseKeyOf,
} from '../download-handoff/download-handoff.service';
import { OPEN_HANDOFF_STATUSES } from '../download-handoff/download-handoff.model';
import {
  DownloadsService,
  type MatchedProwlarrRelease,
} from '../downloads/downloads.service';
import type { StatsFile } from '../playback/library-stats.util';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import {
  CODEC_RULES,
  inActiveHours,
  MATCH,
  needsReplacing,
  OLD_COPY,
  pickRelease,
  PREFER,
  reasonFor,
  releaseProblems,
  STUDIO_MODES,
  TARGETS,
  type ReplaceReason,
  type SmallerCopyRules,
  rulesOf,
} from './smaller-copies.util';

const KEY = 'GLOBAL';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Nothing found: looked for again after a week, as new releases appear. */
const NONE_FOUND_WAIT = 7 * DAY;
/** Grabbed, found, or no catalog link: not looked for again for a month. */
const LONG_WAIT = 30 * DAY;
const FAILED_WAIT = DAY;
/** Tried releases shown on the page. */
const TRIES_SHOWN = 200;
/** The library's files are read again at most this often. */
const FILES_TTL = HOUR;
/** Replacements being brought in at once, at most. */
const MAX_ON_THE_WAY = 2;

export interface SmallerCopySettingsInput extends SmallerCopyRules {
  enabled: boolean;
  /** Grab a match by itself; off lists it for you to grab. */
  autoGrab: boolean;
  /** The old file once the new one is in Stash. */
  oldCopy: (typeof OLD_COPY)[number];
  scenesPerHour: number;
  activeFromHour: number | null;
  activeToHour: number | null;
}

export interface SmallerCopiesDto {
  settings: SmallerCopySettingsInput;
  /** Why nothing is searched for right now; null when it's running. */
  blocked: string | null;
  /** After Search now: why nothing was searched, if nothing was. */
  notice?: string | null;
  /** Scenes the rules say to look for, and how many of them are due. */
  candidates: number;
  due: number;
  lastSearchAt: string | null;
  /** Space given back so far (deleted minus new; can be negative after upgrades), and scenes replaced. */
  saved: { bytes: number; scenes: number };
  recent: Array<{
    stashSceneId: string;
    title: string;
    outcome: string;
    detail: string | null;
    releaseTitle: string | null;
    /** A match waiting for you to grab it. */
    canGrab: boolean;
    oldSize: number | null;
    newSize: number | null;
    searchedAt: string;
  }>;
  /** Releases grabbed so far, newest first, and how each ended. */
  tries: Array<{
    id: string;
    stashSceneId: string;
    title: string;
    releaseTitle: string | null;
    /** grabbed (on its way) | replaced | kept-both | removed | failed */
    outcome: string;
    detail: string | null;
    oldSize: number | null;
    newSize: number | null;
    at: string;
    /**
     * Kept both: the Stash scene the download landed on, apart from the old
     * one, to look at or remove. Null when there's none to show.
     */
    newSceneId: string | null;
    /**
     * Whether "Remove it" is offered: the new scene holds just the one file.
     * Checked again when asked, since that can change.
     */
    canRemoveNew: boolean;
  }>;
  /** How many tries ended each way, over all of them. */
  tryCounts: Record<string, number>;
  /** Scenes on the Failed list (latest try failed) or whose last search failed: what "Check failed again" looks at. */
  failed: number;
}

/** Releases found for a scene, to choose one yourself. */
export interface ChooseReleasesDto {
  stashSceneId: string;
  title: string;
  /** The file it would replace. */
  oldSize: number | null;
  releases: Array<
    MatchedProwlarrRelease & {
      /** Why the rules wouldn't pick it; empty when they would. */
      problems: string[];
    }
  >;
  queries: string[];
  notice?: string;
}

interface Candidate {
  file: StatsFile;
  reason: ReplaceReason;
}

type Note = Pick<SmallerCopyAttempt, 'title' | 'outcome' | 'retryAfter'> &
  Partial<
    Pick<
      SmallerCopyAttempt,
      | 'detail'
      | 'releaseTitle'
      | 'newSize'
      | 'handoffId'
      | 'oldSize'
      | 'releaseGuid'
      | 'indexerId'
    >
  >;

/**
 * Smaller copies: looks, a scene at a time and no faster than the hourly
 * limit (and only in the hours allowed), for a release of a library scene
 * that fits the rules; grabs it, or lists it for you, and once it's imported
 * Finished downloads puts it on the scene and deletes (or keeps) the old
 * file. Off until switched on.
 */
/** How long a new scene's file count is trusted for the Tried list (the page asks every 30s). */
const FILE_COUNT_TTL = 60 * 1000;

const ON_ITS_WAY = 'A replacement for this scene is already on its way.';

function refuseBusy(): never {
  throw new ConflictException(
    'A replacement for this scene is already being sent.',
  );
}

@Injectable()
export class SmallerCopiesService {
  private readonly logger = new Logger(SmallerCopiesService.name);
  private running = false;
  /** Scenes a release you chose is being sent for (see grabChosen). */
  private readonly choosing = new Set<string>();
  /** Files on each kept-both download's scene, by scene, for the Tried list. */
  private readonly fileCounts = new Map<
    string,
    { at: number; count: number }
  >();
  private files: { at: number; baseUrl: string; value: StatsFile[] } | null =
    null;
  private lastSearchAt: number | null = null;
  /** Swapped in tests. */
  now: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly downloads: DownloadsService,
    private readonly handoff: DownloadHandoffService,
    private readonly catalog: CatalogProviderService,
    @Optional() private readonly stash?: StashAdapter,
  ) {}

  async getSettings(): Promise<SmallerCopySettings> {
    return this.prisma.smallerCopySettings.upsert({
      where: { key: KEY },
      create: { key: KEY },
      update: {},
    });
  }

  async saveSettings(
    input: SmallerCopySettingsInput,
  ): Promise<SmallerCopiesDto> {
    const positive = (value: number | null | undefined) =>
      value !== null && value !== undefined && value > 0 ? value : null;
    const hour = (value: number | null | undefined) =>
      value === null || value === undefined
        ? null
        : Math.min(23, Math.max(0, Math.round(value)));
    const data = {
      enabled: input.enabled,
      targetResolution: oneOf(TARGETS, input.target, '1080p'),
      replaceHigher: input.replaceHigher,
      upgradeLower: input.upgradeLower,
      maxGbPerHour: positive(input.maxGbPerHour),
      minGbPerHour: positive(input.minGbPerHour),
      maxNewGbPerHour: positive(input.maxNewGbPerHour),
      minNewGbPerHour: positive(input.minNewGbPerHour),
      minSavingsPercent: Math.min(
        90,
        Math.max(0, Math.round(input.minSavingsPercent)),
      ),
      codec: oneOf(CODEC_RULES, input.codec, 'any'),
      prefer: oneOf(PREFER, input.prefer, 'largest'),
      matchStrength: oneOf(MATCH, input.matchStrength, 'strong'),
      studioMode: oneOf(STUDIO_MODES, input.studioMode, 'all'),
      studioNames: [
        ...new Set(
          input.studioNames.map((name) => name.trim()).filter(Boolean),
        ),
      ].slice(0, 200),
      autoGrab: input.autoGrab,
      oldCopy: oneOf(OLD_COPY, input.oldCopy, 'delete'),
      scenesPerHour: Math.min(60, Math.max(1, Math.round(input.scenesPerHour))),
      activeFromHour: hour(input.activeFromHour),
      activeToHour: hour(input.activeToHour),
    };
    await this.prisma.smallerCopySettings.upsert({
      where: { key: KEY },
      create: { key: KEY, ...data },
      update: data,
    });
    return this.status();
  }

  async status(): Promise<SmallerCopiesDto> {
    await this.settleTries().catch((error: unknown) =>
      this.logger.warn(
        `Couldn't bring the tried list up to date: ${messageOf(error)}`,
      ),
    );
    const settings = await this.getSettings();
    const blocked = await this.blockedBy(settings);
    const candidates = settings.enabled
      ? await this.candidates(settings).catch(() => [] as Candidate[])
      : [];
    const due = await this.dueOf(candidates);
    const recent = await this.prisma.smallerCopyAttempt.findMany({
      orderBy: { searchedAt: 'desc' },
      take: 50,
    });
    const [tries, counts, failed] = await Promise.all([
      this.prisma.smallerCopyTry
        .findMany({ orderBy: { createdAt: 'desc' }, take: TRIES_SHOWN })
        .catch(() => []),
      this.prisma.smallerCopyTry
        .groupBy({ by: ['outcome'], _count: { _all: true } })
        .catch(() => []),
      this.failedSceneIds()
        .then((ids) => ids.size)
        .catch(() => 0),
    ]);
    const newScenes = await this.newScenesOf(tries).catch(
      () => new Map<string, string>(),
    );
    const fileCounts = await this.fileCountsOf([...newScenes.values()]);
    return {
      settings: settingsOf(settings),
      blocked,
      candidates: candidates.length,
      due: due.length,
      lastSearchAt: this.lastSearchAt
        ? new Date(this.lastSearchAt).toISOString()
        : null,
      saved: { bytes: settings.savedBytes, scenes: settings.replacedCount },
      recent: recent.map((row) => ({
        stashSceneId: row.stashSceneId,
        title: row.title,
        outcome: row.outcome,
        detail: row.detail,
        releaseTitle: row.releaseTitle,
        canGrab: row.outcome === 'found' && !!row.releaseGuid,
        oldSize: row.oldSize,
        newSize: row.newSize,
        searchedAt: row.searchedAt.toISOString(),
      })),
      tries: tries.map((row) => ({
        id: row.id,
        stashSceneId: row.stashSceneId,
        title: row.title,
        releaseTitle: row.releaseTitle,
        outcome: row.outcome,
        detail: row.detail,
        oldSize: row.oldSize,
        newSize: row.newSize,
        at: row.updatedAt.toISOString(),
        newSceneId: newScenes.get(row.id) ?? null,
        // Only when Stash says just the one file: not when it couldn't be read.
        canRemoveNew:
          newScenes.has(row.id) && fileCounts.get(newScenes.get(row.id)!) === 1,
      })),
      tryCounts: Object.fromEntries(
        counts.map((row) => [row.outcome, row._count._all]),
      ),
      failed,
    };
  }

  /**
   * Kept-both tries whose download is on a Stash scene of its own, by try:
   * that scene. Not when it joined the old scene, nor when the old scene is
   * gone (the new copy is then the only one).
   */
  private async newScenesOf(
    tries: Array<{
      id: string;
      stashSceneId: string;
      outcome: string;
      handoffId: string | null;
    }>,
  ): Promise<Map<string, string>> {
    const kept = tries.filter(
      (row) => row.outcome === 'kept-both' && row.handoffId,
    );
    if (kept.length === 0) {
      return new Map();
    }
    const [handoffs, present] = await Promise.all([
      this.prisma.downloadHandoff.findMany({
        where: { id: { in: kept.map((row) => row.handoffId!) } },
        select: { id: true, stashSceneId: true },
      }),
      this.prisma.librarySceneIndex.findMany({
        where: { stashSceneId: { in: kept.map((row) => row.stashSceneId) } },
        select: { stashSceneId: true },
      }),
    ]);
    const sceneOf = new Map(handoffs.map((row) => [row.id, row.stashSceneId]));
    const oldThere = new Set(present.map((row) => row.stashSceneId));
    const found = new Map<string, string>();
    for (const row of kept) {
      const scene = sceneOf.get(row.handoffId!);
      if (
        scene &&
        scene !== row.stashSceneId &&
        oldThere.has(row.stashSceneId)
      ) {
        found.set(row.id, scene);
      }
    }
    return found;
  }

  /**
   * How many files each of these Stash scenes holds, kept for a minute
   * (the page asks every 30 seconds). A scene that can't be read is left
   * out, so it's offered no removal; the removal checks again anyway.
   */
  private async fileCountsOf(sceneIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (sceneIds.length === 0 || !this.stash) {
      return counts;
    }
    const config = await this.handoff.stashConfig().catch(() => null);
    if (!config) {
      return counts;
    }
    const now = this.now();
    await Promise.all(
      [...new Set(sceneIds)].map(async (id) => {
        const cached = this.fileCounts.get(id);
        if (cached && now - cached.at < FILE_COUNT_TTL) {
          counts.set(id, cached.count);
          return;
        }
        const scene = await this.stash!.getOrganizerScene(config, id).catch(
          () => undefined,
        );
        if (scene !== undefined) {
          const count = scene?.files.length ?? 0;
          this.fileCounts.set(id, { at: now, count });
          counts.set(id, count);
        }
      }),
    );
    return counts;
  }

  /**
   * Deletes a kept-both try's new copy (its scene and file) from Stash, for
   * when it turned out to be another video or not wanted. The old file stays.
   */
  async removeNewCopy(tryId: string): Promise<SmallerCopiesDto> {
    const row = await this.prisma.smallerCopyTry.findUnique({
      where: { id: tryId },
    });
    if (!row) {
      throw new NotFoundException('That try isn’t in the list any more.');
    }
    const newSceneId = (await this.newScenesOf([row])).get(row.id);
    if (!newSceneId) {
      throw new ConflictException(
        'There’s no separate new copy to remove for that try.',
      );
    }
    const config = await this.handoff.stashConfig();
    if (!config || !this.stash) {
      throw new BadRequestException('Stash isn’t set up.');
    }
    const [scene, old] = await Promise.all([
      this.stash.getOrganizerScene(config, newSceneId),
      this.stash.getOrganizerScene(config, row.stashSceneId),
    ]);
    if (!old || old.files.length === 0) {
      throw new ConflictException(
        'The old scene is gone from Stash, so the new copy is the only one; it’s left as it is.',
      );
    }
    if (scene) {
      if (scene.files.length > 1) {
        throw new ConflictException(
          `The new copy’s scene has ${scene.files.length} files now, so it’s left for you to sort out in Stash.`,
        );
      }
      await this.stash.deleteScene(config, newSceneId, true);
    }
    this.fileCounts.delete(newSceneId);
    await this.prisma.librarySceneIndex
      .deleteMany({ where: { stashSceneId: newSceneId } })
      .catch(() => undefined);
    const path = scene?.files[0]?.path;
    await this.prisma.smallerCopyTry.update({
      where: { id: row.id },
      data: {
        outcome: 'removed',
        detail:
          `${row.detail ? `${row.detail} ` : ''}You removed the new copy${path ? ` (${path})` : ''}; the old file stays.`.slice(
            0,
            600,
          ),
      },
    });
    this.logger.log(
      scene
        ? `Better copies: deleted Stash scene ${newSceneId}${path ? ` and ${path}` : ''}, the new copy kept beside Stash scene ${row.stashSceneId}.`
        : `Better copies: the new copy beside Stash scene ${row.stashSceneId} (scene ${newSceneId}) was already gone from Stash.`,
    );
    return this.status();
  }

  /**
   * Tries still "on the way" whose download is no longer being watched are
   * settled from what became of it. Imported: the outcome the swap recorded.
   * Failed, stopped or lost: failed, with the release kept skipped and the
   * scene due again, so another is looked for on the next search.
   */
  private async settleTries(): Promise<void> {
    const open = await this.prisma.smallerCopyTry.findMany({
      where: { outcome: 'grabbed' },
    });
    if (open.length === 0) {
      return;
    }
    const ids = open.flatMap((row) => (row.handoffId ? [row.handoffId] : []));
    const handoffs = new Map(
      (
        await this.prisma.downloadHandoff.findMany({
          where: { id: { in: ids } },
          select: { id: true, status: true, error: true },
        })
      ).map((row) => [row.id, row]),
    );
    for (const row of open) {
      const handoff = row.handoffId ? handoffs.get(row.handoffId) : undefined;
      if (
        handoff &&
        (OPEN_HANDOFF_STATUSES as string[]).includes(handoff.status)
      ) {
        continue;
      }
      // Just grabbed: give its download a moment to be written down.
      if (!handoff && this.now() - row.createdAt.getTime() < HOUR) {
        continue;
      }
      if (handoff?.status === 'imported') {
        const attempt = await this.prisma.smallerCopyAttempt.findFirst({
          where: { handoffId: row.handoffId },
        });
        const recorded =
          attempt &&
          (attempt.outcome === 'replaced' || attempt.outcome === 'kept-both');
        // Only while still on its way: another call may have settled it.
        await this.prisma.smallerCopyTry.updateMany({
          where: { id: row.id, outcome: 'grabbed' },
          data: recorded
            ? { outcome: attempt.outcome, detail: attempt.detail }
            : {
                outcome: 'kept-both',
                detail:
                  'It came in, but how it was swapped wasn’t recorded; check the scene.',
              },
        });
        continue;
      }
      const why =
        handoff?.status === 'failed'
          ? `The download failed: ${handoff.error ?? 'no reason given'}`
          : handoff?.status === 'ignored'
            ? 'Stashboard stopped watching the download (SABnzbd no longer listed it, or it was stopped).'
            : 'Stashboard lost track of the download.';
      const detail =
        `${/[.!?]$/.test(why) ? why : `${why}.`} This release won’t be grabbed again; another is looked for next.`.slice(
          0,
          300,
        );
      // Both or neither: a try marked failed whose scene wasn't made due
      // would never be looked at again until its old wait ran out.
      await this.prisma.$transaction([
        this.prisma.smallerCopyTry.updateMany({
          where: { id: row.id, outcome: 'grabbed' },
          data: { outcome: 'failed', detail },
        }),
        // The scene's own row, if it's still on this grab: due again now.
        this.prisma.smallerCopyAttempt.updateMany({
          where: {
            stashSceneId: row.stashSceneId,
            outcome: 'grabbed',
            ...(row.handoffId ? { handoffId: row.handoffId } : {}),
          },
          data: {
            outcome: 'failed',
            detail,
            retryAfter: new Date(this.now()),
          },
        }),
      ]);
    }
  }

  /**
   * Looks at a scene again on the next search, whatever it found last time.
   * Releases already grabbed for it stay skipped.
   */
  async recheck(
    stashSceneId: string,
    /** From a failed try: only while the scene's latest try is still the failed one. */
    onlyIfFailed = false,
  ): Promise<SmallerCopiesDto> {
    const updated = await this.prisma.smallerCopyAttempt.updateMany({
      where: { stashSceneId, ...(onlyIfFailed ? { outcome: 'failed' } : {}) },
      data: { retryAfter: new Date(this.now()) },
    });
    if (updated.count === 0) {
      const row = onlyIfFailed
        ? await this.prisma.smallerCopyAttempt.findUnique({
            where: { stashSceneId },
          })
        : null;
      if (row) {
        // A later try for the scene ended another way (kept both, replaced,
        // on its way): looking again would undo that.
        throw new ConflictException(
          `That scene’s latest try didn’t fail (${row.outcome}), so it’s left as it is.`,
        );
      }
      throw new NotFoundException('That scene hasn’t been looked at yet.');
    }
    return this.status();
  }

  /**
   * Every scene looked at before is due again, a few an hour as usual.
   * Listed matches stay listed; releases already grabbed stay skipped.
   */
  async recheckAll(): Promise<SmallerCopiesDto> {
    const updated = await this.prisma.smallerCopyAttempt.updateMany({
      where: {
        retryAfter: { gt: new Date(this.now()) },
        outcome: { not: 'found' },
      },
      data: { retryAfter: new Date(this.now()) },
    });
    this.logger.log(
      `Better copies: ${updated.count} scene${updated.count === 1 ? '' : 's'} will be looked at again.`,
    );
    return this.status();
  }

  /**
   * Only the scenes whose last try failed are due again now; the rest keep
   * their wait. Failed scenes are always searched before the others, so the
   * next searches are these. Releases that failed stay skipped, so another
   * is looked for.
   */
  async recheckFailed(): Promise<SmallerCopiesDto> {
    const ids = [...(await this.failedSceneIds())];
    // Marked failed again (one searched since may read "nothing found"), so
    // they go first; a scene whose copy is on its way is left alone.
    const updated = await Promise.all(
      ids.map((stashSceneId) =>
        this.prisma.smallerCopyAttempt.updateMany({
          // Checked again at the write: a search between may have found a
          // match waiting for you, or grabbed one.
          where: { stashSceneId, outcome: { notIn: ['grabbed', 'found'] } },
          data: {
            outcome: 'failed',
            detail:
              'You asked to check it again: it’s looked at before other scenes, skipping releases that failed.',
            retryAfter: new Date(this.now()),
          },
        }),
      ),
    );
    const count = updated.reduce((sum, row) => sum + row.count, 0);
    this.logger.log(
      `Better copies: the ${count} failed scene${count === 1 ? '' : 's'} will be looked at next.`,
    );
    return this.status();
  }

  /**
   * The scenes on the Tried tab's Failed list (their latest try failed),
   * and those whose last search failed; not one whose copy is on its way
   * or whose match is waiting for you.
   */
  private async failedSceneIds(): Promise<Set<string>> {
    const [tries, attempts] = await Promise.all([
      this.prisma.smallerCopyTry.findMany({
        orderBy: { createdAt: 'desc' },
        select: { stashSceneId: true, outcome: true },
      }),
      this.prisma.smallerCopyAttempt.findMany({
        where: { outcome: { in: ['failed', 'grabbed', 'found'] } },
        select: { stashSceneId: true, outcome: true },
      }),
    ]);
    const latest = new Map<string, string>();
    for (const row of tries) {
      if (!latest.has(row.stashSceneId)) {
        latest.set(row.stashSceneId, row.outcome);
      }
    }
    const busy = new Set(
      attempts
        .filter((row) => row.outcome !== 'failed')
        .map((row) => row.stashSceneId),
    );
    const ids = new Set(
      attempts
        .filter((row) => row.outcome === 'failed')
        .map((row) => row.stashSceneId),
    );
    for (const [stashSceneId, outcome] of latest) {
      if (outcome === 'failed' && !busy.has(stashSceneId)) {
        ids.add(stashSceneId);
      }
    }
    return ids;
  }

  /**
   * Every release the indexers found for a library scene, for choosing one
   * yourself: each says why the rules wouldn't pick it (empty when they
   * would), including one tried or failed before. Searched with your own
   * words when given.
   */
  async releasesFor(
    stashSceneId: string,
    typed?: string,
  ): Promise<ChooseReleasesDto> {
    const { file, catalogId, provider } = await this.chosenScene(stashSceneId);
    const rules = rulesOf(await this.getSettings());
    const found = await this.downloads.searchReleases(
      catalogId,
      provider,
      typed,
    );
    const attempt = await this.prisma.smallerCopyAttempt
      .findUnique({ where: { stashSceneId } })
      .catch(() => null);
    const grabbed = new Set(attempt?.grabbedGuids ?? []);
    const tried = new Set(
      (
        await this.prisma.smallerCopyTry
          .findMany({
            where: { stashSceneId },
            select: { releaseTitle: true },
          })
          .catch(() => [])
      ).map((row) => releaseKeyOf(row.releaseTitle)),
    );
    const reason = reasonFor(file, rules.target);
    return {
      stashSceneId,
      title: file.title ?? `Scene ${stashSceneId}`,
      oldSize: file.size ?? null,
      releases: found.releases.map((release) => ({
        ...release,
        problems: [
          ...(release.failedBefore
            ? [`SABnzbd couldn’t download it before: ${release.failedBefore}`]
            : []),
          ...(grabbed.has(release.guid) ||
          tried.has(releaseKeyOf(release.title))
            ? ['Grabbed before for this scene']
            : []),
          ...releaseProblems(
            release,
            { size: file.size ?? 0, duration: file.duration },
            reason,
            rules,
          ),
        ],
      })),
      queries: found.queries,
      ...(found.notice ? { notice: found.notice } : {}),
    };
  }

  /**
   * Grabs the release you chose to replace a scene's file, whatever the
   * rules say; the new file is still checked once it's in (same video,
   * smaller or better) before the old one goes. Not one SABnzbd couldn't
   * download before.
   */
  async grabChosen(
    stashSceneId: string,
    release: { guid: string; indexerId: number; title: string; size?: number },
  ): Promise<SmallerCopiesDto> {
    await this.holdScene(stashSceneId, refuseBusy, () =>
      this.sendChosen(stashSceneId, release),
    );
    return this.status();
  }

  /**
   * One replacement at a time per scene, from its checks until it's in
   * Finished downloads: you choosing, you grabbing a listed match and the
   * background search can't both send one. A scene already held gets
   * busy() instead.
   */
  private async holdScene<T>(
    stashSceneId: string,
    busy: () => T,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.choosing.has(stashSceneId)) {
      return busy();
    }
    this.choosing.add(stashSceneId);
    try {
      return await work();
    } finally {
      this.choosing.delete(stashSceneId);
    }
  }

  /** A replacement for this scene sent and not yet in the library. */
  private async replacementOnTheWay(stashSceneId: string): Promise<boolean> {
    const open = await this.prisma.downloadHandoff.count({
      where: {
        replacesStashSceneId: stashSceneId,
        status: { in: OPEN_HANDOFF_STATUSES },
      },
    });
    return open > 0;
  }

  private async sendChosen(
    stashSceneId: string,
    release: { guid: string; indexerId: number; title: string; size?: number },
  ): Promise<void> {
    const { file, catalogId, provider } = await this.chosenScene(stashSceneId);
    // The release that's sent is the one the search found, by its id: its
    // own name is checked and noted, whatever name came with the request.
    const title = this.downloads.rememberedTitle(
      release.indexerId,
      release.guid,
    );
    // Not remembered: sending would refuse it too, and checking a name that
    // came with the request could let a failed release through.
    if (!title) {
      throw new ConflictException(
        'That search result has expired. Search again and pick it once more.',
      );
    }
    const failed = (await this.handoff.failedReleases([title])).get(
      releaseKeyOf(title),
    );
    if (failed) {
      throw new BadRequestException(
        `SABnzbd couldn’t download that release before (${failed}), so it wasn’t sent again. Pick another.`,
      );
    }
    if (await this.replacementOnTheWay(stashSceneId)) {
      throw new ConflictException(ON_ITS_WAY);
    }
    const sent = await this.downloads.grabRelease(
      catalogId,
      { guid: release.guid, indexerId: release.indexerId, title },
      provider,
      // Sent only if it's still the release checked above.
      { replacesStashSceneId: stashSceneId, expectedTitle: title },
    );
    await this.markGrabbed(stashSceneId, {
      title: file.title ?? `Scene ${stashSceneId}`,
      releaseTitle: title,
      releaseGuid: release.guid,
      newSize: release.size ?? null,
      oldSize: file.size ?? null,
      handoffId: sent.handoffId ?? null,
    });
    this.logger.log(
      `Better copies: you chose “${title}” to replace Stash scene ${stashSceneId}.`,
    );
  }

  /** A library scene's biggest file and catalog link, for choosing a release. */
  private async chosenScene(stashSceneId: string): Promise<{
    file: StatsFile;
    catalogId: string;
    provider: Awaited<
      ReturnType<CatalogProviderService['getInstanceCatalogProvider']>
    >['providerKey'];
  }> {
    const file = (await this.libraryFiles())
      .filter((entry) => entry.sceneId === stashSceneId)
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
    if (!file) {
      throw new NotFoundException('That scene isn’t in your library.');
    }
    const index = await this.prisma.librarySceneIndex.findUnique({
      where: { stashSceneId },
    });
    if (!index?.linkedStashId) {
      throw new BadRequestException(
        'That scene isn’t linked to the catalog, so there’s nothing to search for. Match it first.',
      );
    }
    const provider = (await this.catalog.getInstanceCatalogProvider())
      .providerKey;
    return { file, catalogId: index.linkedStashId, provider };
  }

  /** Grabs a match that was listed for you (when grabbing by itself is off). */
  async grabListed(stashSceneId: string): Promise<SmallerCopiesDto> {
    return this.holdScene(stashSceneId, refuseBusy, () =>
      this.grabListedNow(stashSceneId),
    );
  }

  private async grabListedNow(stashSceneId: string): Promise<SmallerCopiesDto> {
    const row = await this.prisma.smallerCopyAttempt.findUnique({
      where: { stashSceneId },
    });
    if (
      !row ||
      row.outcome !== 'found' ||
      !row.releaseGuid ||
      row.indexerId === null
    ) {
      throw new NotFoundException('There’s no match waiting for that scene.');
    }
    const index = await this.prisma.librarySceneIndex.findUnique({
      where: { stashSceneId },
    });
    if (!index?.linkedStashId) {
      throw new BadRequestException(
        'That scene isn’t linked to the catalog any more.',
      );
    }
    const provider = (await this.catalog.getInstanceCatalogProvider())
      .providerKey;
    // The grab needs a fresh search result to find the release by. It also
    // says whether the release failed in SABnzbd since it was listed.
    const found = await this.downloads.searchReleases(
      index.linkedStashId,
      provider,
    );
    const listed = found.releases.find(
      (release) =>
        release.guid === row.releaseGuid ||
        releaseKeyOf(release.title) === releaseKeyOf(row.releaseTitle),
    );
    // Not in the fresh search (the grab sends it from what was found
    // before): its own history says whether it failed.
    const failedBefore =
      listed?.failedBefore ??
      (row.releaseTitle
        ? (await this.handoff.failedReleases([row.releaseTitle])).get(
            releaseKeyOf(row.releaseTitle),
          )
        : undefined);
    if (failedBefore) {
      // Searched again on the next pass, for another release.
      await this.note(stashSceneId, {
        title: row.title,
        oldSize: row.oldSize,
        outcome: 'none-found',
        detail: `The match SABnzbd couldn’t download before: ${failedBefore}`,
        retryAfter: new Date(this.now()),
      });
      throw new BadRequestException(
        `SABnzbd couldn’t download that release before (${failedBefore}), so it wasn’t sent again. It’ll look for another.`,
      );
    }
    if (await this.replacementOnTheWay(stashSceneId)) {
      throw new ConflictException(ON_ITS_WAY);
    }
    const sent = await this.downloads.grabRelease(
      index.linkedStashId,
      {
        guid: row.releaseGuid,
        indexerId: row.indexerId,
        title: row.releaseTitle,
      },
      provider,
      { replacesStashSceneId: stashSceneId },
    );
    await this.markGrabbed(stashSceneId, {
      title: row.title,
      releaseTitle: row.releaseTitle,
      releaseGuid: row.releaseGuid,
      newSize: row.newSize,
      oldSize: row.oldSize,
      handoffId: sent.handoffId ?? null,
    });
    return this.status();
  }

  /** Once a minute; searches only when the hourly limit and the hours allow it. */
  @Interval(60_000)
  /**
   * Looks for the next scene due. Returns why nothing was searched (for Search
   * now to say so), or null when a search ran. `force` is a tap on Search
   * now: it skips the hourly spacing, active hours and a busy Stash queue
   * (searching only asks Prowlarr), but not the cap on replacements on the way.
   */
  async tick(force = false): Promise<string | null> {
    if (this.running) {
      return 'Already searching; give it a moment.';
    }
    this.running = true;
    try {
      // A grab whose download ended where nothing noted it (SABnzbd forgot
      // it, it was stopped by hand): failed, and the scene is due again.
      await this.settleTries().catch((error: unknown) =>
        this.logger.warn(
          `Couldn't bring the tried list up to date: ${messageOf(error)}`,
        ),
      );
      const settings = await this.getSettings();
      if (!settings.enabled) {
        return 'Better copies is switched off.';
      }
      const blocked = await this.blockedBy(settings);
      if (blocked) {
        return blocked;
      }
      if (
        !force &&
        !inActiveHours(
          new Date(this.now()).getHours(),
          settings.activeFromHour,
          settings.activeToHour,
        )
      ) {
        return 'Outside the hours it runs in.';
      }
      const spacing = HOUR / Math.max(1, settings.scenesPerHour);
      if (
        !force &&
        this.lastSearchAt &&
        this.now() - this.lastSearchAt < spacing
      ) {
        return 'Waiting for the next search slot.';
      }
      // Never more work for Stash while it's behind: its queue first.
      const waiting = await this.waitingOnStash(force);
      if (waiting) {
        return waiting;
      }
      const due = await this.failedFirst(
        await this.dueOf(await this.candidates(settings)),
      );
      if (due.length === 0) {
        return 'Nothing is due a search right now.';
      }
      // Scenes with no catalog link cost no search: noted, and the next one tried.
      for (const candidate of due.slice(0, 50)) {
        if (await this.tryOne(candidate, settings)) {
          this.lastSearchAt = this.now();
          return null;
        }
      }
      return 'None of the next scenes is linked to the catalog, so none could be searched.';
    } catch (error) {
      this.logger.warn(`Smaller copies check failed: ${messageOf(error)}`);
      return `The search failed: ${messageOf(error)}`;
    } finally {
      this.running = false;
    }
  }

  /**
   * Why to hold off: replacements still being brought in (each means a scan,
   * a Generate and an Identify), or, unless you asked, a job waiting its turn
   * in Stash's queue. Null when it's fine to search.
   */
  private async waitingOnStash(force: boolean): Promise<string | null> {
    const config = await this.handoff.stashConfig();
    if (!config || !this.stash) {
      return 'Stash isn’t set up.';
    }
    const onTheWay = await this.prisma.downloadHandoff
      .count({
        where: {
          replacesStashSceneId: { not: null },
          status: { in: OPEN_HANDOFF_STATUSES },
        },
      })
      .catch(() => MAX_ON_THE_WAY);
    if (onTheWay >= MAX_ON_THE_WAY) {
      return `${onTheWay} replacements are still on their way in; it searches again once they’re in your library.`;
    }
    if (force) {
      return null;
    }
    const queue = await this.stash.getJobQueue(config).catch(() => null);
    if (!queue || queue.some((job) => job.status === 'READY')) {
      return 'Stash has jobs waiting in its queue.';
    }
    return null;
  }

  /** Searches for one scene; false when it couldn't be searched at all (no catalog link). */
  private async tryOne(
    candidate: Candidate,
    settings: SmallerCopySettings,
  ): Promise<boolean> {
    // Being replaced by you right now: left for a later pass.
    return this.holdScene(
      candidate.file.sceneId,
      () => false,
      () => this.tryOneNow(candidate, settings),
    );
  }

  private async tryOneNow(
    candidate: Candidate,
    settings: SmallerCopySettings,
  ): Promise<boolean> {
    const { file, reason } = candidate;
    const rules = rulesOf(settings);
    const index = await this.prisma.librarySceneIndex
      .findUnique({ where: { stashSceneId: file.sceneId } })
      .catch(() => null);
    const catalogId = index?.linkedStashId ?? null;
    const base = {
      title: file.title ?? `Scene ${file.sceneId}`,
      oldSize: file.size ?? null,
    };
    if (!catalogId) {
      await this.note(file.sceneId, {
        ...base,
        outcome: 'no-catalog-id',
        detail:
          'Not linked to the catalog, so there is nothing to search for. Match it first.',
        retryAfter: new Date(this.now() + LONG_WAIT),
      });
      return false;
    }
    const provider = (await this.catalog.getInstanceCatalogProvider())
      .providerKey;
    try {
      const found = await this.downloads.searchReleases(catalogId, provider);
      // A release already grabbed for this scene isn't grabbed again (with
      // both files kept, the old one still fits the rules).
      const before = await this.prisma.smallerCopyAttempt
        .findUnique({ where: { stashSceneId: file.sceneId } })
        .catch(() => null);
      const taken = new Set(before?.grabbedGuids ?? []);
      // Some indexers give a release a new guid on every search, so the
      // ones tried before are known by title too.
      // If it can't be read, this search fails and is tried again later:
      // better than sending a release that was tried before.
      const triedTitles = new Set(
        (
          await this.prisma.smallerCopyTry.findMany({
            where: { stashSceneId: file.sceneId },
            select: { releaseTitle: true },
          })
        ).map((tried) => releaseKeyOf(tried.releaseTitle)),
      );
      // Read here, not trusted from the search (which carries on without
      // it): if it can't be read, this search fails and is tried later.
      const failed = await this.handoff.failedReleases(
        found.releases.map((candidate) => candidate.title),
      );
      const fresh = found.releases.filter(
        (candidate) =>
          !candidate.failedBefore &&
          !failed.has(releaseKeyOf(candidate.title)) &&
          !taken.has(candidate.guid) &&
          !triedTitles.has(releaseKeyOf(candidate.title)),
      );
      const skipped = found.releases.length - fresh.length;
      const release = pickRelease(
        fresh,
        { size: file.size ?? 0, duration: file.duration },
        reason,
        rules,
      );
      if (!release) {
        await this.note(file.sceneId, {
          ...base,
          outcome: 'none-found',
          detail: `Nothing that fits the rules at ${rules.target} (${found.releases.length} releases looked at${skipped > 0 ? `, ${skipped} left out as tried or failed before` : ''}).`,
          retryAfter: new Date(this.now() + NONE_FOUND_WAIT),
        });
        return true;
      }
      if (!settings.autoGrab) {
        await this.note(file.sceneId, {
          ...base,
          outcome: 'found',
          detail: 'A match that fits the rules. Grab it to replace the file.',
          releaseTitle: release.title,
          releaseGuid: release.guid,
          indexerId: release.indexerId,
          newSize: release.size,
          retryAfter: new Date(this.now() + LONG_WAIT),
        });
        return true;
      }
      // Sent since this pass began (by you): not sent twice.
      if (await this.replacementOnTheWay(file.sceneId)) {
        return false;
      }
      const sent = await this.downloads.grabRelease(
        catalogId,
        {
          guid: release.guid,
          indexerId: release.indexerId,
          title: release.title,
        },
        provider,
        { replacesStashSceneId: file.sceneId },
      );
      await this.markGrabbed(file.sceneId, {
        title: base.title,
        releaseTitle: release.title,
        releaseGuid: release.guid,
        newSize: release.size,
        oldSize: base.oldSize,
        handoffId: sent.handoffId ?? null,
      });
      this.logger.log(
        `Smaller copies: grabbed “${release.title}” to replace Stash scene ${file.sceneId}.`,
      );
      return true;
    } catch (error) {
      await this.note(file.sceneId, {
        ...base,
        outcome: 'failed',
        detail: messageOf(error).slice(0, 300),
        retryAfter: new Date(this.now() + FAILED_WAIT),
      });
      return true;
    }
  }

  private async markGrabbed(
    stashSceneId: string,
    grab: {
      title: string;
      releaseTitle: string | null;
      releaseGuid: string | null;
      newSize: number | null;
      oldSize: number | null;
      /** The Finished downloads entry the grab made. */
      handoffId: string | null;
    },
  ): Promise<void> {
    const settings = await this.getSettings();
    if (grab.releaseGuid) {
      // Kept for good, whatever later searches find.
      await this.prisma.smallerCopyAttempt
        .update({
          where: { stashSceneId },
          data: { grabbedGuids: { push: grab.releaseGuid } },
        })
        .catch(() =>
          this.prisma.smallerCopyAttempt.create({
            data: {
              stashSceneId,
              title: grab.title,
              outcome: 'grabbed',
              grabbedGuids: [grab.releaseGuid!],
              retryAfter: new Date(this.now() + LONG_WAIT),
            },
          }),
        );
    }
    await this.prisma.smallerCopyTry
      .create({
        data: {
          stashSceneId,
          title: grab.title,
          releaseGuid: grab.releaseGuid,
          releaseTitle: grab.releaseTitle,
          outcome: 'grabbed',
          detail: 'On its way.',
          oldSize: grab.oldSize,
          newSize: grab.newSize,
          handoffId: grab.handoffId,
        },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Couldn't keep track of the release grabbed for Stash scene ${stashSceneId}: ${messageOf(error)}`,
        ),
      );
    await this.note(stashSceneId, {
      ...grab,
      outcome: 'grabbed',
      detail:
        settings.oldCopy === 'delete'
          ? 'Sent to SABnzbd. The old file is deleted once the new one is in Stash.'
          : 'Sent to SABnzbd. Both files stay on the scene once the new one is in Stash.',
      retryAfter: new Date(this.now() + LONG_WAIT),
    });
  }

  private note(stashSceneId: string, data: Note): Promise<unknown> {
    const row = {
      title: data.title,
      outcome: data.outcome,
      detail: data.detail ?? null,
      releaseTitle: data.releaseTitle ?? null,
      releaseGuid: data.releaseGuid ?? null,
      indexerId: data.indexerId ?? null,
      oldSize: data.oldSize ?? null,
      newSize: data.newSize ?? null,
      handoffId: data.handoffId ?? null,
      retryAfter: data.retryAfter,
      searchedAt: new Date(this.now()),
    };
    return this.prisma.smallerCopyAttempt.upsert({
      where: { stashSceneId },
      create: { stashSceneId, ...row },
      update: row,
    });
  }

  /** Why it can't search now, in plain words; null when it can. */
  private async blockedBy(
    settings: SmallerCopySettings,
  ): Promise<string | null> {
    if (!settings.enabled) {
      return 'Off.';
    }
    if (!this.stash || !(await this.handoff.stashConfig())) {
      return 'Stash isn’t set up.';
    }
    if (!(await this.handoff.isActive())) {
      return 'Turn on Finished downloads (with SABnzbd) first: that is what brings the new copy in and replaces the old one.';
    }
    return null;
  }

  /** Every file in your library, kept for an hour. */
  private async libraryFiles(): Promise<StatsFile[]> {
    const config = await this.handoff.stashConfig();
    if (!config || !this.stash) {
      return [];
    }
    const kept = this.files;
    if (
      kept &&
      kept.baseUrl === config.baseUrl &&
      this.now() - kept.at < FILES_TTL
    ) {
      return kept.value;
    }
    const files = await this.stash.listLibraryFiles(config);
    this.files = { at: this.now(), baseUrl: config.baseUrl, value: files };
    return files;
  }

  /** Library scenes the rules say to look for, biggest files first. */
  private async candidates(
    settings: SmallerCopySettings,
  ): Promise<Candidate[]> {
    const files = await this.libraryFiles();
    const rules = rulesOf(settings);
    // One entry per scene: its biggest file decides.
    const byScene = new Map<string, StatsFile>();
    for (const file of files) {
      const seen = byScene.get(file.sceneId);
      if (!seen || (file.size ?? 0) > (seen.size ?? 0)) {
        byScene.set(file.sceneId, file);
      }
    }
    return [...byScene.values()]
      .flatMap((file) => {
        const reason = needsReplacing(file, rules);
        return reason ? [{ file, reason }] : [];
      })
      .sort((a, b) => (b.file.size ?? 0) - (a.file.size ?? 0));
  }

  /** Those not searched lately and not already on their way. */
  /**
   * Scenes whose last try failed go first: a try that went wrong is looked
   * at again before scenes not tried yet. Otherwise the order is kept.
   */
  private async failedFirst(due: Candidate[]): Promise<Candidate[]> {
    const failed = new Set(
      (
        await this.prisma.smallerCopyAttempt
          .findMany({
            where: { outcome: 'failed' },
            select: { stashSceneId: true },
          })
          .catch(() => [])
      ).map((row) => row.stashSceneId),
    );
    if (failed.size === 0) {
      return due;
    }
    return [
      ...due.filter((candidate) => failed.has(candidate.file.sceneId)),
      ...due.filter((candidate) => !failed.has(candidate.file.sceneId)),
    ];
  }

  private async dueOf(candidates: Candidate[]): Promise<Candidate[]> {
    if (candidates.length === 0) {
      return [];
    }
    const waiting = await this.prisma.smallerCopyAttempt.findMany({
      where: { retryAfter: { gt: new Date(this.now()) } },
      select: { stashSceneId: true },
    });
    // A replacement still on its way: no new search until it lands or fails.
    // If this can't be read, nothing is due: better no search than a second one.
    const onTheWay = await this.prisma.downloadHandoff.findMany({
      where: {
        replacesStashSceneId: { not: null },
        status: { in: OPEN_HANDOFF_STATUSES },
      },
      select: { replacesStashSceneId: true },
    });
    const skip = new Set([
      ...waiting.map((row) => row.stashSceneId),
      ...onTheWay.flatMap((row) =>
        row.replacesStashSceneId ? [row.replacesStashSceneId] : [],
      ),
    ]);
    return candidates.filter((candidate) => !skip.has(candidate.file.sceneId));
  }
}

function oneOf<T extends string>(
  list: readonly T[],
  value: string,
  fallback: T,
): T {
  return (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

function settingsOf(settings: SmallerCopySettings): SmallerCopySettingsInput {
  return {
    ...rulesOf(settings),
    enabled: settings.enabled,
    autoGrab: settings.autoGrab,
    oldCopy: oneOf(OLD_COPY, settings.oldCopy, 'keep'),
    scenesPerHour: settings.scenesPerHour,
    activeFromHour: settings.activeFromHour,
    activeToHour: settings.activeToHour,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
