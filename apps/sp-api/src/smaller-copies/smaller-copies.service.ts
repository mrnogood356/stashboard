import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { SmallerCopyAttempt, SmallerCopySettings } from '@prisma/client';
import { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import { OPEN_HANDOFF_STATUSES } from '../download-handoff/download-handoff.model';
import { DownloadsService } from '../downloads/downloads.service';
import type { StatsFile } from '../playback/library-stats.util';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import {
  CODEC_RULES,
  DEFAULT_RULES,
  inActiveHours,
  MATCH,
  needsReplacing,
  OLD_COPY,
  pickRelease,
  PREFER,
  STUDIO_MODES,
  TARGETS,
  type ReplaceReason,
  type SmallerCopyRules,
  type Target,
} from './smaller-copies.util';

const KEY = 'GLOBAL';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Nothing found: looked for again after a week, as new releases appear. */
const NONE_FOUND_WAIT = 7 * DAY;
/** Grabbed, found, or no catalog link: not looked for again for a month. */
const LONG_WAIT = 30 * DAY;
const FAILED_WAIT = DAY;
/** The library's files are read again at most this often. */
const FILES_TTL = HOUR;

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
  /** Scenes the rules say to look for, and how many of them are due. */
  candidates: number;
  due: number;
  lastSearchAt: string | null;
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
@Injectable()
export class SmallerCopiesService {
  private readonly logger = new Logger(SmallerCopiesService.name);
  private running = false;
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
      maxFileSizeGb: positive(input.maxFileSizeGb),
      minFileSizeGb: positive(input.minFileSizeGb),
      maxNewSizeGb: positive(input.maxNewSizeGb),
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
    return {
      settings: settingsOf(settings),
      blocked,
      candidates: candidates.length,
      due: due.length,
      lastSearchAt: this.lastSearchAt
        ? new Date(this.lastSearchAt).toISOString()
        : null,
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
    };
  }

  /** Grabs a match that was listed for you (when grabbing by itself is off). */
  async grabListed(stashSceneId: string): Promise<SmallerCopiesDto> {
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
    // The grab needs a fresh search result to find the release by.
    await this.downloads.searchReleases(index.linkedStashId, provider);
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
  async tick(force = false): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const settings = await this.getSettings();
      if (!settings.enabled || (await this.blockedBy(settings))) {
        return;
      }
      if (
        !force &&
        !inActiveHours(
          new Date(this.now()).getHours(),
          settings.activeFromHour,
          settings.activeToHour,
        )
      ) {
        return;
      }
      const spacing = HOUR / Math.max(1, settings.scenesPerHour);
      if (
        !force &&
        this.lastSearchAt &&
        this.now() - this.lastSearchAt < spacing
      ) {
        return;
      }
      const due = await this.dueOf(await this.candidates(settings));
      // Scenes with no catalog link cost no search: noted, and the next one tried.
      for (const candidate of due.slice(0, 50)) {
        if (await this.tryOne(candidate, settings)) {
          this.lastSearchAt = this.now();
          break;
        }
      }
    } catch (error) {
      this.logger.warn(`Smaller copies check failed: ${messageOf(error)}`);
    } finally {
      this.running = false;
    }
  }

  /** Searches for one scene; false when it couldn't be searched at all (no catalog link). */
  private async tryOne(
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
      const release = pickRelease(
        found.releases.filter((candidate) => !taken.has(candidate.guid)),
        { size: file.size ?? 0 },
        reason,
        rules,
      );
      if (!release) {
        await this.note(file.sceneId, {
          ...base,
          outcome: 'none-found',
          detail: `Nothing that fits the rules at ${rules.target} (${found.releases.length} releases looked at).`,
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

  /** Library scenes the rules say to look for, biggest files first. */
  private async candidates(
    settings: SmallerCopySettings,
  ): Promise<Candidate[]> {
    const config = await this.handoff.stashConfig();
    if (!config || !this.stash) {
      return [];
    }
    const kept = this.files;
    let files: StatsFile[];
    if (
      kept &&
      kept.baseUrl === config.baseUrl &&
      this.now() - kept.at < FILES_TTL
    ) {
      files = kept.value;
    } else {
      files = await this.stash.listLibraryFiles(config);
      this.files = { at: this.now(), baseUrl: config.baseUrl, value: files };
    }
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
  private async dueOf(candidates: Candidate[]): Promise<Candidate[]> {
    if (candidates.length === 0) {
      return [];
    }
    const waiting = await this.prisma.smallerCopyAttempt.findMany({
      where: { retryAfter: { gt: new Date(this.now()) } },
      select: { stashSceneId: true },
    });
    // A replacement still on its way: no new search until it lands or fails.
    const onTheWay = await this.prisma.downloadHandoff
      .findMany({
        where: {
          replacesStashSceneId: { not: null },
          status: { in: OPEN_HANDOFF_STATUSES },
        },
        select: { replacesStashSceneId: true },
      })
      .catch(() => [] as Array<{ replacesStashSceneId: string | null }>);
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

function rulesOf(settings: SmallerCopySettings): SmallerCopyRules {
  return {
    target: oneOf<Target>(
      TARGETS,
      settings.targetResolution,
      DEFAULT_RULES.target,
    ),
    replaceHigher: settings.replaceHigher,
    upgradeLower: settings.upgradeLower,
    maxFileSizeGb: settings.maxFileSizeGb,
    minFileSizeGb: settings.minFileSizeGb,
    maxNewSizeGb: settings.maxNewSizeGb,
    minSavingsPercent: settings.minSavingsPercent,
    codec: oneOf(CODEC_RULES, settings.codec, DEFAULT_RULES.codec),
    prefer: oneOf(PREFER, settings.prefer, DEFAULT_RULES.prefer),
    matchStrength: oneOf(
      MATCH,
      settings.matchStrength,
      DEFAULT_RULES.matchStrength,
    ),
    studioMode: oneOf(
      STUDIO_MODES,
      settings.studioMode,
      DEFAULT_RULES.studioMode,
    ),
    studioNames: settings.studioNames,
  };
}

function settingsOf(settings: SmallerCopySettings): SmallerCopySettingsInput {
  return {
    ...rulesOf(settings),
    enabled: settings.enabled,
    autoGrab: settings.autoGrab,
    oldCopy: oneOf(OLD_COPY, settings.oldCopy, 'delete'),
    scenesPerHour: settings.scenesPerHour,
    activeFromHour: settings.activeFromHour,
    activeToHour: settings.activeToHour,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
