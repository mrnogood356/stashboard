import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  Follow,
  FollowKind,
  FollowedScene,
  FollowedSceneState,
} from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PerformersService } from '../performers/performers.service';
import { PrismaService } from '../prisma/prisma.service';
import { runWithRequestedCatalogProvider } from '../providers/catalog/catalog-provider-context';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { type CatalogProviderKey } from '../providers/catalog/catalog-provider.util';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';
import { SubmitSceneRequestDto } from '../requests/dto/submit-scene-request.dto';
import { RequestsService } from '../requests/requests.service';
import { isSceneStatusRequestable } from '../scene-status/dto/scene-status.dto';
import { SceneStatusService } from '../scene-status/scene-status.service';
import {
  EMPTY_EXCLUDE_RULES,
  isSceneExcluded,
  type SceneExcludeRules,
} from '../scenes/scene-exclude-terms.util';
import { ScenesService } from '../scenes/scenes.service';
import {
  CreateFollowDto,
  FollowBackupItemDto,
  type ReleaseView,
  UpdateFollowDto,
} from './dto/follow.dto';
import {
  type CandidateScene,
  clampSince,
  describeCheck,
  type FollowCheckSummary,
  type FollowDto,
  type FollowedReleaseDto,
  type FollowedReleasesDto,
  type FollowLookupDto,
  type FollowTag,
  type FollowsDto,
  pickNewScenes,
  readFollowTags,
  sameFollowTags,
} from './follows.model';

/** Scenes asked for per page, newest first. */
const PAGE_SIZE = 40;
/**
 * After a check has read back to a follow's start, later ones look back only
 * this far before it, for scenes the catalog adds with an earlier date.
 */
const RECHECK_OVERLAP_DAYS = 30;
/** No more follows than a settings backup can hold. */
export const MAX_FOLLOWS = 2000;
/** "All" on the Following page and the Home row reach back this far. */
const RECENT_DAYS = 90;

/** What a check found for one scene, for the notification. */
interface FoundScene {
  title: string;
  followName: string;
  requested: boolean;
}

/**
 * Following performers and studios: a list of them, a check (on a schedule,
 * or Check now) for scenes they've released since you followed, and those
 * scenes listed for review or sent to Whisparr straight away, per follow.
 * Only the main catalog is followed, since only its scenes can be requested.
 */
@Injectable()
export class FollowsService {
  private readonly logger = new Logger(FollowsService.name);
  private running: Promise<FollowCheckSummary> | null = null;
  /**
   * Per follow: saving its settings and acting on one of its scenes take
   * turns, so a scene is never requested from settings changed meanwhile.
   * A save waits at most for one Whisparr call. (One API process, so this
   * lives in memory.)
   */
  private readonly followLocks = new Map<string, Promise<void>>();
  /** Swapped in tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogProvider: CatalogProviderService,
    private readonly performers: PerformersService,
    private readonly scenes: ScenesService,
    private readonly sceneStatus: SceneStatusService,
    private readonly requests: RequestsService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly activity?: ActivityService,
    @Optional() private readonly hiddenContent?: HiddenContentService,
  ) {}

  get checking(): boolean {
    return this.running !== null;
  }

  async list(): Promise<FollowsDto> {
    const [follows, counts, provider] = await Promise.all([
      this.prisma.follow.findMany({ orderBy: { name: 'asc' } }),
      this.reviewCounts(),
      this.instanceProviderKey(),
    ]);
    return {
      follows: follows.map((follow) =>
        toFollowDto(follow, counts.get(follow.id) ?? 0),
      ),
      checking: this.checking,
      provider,
    };
  }

  async lookup(kind: FollowKind, entityId: string): Promise<FollowLookupDto> {
    if (await this.catalogProvider.isBrowseOnlyRequest()) {
      return { follow: null, followable: false };
    }
    const provider = await this.instanceProviderKey();
    if (!provider) {
      return { follow: null, followable: false };
    }
    const follow = await this.prisma.follow.findUnique({
      where: {
        provider_kind_entityId: { provider, kind, entityId: entityId.trim() },
      },
    });
    return {
      follow: follow
        ? toFollowDto(
            follow,
            (await this.reviewCounts(follow.id)).get(follow.id) ?? 0,
          )
        : null,
      followable: true,
    };
  }

  /** Tags to narrow a follow to: always the main catalog's, whatever page asks. */
  async searchTags(query: string): Promise<FollowTag[]> {
    const text = query.trim();
    if (!text) {
      return [];
    }
    const tags = await runWithRequestedCatalogProvider(null, () =>
      this.scenes.searchSceneTags(text),
    );
    return tags.slice(0, 20).map((tag) => ({ id: tag.id, name: tag.name }));
  }

