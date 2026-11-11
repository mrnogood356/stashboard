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
/** Pages read per follow and check: at most 120 scenes back. */
const MAX_PAGES = 3;
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
    const since = clampSince(dto.since, this.now());
    const data = {
      name: dto.name.trim(),
      imageUrl: dto.imageUrl?.trim() || null,
      since,
      autoRequest: dto.autoRequest ?? false,
      tags: readFollowTags(dto.tags ?? []),
    };
    const follow = await this.prisma.follow.upsert({
      where: {
        provider_kind_entityId: { provider, kind: dto.kind, entityId },
      },
      create: { provider, kind: dto.kind, entityId, ...data },
      update: data,
    });
    this.logger.log(
      `Following ${follow.kind.toLowerCase()} “${follow.name}” from ${follow.since}${describeTags(data.tags)}${follow.autoRequest ? ', requesting new scenes' : ''}.`,
    );
    // Starting from an earlier day can already have scenes to show.
    if (since < clampSince(null, this.now())) {
      void this.checkOne(follow.id).catch(() => undefined);
    }
    return toFollowDto(follow, 0);
  }

  async update(id: string, dto: UpdateFollowDto): Promise<FollowDto> {
    const existing = await this.requireFollow(id);
    const since =
      dto.since === undefined
        ? existing.since
        : clampSince(dto.since, this.now());
    const tags = dto.tags === undefined ? null : readFollowTags(dto.tags);
    const tagsChanged =
      tags !== null && !sameFollowTags(tags, readFollowTags(existing.tags));
    const follow = await this.prisma.follow.update({
      where: { id },
      data: {
        since,
        ...(dto.autoRequest === undefined
          ? {}
          : { autoRequest: dto.autoRequest }),
        ...(tagsChanged ? { tags } : {}),
      },
    });
    if (tagsChanged) {
      // What's waiting may not have these tags: look again from scratch.
      // Requested and dismissed scenes stay as they are.
      await this.prisma.followedScene.deleteMany({
        where: {
          followId: id,
          state: { in: [FollowedSceneState.NEW, FollowedSceneState.FAILED] },
        },
      });
      this.logger.log(
        `Following “${follow.name}”${describeTags(tags ?? []) || ' with every tag'} now.`,
      );
    }
    if (since < existing.since || tagsChanged) {
      void this.checkOne(follow.id).catch(() => undefined);
    }
    const counts = await this.reviewCounts(id);
    return toFollowDto(follow, counts.get(id) ?? 0);
  }

  async unfollow(id: string): Promise<void> {
    const follow = await this.requireFollow(id);
    await this.prisma.follow.delete({ where: { id } });
    this.logger.log(`Stopped following “${follow.name}”.`);
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
    const rows = await this.prisma.followedScene.findMany({
      where:
        view === 'review'
          ? {
              state: {
                in: [FollowedSceneState.NEW, FollowedSceneState.FAILED],
              },
            }
          : {
              state: { not: FollowedSceneState.DISMISSED },
              foundAt: { gte: recentFrom },
            },
      include: { follow: true },
      orderBy: [{ releaseDate: 'desc' }, { foundAt: 'desc' }],
      take: 1000,
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

    const source = (await this.instanceProviderKey()) ?? 'STASHDB';
    const items = grouped
      .filter(
        (group) => view !== 'review' || !nowRequested.includes(group.sceneId),
      )
      .slice(0, limit)
      .map((group): FollowedReleaseDto => {
        const status = statuses.get(group.sceneId) ?? {
          state: 'NOT_REQUESTED' as const,
        };
        const first = group.rows[0];
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
          requestable: isSceneStatusRequestable(status),
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

    const reviewCount =
      view === 'review'
        ? grouped.length - nowRequested.length
        : await this.reviewSceneCount();
    return { items, reviewCount };
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
    if (this.running) {
      return 'Already checking.';
    }
    return describeCheck(await this.checkAll());
  }

  private checkOne(id: string): Promise<FollowCheckSummary> {
    return this.exclusive(async () => {
      const follow = await this.prisma.follow.findUnique({ where: { id } });
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
    const found: FoundScene[] = [];
    // Read once per run, and only if a follow requests on its own.
    let defaults: Promise<SubmitSceneRequestDto> | null = null;

    for (const follow of follows) {
      if (!provider || follow.provider !== provider) {
        summary.errors += 1;
        await this.noteChecked(
          follow.id,
          provider
            ? `Followed on ${follow.provider}, which isn’t your main catalog now.`
            : 'No catalog is set up.',
        );
        continue;
      }
      try {
        const candidates = await this.findNewScenes(follow);
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
        await this.noteChecked(follow.id, null);
      } catch (error) {
        summary.errors += 1;
        const message = errorMessage(error);
        this.logger.warn(`Couldn’t check “${follow.name}”: ${message}`);
        await this.noteChecked(follow.id, message.slice(0, 300));
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
   * New scenes for one follow, newest first, from its catalog feed. Always the
   * main catalog, whatever page started the check.
   */
  private async findNewScenes(follow: Follow): Promise<CandidateScene[]> {
    const knownRows = await this.prisma.followedScene.findMany({
      where: { followId: follow.id },
      select: { sceneId: true },
    });
    const known = new Set(knownRows.map((row) => row.sceneId));
    // Any of them: the catalog matches a scene with at least one.
    const tagIds = readFollowTags(follow.tags).map((tag) => tag.id);
    const fresh: CandidateScene[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const feed = await runWithRequestedCatalogProvider(null, () =>
        follow.kind === FollowKind.PERFORMER
          ? this.performers.getPerformerScenes(
              follow.entityId,
              page,
              PAGE_SIZE,
              {
                sort: 'DATE',
                direction: 'DESC',
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
      const picked = pickNewScenes(feed.items, follow.since, known);
      fresh.push(...picked.fresh);
      if (picked.reachedSince || !feed.hasMore) {
        break;
      }
    }
    // Oldest first, so notifications and the log read in release order.
    return fresh.reverse();
  }

  /**
   * Keeps a found scene for this follow. A scene another follow already found
   * takes that follow's state (requested once, dismissed everywhere) and isn't
   * news again. Otherwise it's requested now, or left for review.
   */
  private async record(
    follow: Follow,
    scene: CandidateScene,
    getDefaults: () => Promise<SubmitSceneRequestDto>,
  ): Promise<{ state: FollowedSceneState } | null> {
    const elsewhere = await this.prisma.followedScene.findFirst({
      where: { sceneId: scene.id },
      orderBy: { foundAt: 'asc' },
    });
    const base = {
      followId: follow.id,
      sceneId: scene.id,
      title: scene.title,
      imageUrl: scene.imageUrl,
      studioId: scene.studioId,
      studioName: scene.studio,
      releaseDate: scene.releaseDate?.slice(0, 10) ?? null,
      duration: scene.duration,
    };
    if (elsewhere) {
      await this.prisma.followedScene.create({
        data: { ...base, state: elsewhere.state, detail: elsewhere.detail },
      });
      return null;
    }

    let state: FollowedSceneState = FollowedSceneState.NEW;
    let detail: string | null = null;
    if (follow.autoRequest) {
      try {
        await this.requests.submitSceneRequest(scene.id, await getDefaults());
        state = FollowedSceneState.REQUESTED;
      } catch (error) {
        state = FollowedSceneState.FAILED;
        detail = errorMessage(error).slice(0, 300);
        this.logger.warn(
          `Couldn’t request “${scene.title}” for “${follow.name}”: ${detail}`,
        );
      }
    }
    await this.prisma.followedScene.create({
      data: { ...base, state, detail },
    });
    return { state };
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
   * Makes the follows the backup's: adds and updates those in it, removes
   * the rest. Scenes already found for a kept follow stay.
   */
  async restoreFromBackup(values: {
    follows: FollowBackupItemDto[];
  }): Promise<void> {
    const keep: string[] = [];
    for (const item of values.follows) {
      const where = {
        provider_kind_entityId: {
          provider: item.provider,
          kind: item.kind,
          entityId: item.entityId,
        },
      };
      const data = {
        name: item.name,
        imageUrl: item.imageUrl ?? null,
        since: clampSince(item.since, this.now()),
        autoRequest: item.autoRequest,
        tags: readFollowTags(item.tags ?? []),
      };
      const follow = await this.prisma.follow.upsert({
        where,
        create: { ...where.provider_kind_entityId, ...data },
        update: data,
      });
      keep.push(follow.id);
    }
    await this.prisma.follow.deleteMany({ where: { id: { notIn: keep } } });
  }

  private async requireFollow(id: string): Promise<Follow> {
    const follow = await this.prisma.follow.findUnique({ where: { id } });
    if (!follow) {
      throw new NotFoundException('You don’t follow that any more.');
    }
    return follow;
  }

  private async noteChecked(
    id: string,
    lastError: string | null,
  ): Promise<void> {
    await this.prisma.follow
      .update({
        where: { id },
        data: { lastCheckedAt: this.now(), lastError },
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

  /** Scenes (not rows: a scene two follows found counts once) waiting for review. */
  private async reviewSceneCount(): Promise<number> {
    const rows = await this.prisma.followedScene.findMany({
      where: {
        state: { in: [FollowedSceneState.NEW, FollowedSceneState.FAILED] },
      },
      select: { sceneId: true },
      distinct: ['sceneId'],
    });
    return rows.length;
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