  /** Follows (or updates the follow of) a performer or studio on the main catalog. */
  async follow(dto: CreateFollowDto): Promise<FollowDto> {
    if (await this.catalogProvider.isBrowseOnlyRequest()) {
      throw new BadRequestException(
        'Only your main catalog can be followed, since only its scenes can be requested.',
      );
    }
    const provider = await this.instanceProviderKey();
    if (!provider) {
      throw new BadRequestException(
        'Set up a catalog in Settings → Integrations first.',
      );
    }
    const entityId = dto.entityId.trim();
    const existing = await this.prisma.follow.findUnique({
      where: {
        provider_kind_entityId: { provider, kind: dto.kind, entityId },
      },
    });
    if (!existing && (await this.prisma.follow.count()) >= MAX_FOLLOWS) {
      throw new BadRequestException(
        `You can follow up to ${MAX_FOLLOWS} performers and studios.`,
      );
    }
    const name = dto.name.trim();
    const imageUrl = dto.imageUrl?.trim() || null;
    if (existing) {
      // Following again is a change to the follow, made the same way (in turn
      // with its scenes, tidying what the change makes stale), from the day
      // and with the settings now given.
      return this.withFollowLock(existing.id, async () => {
        await this.prisma.follow.update({
          where: { id: existing.id },
          data: { name, imageUrl },
        });
        return this.applyUpdate(existing.id, {
          since: clampSince(dto.since, this.now()),
          autoRequest: dto.autoRequest ?? false,
          tags: dto.tags ?? [],
        });
      });
    }
    const since = clampSince(dto.since, this.now());
    const tags = readFollowTags(dto.tags ?? []);
    const follow = await this.prisma.follow.create({
      data: {
        provider,
        kind: dto.kind,
        entityId,
        name,
        imageUrl,
        since,
        autoRequest: dto.autoRequest ?? false,
        tags,
      },
    });
    this.logger.log(
      `Following ${follow.kind.toLowerCase()} “${follow.name}” from ${follow.since}${describeTags(tags)}${follow.autoRequest ? ', requesting new scenes' : ''}.`,
    );
    // Starting from an earlier day can already have scenes to show.
    if (since < clampSince(null, this.now())) {
      void this.checkOne(follow.id).catch(() => undefined);
    }
    return toFollowDto(follow, 0);
  }

  update(id: string, dto: UpdateFollowDto): Promise<FollowDto> {
    return this.withFollowLock(id, () => this.applyUpdate(id, dto));
  }

  private async applyUpdate(
    id: string,
    dto: UpdateFollowDto,
  ): Promise<FollowDto> {
    const existing = await this.requireFollow(id);
    const since =
      dto.since === undefined
        ? existing.since
        : clampSince(dto.since, this.now());
    const tags = dto.tags === undefined ? null : readFollowTags(dto.tags);
    const tagsChanged =
      tags !== null && !sameFollowTags(tags, readFollowTags(existing.tags));
    const reachesFurther = since < existing.since;
    const follow = await this.prisma.follow.update({
      where: { id },
      data: {
        since,
        ...(dto.autoRequest === undefined
          ? {}
          : { autoRequest: dto.autoRequest }),
        ...(tagsChanged ? { tags } : {}),
        // Scenes before the old start, or under other tags, haven't been read.
        ...(reachesFurther || tagsChanged ? { fullyCheckedAt: null } : {}),
      },
    });
    if (tagsChanged) {
      this.logger.log(
        `Following “${follow.name}”${describeTags(tags ?? []) || ' with every tag'} now.`,
      );
    }
    if (reachesFurther || tagsChanged || since > existing.since) {
      // What's waiting is tidied by the follow's own check, which runs after
      // any check already under way, so nothing that check adds under the
      // old settings is left behind: under other tags, everything waiting
      // goes; starting later, what's from before the new start.
      void this.checkOne(follow.id, {
        clearWaiting: tagsChanged
          ? 'all'
          : since > existing.since
            ? 'before-start'
            : null,
      }).catch(() => undefined);
    }
    const counts = await this.reviewCounts(id);
    return toFollowDto(follow, counts.get(id) ?? 0);
  }

  unfollow(id: string): Promise<void> {
    return this.withFollowLock(id, async () => {
      const follow = await this.requireFollow(id);
      await this.prisma.follow.delete({ where: { id } });
      this.logger.log(`Stopped following “${follow.name}”.`);
    });
  }

  /** Runs `work` once the follow's earlier save or scene is done. */
  private async withFollowLock<T>(
    id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const before = this.followLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const queued = before.then(() => mine);
    this.followLocks.set(id, queued);
    try {
      await before;
      return await work();
    } finally {
      release();
      if (this.followLocks.get(id) === queued) {
        this.followLocks.delete(id);
      }
    }
  }

  /**
   * Scenes found for your follows: those waiting for review (and automatic
   * requests that failed), or everything of the last few months. A scene two
   * follows found shows once, naming both. A scene requested some other way
   * since leaves the review list.
   */
  async releases(view: ReleaseView, limit = 60): Promise<FollowedReleasesDto> {
    const recentFrom = new Date(
      this.now().getTime() - RECENT_DAYS * 86_400_000,
    );
    const where =
      view === 'review'
        ? {
            state: {
              in: [FollowedSceneState.NEW, FollowedSceneState.FAILED],
            },
          }
        : {
            state: { not: FollowedSceneState.DISMISSED },
            foundAt: { gte: recentFrom },
          };
    const orderBy = [
      { releaseDate: 'desc' as const },
      { foundAt: 'desc' as const },
    ];

    // First which scenes to show, every matching one considered (a scene two
    // follows found is one), less what Settings → Hidden leaves out now;
    // then only those are read in full and checked against Whisparr.
    const rules = await this.hiddenRules();
    const candidates = await this.prisma.followedScene.findMany({
      where,
      select: {
        sceneId: true,
        title: true,
        studioId: true,
        studioName: true,
        follow: { select: { kind: true, entityId: true } },
      },
      orderBy,
    });
    const shownIds = new Set<string>();
    for (const row of candidates) {
      if (
        isFollowHidden(row.follow, rules) ||
        isSceneExcluded(
          {
            title: row.title,
            details: null,
            studioId: row.studioId,
            studioName: row.studioName,
          },
          rules,
        )
      ) {
        continue;
      }
      shownIds.add(row.sceneId);
    }
    // Shown when any follow that found it isn't hidden.
    const sceneIds = [...shownIds].slice(0, limit);

    const rows =
      sceneIds.length === 0
        ? []
        : await this.prisma.followedScene.findMany({
            where: { ...where, sceneId: { in: sceneIds } },
            include: { follow: true },
            orderBy,
          });
    const grouped = groupBySceneId(rows);
    const statuses = await this.sceneStatus.resolveForScenes(
      grouped.map((group) => group.sceneId),
    );

    // Requested from its card, the request sheet or Whisparr itself: it's
    // no longer waiting for you.
    const nowRequested = grouped
      .filter(
        (group) =>
          group.state !== FollowedSceneState.REQUESTED &&
          group.state !== FollowedSceneState.DISMISSED &&
          !isSceneStatusRequestable(
            statuses.get(group.sceneId) ?? { state: 'NOT_REQUESTED' },
          ),
      )
      .map((group) => group.sceneId);
    if (nowRequested.length > 0) {
      await this.prisma.followedScene.updateMany({
        where: {
          sceneId: { in: nowRequested },
          state: { in: [FollowedSceneState.NEW, FollowedSceneState.FAILED] },
        },
        data: { state: FollowedSceneState.REQUESTED, detail: null },
      });
    }

    const mainProvider = await this.instanceProviderKey();
    const items = grouped
      .filter(
        (group) => view !== 'review' || !nowRequested.includes(group.sceneId),
      )
      .map((group): FollowedReleaseDto => {
        const status = statuses.get(group.sceneId) ?? {
          state: 'NOT_REQUESTED' as const,
        };
        const first = group.rows[0];
        // The catalog the scene was found on, which links its card; a follow
        // kept from a catalog that's no longer the main one can't request.
        const source = first.follow.provider as CatalogProviderKey;
        return {
          id: group.sceneId,
          title: first.title,
          description: null,
          imageUrl: first.imageUrl,
          cardImageUrl: withStashImageSize(first.imageUrl, 600),
          studioId: first.studioId,
          studio: first.studioName,
          studioImageUrl: null,
          releaseDate: first.releaseDate,
          duration: first.duration,
          type: 'SCENE',
          source,
          status,
          requestable:
            source === mainProvider && isSceneStatusRequestable(status),
          localSceneId: null,
          followed: {
            state: nowRequested.includes(group.sceneId)
              ? 'REQUESTED'
              : group.state,
            detail: group.rows.find((row) => row.detail)?.detail ?? null,
            foundAt: first.foundAt.toISOString(),
            follows: group.rows.map((row) => ({
              id: row.follow.id,
              kind: row.follow.kind,
              entityId: row.follow.entityId,
              name: row.follow.name,
            })),
          },
        };
      });

    return { items, reviewCount: await this.reviewSceneCount(rules) };
  }

  /** Not interested: the scene leaves the review list for every follow. */
  async dismiss(sceneId: string): Promise<void> {
    await this.prisma.followedScene.updateMany({
      where: { sceneId: sceneId.trim() },
      data: { state: FollowedSceneState.DISMISSED },
    });
  }

  /** Starts a check of every follow unless one is running; true when it started. */
  startCheck(): boolean {
    if (this.running) {
      return false;
    }
    void this.checkAll().catch(() => undefined);
    return true;
  }

  /**
   * Checks every follow, one after the other (the catalog is rate-limited),
   * then sends one notification for everything found. A follow that can't be
   * checked says why on the Following page; the rest still run.
   */
  checkAll(): Promise<FollowCheckSummary> {
    return this.exclusive(async () => {
      const follows = await this.prisma.follow.findMany({
        orderBy: { createdAt: 'asc' },
      });
      return this.check(follows);
    });
  }

  /** The schedule's run: what it did, for Schedules → last run. */
  async runScheduled(): Promise<string> {
    // A check already running (one follow just changed, say) finishes first;
    // this one still checks every follow.
    return describeCheck(await this.checkAll());
  }

  /**
   * Checks one follow after a change to it, once any check under way has
   * finished; first clearing what's waiting that the change makes stale
   * (requested and dismissed scenes stay).
   */
  private checkOne(
    id: string,
    {
      clearWaiting = null,
    }: { clearWaiting?: 'all' | 'before-start' | null } = {},
  ): Promise<FollowCheckSummary> {
    return this.exclusive(async () => {
      const follow = await this.prisma.follow.findUnique({ where: { id } });
      if (follow && clearWaiting) {
        await this.prisma.followedScene.deleteMany({
          where: {
            followId: id,
            state: { in: [FollowedSceneState.NEW, FollowedSceneState.FAILED] },
            ...(clearWaiting === 'before-start'
              ? { releaseDate: { lt: follow.since } }
              : {}),
          },
        });
      }
      // You've just changed this follow and are looking at it: no message.
      return this.check(follow ? [follow] : [], { quiet: true });
    });
  }

  /** One check at a time: a second waits for the first, then runs. */
  private async exclusive(
    run: () => Promise<FollowCheckSummary>,
  ): Promise<FollowCheckSummary> {
    while (this.running) {
      await this.running.catch(() => undefined);
    }
    const promise = run();
    this.running = promise;
    try {
      return await promise;
    } finally {
      if (this.running === promise) {
        this.running = null;
      }
    }
  }

  private async check(
    follows: Follow[],
    { quiet = false }: { quiet?: boolean } = {},
  ): Promise<FollowCheckSummary> {
    const summary: FollowCheckSummary = {
      checked: 0,
      found: 0,
      requested: 0,
      failed: 0,
      errors: 0,
    };
    if (follows.length === 0) {
      return summary;
    }
    const provider = await this.instanceProviderKey().catch(() => null);
    const rules = await this.hiddenRules();
    const found: FoundScene[] = [];
    // Read once per run, and only if a follow requests on its own.
    let defaults: Promise<SubmitSceneRequestDto> | null = null;

    for (const follow of follows) {
      if (!provider || follow.provider !== provider) {
        summary.errors += 1;
        await this.noteChecked(
          follow,
          provider
            ? `Followed on ${follow.provider}, which isn’t your main catalog now.`
            : 'No catalog is set up.',
        );
        continue;
      }
      if (isFollowHidden(follow, rules)) {
        // Its own page shows hidden scenes, so its feed would too.
        await this.noteChecked(
          follow,
          `Hidden in Settings → Hidden, so it isn’t checked.`,
        );
        continue;
      }
      const tags = readFollowTags(follow.tags);
      const shownTags = tags.filter((tag) => !rules.tagIds.has(tag.id));
      if (tags.length > 0 && shownTags.length === 0) {
        await this.noteChecked(
          follow,
          `Its tags are hidden in Settings → Hidden, so it isn’t checked.`,
        );
        continue;
      }
      try {
        const candidates = await this.findNewScenes(
          follow,
          shownTags.map((tag) => tag.id),
        );
        summary.checked += 1;
        for (const scene of candidates) {
          const outcome = await this.record(follow, scene, () => {
            defaults ??= this.requests.getDefaultRequest();
            return defaults;
          });
          if (outcome === null) {
            continue;
          }
          summary.found += 1;
          if (outcome.state === FollowedSceneState.REQUESTED) {
            summary.requested += 1;
          } else if (outcome.state === FollowedSceneState.FAILED) {
            summary.failed += 1;
          }
          found.push({
            title: scene.title,
            followName: follow.name,
            requested: outcome.state === FollowedSceneState.REQUESTED,
          });
        }
        // Read back to its cutoff: later checks need only look back from here.
        await this.noteChecked(follow, null, true);
      } catch (error) {
        summary.errors += 1;
        const message = errorMessage(error);
        this.logger.warn(`Couldn’t check “${follow.name}”: ${message}`);
        await this.noteChecked(follow, message.slice(0, 300));
      }
    }

    if (found.length > 0) {
      this.logger.log(`Following: ${describeCheck(summary)}`);
      await this.activity?.record({
        kind: 'request',
        title: `Following: ${describeCheck(summary)}`,
        detail: found
          .slice(0, 20)
          .map(
            (scene) =>
              `${scene.title} (${scene.followName})${scene.requested ? ' — requested' : ''}`,
          )
          .join('\n'),
        status: summary.failed > 0 ? 'partial' : 'done',
        count: found.length,
      });
      if (!quiet) {
        await this.notifications?.notifyFollowedReleases(found);
      }
    }
    return summary;
  }

  /**
   * New scenes for one follow, from its catalog feed newest first, read back
   * to its start, or (once a check has got that far with these settings) to
   * shortly before that check. Always the main catalog, whatever page started
   * it. Hidden tags aren't asked for: its page would show their scenes.
   */
  private async findNewScenes(
    follow: Follow,
    tagIds: string[],
  ): Promise<CandidateScene[]> {
    const knownRows = await this.prisma.followedScene.findMany({
      where: { followId: follow.id },
      select: { sceneId: true },
    });
    const known = new Set(knownRows.map((row) => row.sceneId));
    const cutoff = checkCutoff(follow);
    const fresh: CandidateScene[] = [];

    // Every page back to the cutoff, which is at most a year back. The feed's
    // hasMore comes from its total, so the pages run out; a page can be short
    // or even empty (hidden scenes are left out of it) and still have more after.
    for (let page = 1; ; page += 1) {
      const feed = await runWithRequestedCatalogProvider(null, () =>
        follow.kind === FollowKind.PERFORMER
          ? this.performers.getPerformerScenes(
              follow.entityId,
              page,
              PAGE_SIZE,
              {
                sort: 'DATE',
                direction: 'DESC',
                // Any of them: the catalog matches a scene with at least one.
                ...(tagIds.length > 0 ? { tagIds } : {}),
              },
            )
          : this.scenes.getScenesFeed(
              page,
              PAGE_SIZE,
              'DATE',
              'DESC',
              tagIds,
              'OR',
              undefined,
              [follow.entityId],
            ),
      );
      const picked = pickNewScenes(feed.items, cutoff, known);
      fresh.push(...picked.fresh);
      if (picked.reachedSince || !feed.hasMore) {
        break;
      }
    }
    // Oldest first, so notifications and the log read in release order.
    return fresh.reverse();
  }

  /**
   * Keeps a found scene for this follow, with the follow's settings as they
   * are now: changed while the check ran (other tags, a later start, or
   * unfollowed), the scene is left for the next check. A scene another follow
   * already found takes that follow's state (requested once, dismissed
   * everywhere); still waiting there, a follow that requests on its own
   * requests it now. Otherwise it's requested now, or left for review.
   */
  private record(
    follow: Follow,
    scene: CandidateScene,
    getDefaults: () => Promise<SubmitSceneRequestDto>,
  ): Promise<{ state: FollowedSceneState } | null> {
    // From reading the follow to saving the scene, its settings can't change.
    return this.withFollowLock(follow.id, () =>
      this.recordScene(follow, scene, getDefaults),
    );
  }

  private async recordScene(
    follow: Follow,
    scene: CandidateScene,
    getDefaults: () => Promise<SubmitSceneRequestDto>,
  ): Promise<{ state: FollowedSceneState } | null> {
    const current = await this.prisma.follow.findUnique({
      where: { id: follow.id },
    });
    if (
      !current ||
      current.since !== follow.since ||
      !sameFollowTags(readFollowTags(current.tags), readFollowTags(follow.tags))
    ) {
      return null;
    }
    const elsewhere = await this.prisma.followedScene.findFirst({
      where: { sceneId: scene.id },
      orderBy: { foundAt: 'asc' },
    });
    const releaseDay = scene.releaseDate?.slice(0, 10) ?? null;
    // A follow a restore added lists what came out by the restore for review:
    // which of those you'd passed on isn't in the backup.
    const requestsOnItsOwn =
      current.autoRequest &&
      !(
        current.reviewThrough &&
        releaseDay !== null &&
        releaseDay <= current.reviewThrough
      );
    const base = {
      followId: follow.id,
      sceneId: scene.id,
      title: scene.title,
      imageUrl: scene.imageUrl,
      studioId: scene.studioId,
      studioName: scene.studio,
      releaseDate: releaseDay,
      duration: scene.duration,
    };

    if (elsewhere) {
      if (!requestsOnItsOwn || elsewhere.state !== FollowedSceneState.NEW) {
        await this.prisma.followedScene.create({
          data: { ...base, state: elsewhere.state, detail: elsewhere.detail },
        });
        return null;
      }
      const outcome = await this.requestScene(current, scene, getDefaults);
      // Every follow that has it waiting now shows it requested (or failed).
      await this.prisma.followedScene.updateMany({
        where: { sceneId: scene.id, state: FollowedSceneState.NEW },
        data: outcome,
      });
      await this.prisma.followedScene.create({ data: { ...base, ...outcome } });
      return { state: outcome.state };
    }

    const outcome = requestsOnItsOwn
      ? await this.requestScene(current, scene, getDefaults)
      : { state: FollowedSceneState.NEW, detail: null };
    await this.prisma.followedScene.create({ data: { ...base, ...outcome } });
    return { state: outcome.state };
  }

  /** Sends a found scene to Whisparr, saying why when it couldn't. */
  private async requestScene(
    follow: Follow,
    scene: CandidateScene,
    getDefaults: () => Promise<SubmitSceneRequestDto>,
  ): Promise<{ state: FollowedSceneState; detail: string | null }> {
    try {
      await this.requests.submitSceneRequest(scene.id, await getDefaults());
      return { state: FollowedSceneState.REQUESTED, detail: null };
    } catch (error) {
      const detail = errorMessage(error).slice(0, 300);
      this.logger.warn(
        `Couldn’t request “${scene.title}” for “${follow.name}”: ${detail}`,
      );
      return { state: FollowedSceneState.FAILED, detail };
    }
  }

  /** Follows and backups: every follow, for Settings → Backup. */
  async exportForBackup(): Promise<{ follows: FollowBackupItemDto[] }> {
    const follows = await this.prisma.follow.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return {
      follows: follows.map((follow) => ({
        kind: follow.kind,
        provider: follow.provider,
        entityId: follow.entityId,
        name: follow.name,
        imageUrl: follow.imageUrl,
        since: follow.since,
        autoRequest: follow.autoRequest,
        tags: readFollowTags(follow.tags),
      })),
    };
  }

  /**
   * Makes the follows the backup's: adds and updates those in it, removes the
   * rest. A follow already here keeps what it found; one whose start or tags
   * change is read again, as when changed by hand. One added by the restore
   * starts from today (or its later start), and what came out by today is
   * listed for review even if it requests on its own: which of those scenes
   * you passed on isn't in the backup, so none is requested again.
   */
  async restoreFromBackup(values: {
    follows: FollowBackupItemDto[];
  }): Promise<void> {
    const keep: string[] = [];
    const today = clampSince(null, this.now());
    for (const item of values.follows) {
      const key = {
        provider: item.provider,
        kind: item.kind,
        entityId: item.entityId,
      };
      const existing = await this.prisma.follow.findUnique({
        where: { provider_kind_entityId: key },
      });
      const savedSince = clampSince(item.since, this.now());
      const tags = readFollowTags(item.tags ?? []);
      const data = {
        name: item.name,
        imageUrl: item.imageUrl ?? null,
        autoRequest: item.autoRequest,
        tags,
      };
      if (!existing) {
        const created = await this.prisma.follow.create({
          data: {
            ...key,
            ...data,
            since: savedSince > today ? savedSince : today,
            reviewThrough: today,
          },
        });
        keep.push(created.id);
        continue;
      }
      await this.withFollowLock(existing.id, async () => {
        const tagsChanged = !sameFollowTags(
          tags,
          readFollowTags(existing.tags),
        );
        const sinceChanged = savedSince !== existing.since;
        await this.prisma.follow.update({
          where: { id: existing.id },
          data: {
            ...data,
            since: savedSince,
            ...(tagsChanged || sinceChanged ? { fullyCheckedAt: null } : {}),
          },
        });
        if (tagsChanged || sinceChanged) {
          // What's waiting may not match the restored settings; the next check
          // finds what does. Requested and dismissed scenes stay.
          await this.prisma.followedScene.deleteMany({
            where: {
              followId: existing.id,
              state: {
                in: [FollowedSceneState.NEW, FollowedSceneState.FAILED],
              },
            },
          });
        }
      });
      keep.push(existing.id);
    }
    // Each follow left out goes once nothing is being saved for it.
    const gone = await this.prisma.follow.findMany({
      where: { id: { notIn: keep } },
      select: { id: true },
    });
    for (const { id } of gone) {
      await this.withFollowLock(id, () =>
        this.prisma.follow.deleteMany({ where: { id } }),
      );
    }
  }

  private async requireFollow(id: string): Promise<Follow> {
    const follow = await this.prisma.follow.findUnique({ where: { id } });
    if (!follow) {
      throw new NotFoundException('You don’t follow that any more.');
    }
    return follow;
  }

  /**
   * Notes a follow's check. A check that read back to its cutoff marks it
   * fully checked, unless the follow changed while it ran (its new settings
   * haven't been read yet).
   */
  private async noteChecked(
    follow: Follow,
    lastError: string | null,
    complete = false,
  ): Promise<void> {
    const now = this.now();
    if (complete) {
      await this.prisma.follow
        .updateMany({
          where: { id: follow.id, updatedAt: follow.updatedAt },
          data: { fullyCheckedAt: now },
        })
        .catch(() => undefined);
    }
    await this.prisma.follow
      .update({
        where: { id: follow.id },
        data: { lastCheckedAt: now, lastError },
      })
      .catch(() => undefined);
  }

  private async reviewCounts(followId?: string): Promise<Map<string, number>> {
    const rows = await this.prisma.followedScene.groupBy({
      by: ['followId'],
      where: {
        state: { in: [FollowedSceneState.NEW, FollowedSceneState.FAILED] },
        ...(followId ? { followId } : {}),
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.followId, row._count._all]));
  }

  /**
   * Scenes (not rows: a scene two follows found counts once) waiting for
   * review, less those Settings → Hidden leaves out.
   */
  private async reviewSceneCount(rules?: SceneExcludeRules): Promise<number> {
    const current = rules ?? (await this.hiddenRules());
    const rows = await this.prisma.followedScene.findMany({
      where: {
        state: { in: [FollowedSceneState.NEW, FollowedSceneState.FAILED] },
      },
      select: {
        sceneId: true,
        title: true,
        studioId: true,
        studioName: true,
        follow: { select: { kind: true, entityId: true } },
      },
    });
    const shown = new Set<string>();
    for (const row of rows) {
      const hidden =
        isFollowHidden(row.follow, current) ||
        isSceneExcluded(
          {
            title: row.title,
            details: null,
            studioId: row.studioId,
            studioName: row.studioName,
          },
          current,
        );
      if (!hidden) {
        shown.add(row.sceneId);
      }
    }
    return shown.size;
  }

  private async hiddenRules(): Promise<SceneExcludeRules> {
    return (
      (await this.hiddenContent?.getRules().catch(() => null)) ??
      EMPTY_EXCLUDE_RULES
    );
  }

  private async instanceProviderKey(): Promise<CatalogProviderKey | null> {
    const type = await this.catalogProvider.getInstanceCatalogProviderType();
    return type ?? null;
  }
}

type FollowedSceneWithFollow = FollowedScene & { follow: Follow };

/** Rows of the same scene together, in the order the scene first appears. */
function groupBySceneId(rows: FollowedSceneWithFollow[]): Array<{
  sceneId: string;
  state: FollowedSceneState;
  rows: FollowedSceneWithFollow[];
}> {
  const groups = new Map<
    string,
    {
      sceneId: string;
      state: FollowedSceneState;
      rows: FollowedSceneWithFollow[];
    }
  >();
  for (const row of rows) {
    const group = groups.get(row.sceneId);
    if (group) {
      group.rows.push(row);
      // Any follow that requested it means it's requested.
      if (row.state === FollowedSceneState.REQUESTED) {
        group.state = row.state;
      }
    } else {
      groups.set(row.sceneId, {
        sceneId: row.sceneId,
        state: row.state,
        rows: [row],
      });
    }
  }
  return [...groups.values()];
}

/**
 * How far back a check reads: the follow's start, or once a check has read
 * that far with its current settings, a little before that check (for scenes
 * the catalog adds with an earlier date).
 */
function checkCutoff(follow: Follow): string {
  if (!follow.fullyCheckedAt) {
    return follow.since;
  }
  const overlap = new Date(
    follow.fullyCheckedAt.getTime() - RECHECK_OVERLAP_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return overlap > follow.since ? overlap : follow.since;
}

/** A followed performer or studio you've since hidden in Settings → Hidden. */
function isFollowHidden(
  follow: { kind: FollowKind; entityId: string },
  rules: SceneExcludeRules,
): boolean {
  return follow.kind === FollowKind.PERFORMER
    ? rules.performerIds.has(follow.entityId)
    : rules.studioIds.has(follow.entityId);
}

function toFollowDto(follow: Follow, newCount: number): FollowDto {
  return {
    id: follow.id,
    kind: follow.kind,
    provider: follow.provider,
    entityId: follow.entityId,
    name: follow.name,
    imageUrl: follow.imageUrl,
    since: follow.since,
    autoRequest: follow.autoRequest,
    tags: readFollowTags(follow.tags),
    lastCheckedAt: follow.lastCheckedAt?.toISOString() ?? null,
    lastError: follow.lastError,
    newCount,
    createdAt: follow.createdAt.toISOString(),
  };
}

/** ", tagged Anal or Outdoor" for the log; nothing when every scene counts. */
function describeTags(tags: Array<{ name: string }>): string {
  return tags.length === 0
    ? ''
    : `, tagged ${tags.map((tag) => tag.name).join(' or ')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
