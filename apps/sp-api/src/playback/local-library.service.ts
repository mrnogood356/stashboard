import { groupSimilarTags, type SimilarTagGroup } from './tag-cleanup.util';
import type {
  StashProblemKind,
  StashProblemScene,
} from '../providers/stash/stash.types';
import {
  computeLibraryStats,
  type LibraryStatsDto,
} from './library-stats.util';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ActivityService } from '../activity/activity.service';
import { OrganizerService } from '../organizer/organizer.service';
import { PrismaService } from '../prisma/prisma.service';
import { isSamplePath } from './sample.util';
export { isSamplePath } from './sample.util';
import {
  StashAdapter,
  type StashDuplicateScene,
  type StashJob,
  type StashLibraryTask,
  type StashLocalSceneCard,
  type StashLocalSceneUpdate,
} from '../providers/stash/stash.adapter';
import type {
  FixKind,
  LocalBulkAction,
  LocalSceneSort,
} from './dto/local-library.dto';
import { stashMediaUrl } from '../media/media-url.util';
import { LocalSceneDetailsDto, PlaybackService } from './playback.service';

const PAGE_SIZE = 24;
const RELATED_LIMIT = 16;

/** A library scene as a card (matches the web app's scene cards). */
export interface LocalSceneCardDto {
  id: string;
  title: string;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
  releaseDate: string | null;
  duration: number | null;
  playCount: number;
  /** How far through the scene playback got, 0 to 1. */
  progress: number | null;
  type: 'SCENE';
  source: 'STASH';
}

export interface LocalScenePageDto {
  total: number;
  page: number;
  hasMore: boolean;
  items: LocalSceneCardDto[];
}

export interface LocalPerformerDto {
  id: string;
  name: string;
  disambiguation: string | null;
  gender: string | null;
  birthdate: string | null;
  country: string | null;
  details: string | null;
  favorite: boolean;
  imageUrl: string | null;
  sceneCount: number;
}

export interface DuplicateSceneDto extends Omit<
  StashDuplicateScene,
  'screenshotVersion'
> {
  imageUrl: string | null;
}

export interface SampleSceneDto extends DuplicateSceneDto {
  /** Why it looks like a sample: its name says so, or it's very short. */
  reason: 'name' | 'short';
}

export const PROBLEM_KINDS: StashProblemKind[] = [
  'no-file',
  'no-length',
  'no-cover',
  'no-fingerprint',
];

export interface ProblemListDto {
  kind: StashProblemKind;
  count: number | null;
  scenes: StashProblemScene[];
}

export interface DuplicateGroupDto {
  scenes: DuplicateSceneDto[];
  /** The copy to keep: highest resolution, then picture for the codec, then length. */
  suggestedKeepId: string;
  /** Why that one, in plain words. */
  keepReason: string;
}

export interface FixCountsDto {
  unmatched: number;
  untagged: number;
  unorganized: number;
}

const FIX_FILTERS: Record<FixKind, Record<string, unknown>> = {
  unmatched: { is_missing: 'stash_id' },
  untagged: { is_missing: 'tags' },
  unorganized: { organized: false },
};

const DUPLICATE_DISTANCE = { exact: 0, high: 4, medium: 8 } as const;

export interface LocalSearchDto {
  performers: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
    favorite: boolean;
    /** Their ids on StashDB/FansDB, to show them once next to catalog results. */
    catalogIds: string[];
  }>;
  studios: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
    catalogIds: string[];
  }>;
}

export interface LocalStudioDto {
  id: string;
  name: string;
  favorite: boolean;
  imageUrl: string | null;
  sceneCount: number;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
  /** Its StashDB/FansDB ids, for its catalog page. */
  catalogIds: string[];
}

export interface LocalBulkResultDto {
  action: LocalBulkAction;
  /** Scenes the action worked on. */
  done: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Your own Stash library, beyond playback: organizing a scene, related scenes,
 * and performer and studio pages. Everything is read from and saved to Stash.
 */
/** How long Library stats are kept before Stash is asked again. */
const STATS_TTL_MS = 30 * 60_000;

@Injectable()
export class LocalLibraryService {
  private readonly logger = new Logger(LocalLibraryService.name);

  constructor(
    private readonly playback: PlaybackService,
    private readonly stash: StashAdapter,
    @Optional() private readonly organizer?: OrganizerService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * One action on many scenes, one at a time: mark them organized, remove
   * them from Stash (files stay), or delete them with their files.
   */
  async bulkScenes(
    action: LocalBulkAction,
    sceneIds: string[],
  ): Promise<LocalBulkResultDto> {
    const ids = [...new Set(sceneIds.map((id) => id.trim()).filter(Boolean))];
    const done: string[] = [];
    const failed: LocalBulkResultDto['failed'] = [];
    const config =
      action === 'organize' ? await this.playback.getStashConfig() : null;
    for (const id of ids) {
      try {
        if (config) {
          await this.stash.updateLocalScene(config, id, { organized: true });
        } else {
          await this.deleteScene(id, action === 'delete');
        }
        done.push(id);
      } catch (error) {
        failed.push({
          id,
          reason:
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : 'Stash didn’t take the change.',
        });
      }
    }
    const line = `Bulk ${action} in Stash: ${done.length} of ${ids.length} scene(s) done, ${failed.length} failed.`;
    if (failed.length > 0) {
      this.logger.warn(`${line} First problem: ${failed[0].reason}`);
    } else {
      this.logger.log(line);
    }
    return { action, done, failed };
  }
  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  async updateScene(
    sceneId: string,
    update: StashLocalSceneUpdate,
  ): Promise<LocalSceneDetailsDto> {
    const config = await this.playback.getStashConfig();
    await this.stash.updateLocalScene(config, sceneId, update);
    return this.playback.getSceneDetails(sceneId);
  }

  async setWatched(
    sceneId: string,
    watched: boolean,
  ): Promise<LocalSceneDetailsDto> {
    const config = await this.playback.getStashConfig();
    await this.stash.setSceneWatched(config, sceneId, watched);
    return this.playback.getSceneDetails(sceneId);
  }

  /**
   * Scenes like this one: same performers first, then the same studio, then
   * the same tags. Unwatched scenes come first. The order is stable per scene.
   */
  async related(sceneId: string): Promise<LocalSceneCardDto[]> {
    const config = await this.playback.getStashConfig();
    const scene = await this.stash.getLocalSceneDetails(config, sceneId);
    if (!scene) {
      throw new NotFoundException('That scene is not in your Stash library.');
    }

    const sort = `random_${seedFrom(scene.id)}`;
    const query = (sceneFilter: Record<string, unknown>) =>
      this.stash
        .findLocalScenes(config, {
          page: 1,
          perPage: RELATED_LIMIT,
          sort,
          direction: 'ASC',
          sceneFilter,
        })
        .then((page) => page.items)
        .catch(() => [] as StashLocalSceneCard[]);

    const performerIds = scene.performers.map((performer) => performer.id);
    const tagIds = scene.tags.slice(0, 3).map((tag) => tag.id);
    const [byPerformers, byStudio, byTags] = await Promise.all([
      performerIds.length
        ? query({ performers: { value: performerIds, modifier: 'INCLUDES' } })
        : Promise.resolve([]),
      scene.studio
        ? query({
            studios: {
              value: [scene.studio.id],
              modifier: 'INCLUDES',
              depth: 0,
            },
          })
        : Promise.resolve([]),
      tagIds.length
        ? query({ tags: { value: tagIds, modifier: 'INCLUDES_ALL', depth: 0 } })
        : Promise.resolve([]),
    ]);

    const seen = new Set([scene.id]);
    const merged: StashLocalSceneCard[] = [];
    for (const item of [...byPerformers, ...byStudio, ...byTags]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    // Stable sort keeps the relevance order within watched/unwatched groups.
    merged.sort(
      (left, right) => Number(left.playCount > 0) - Number(right.playCount > 0),
    );
    return merged.slice(0, RELATED_LIMIT).map(toCard);
  }

  async performer(performerId: string): Promise<LocalPerformerDto> {
    const config = await this.playback.getStashConfig();
    const performer = await this.stash.getLocalPerformer(config, performerId);
    if (!performer) {
      throw new NotFoundException(
        'That performer is not in your Stash library.',
      );
    }
    const { imageVersion, ...rest } = performer;
    return {
      ...rest,
      imageUrl: imageVersion
        ? stashMediaUrl(
            `performers/${encodeURIComponent(performer.id)}/image`,
            imageVersion,
            640,
          )
        : null,
    };
  }

  async studio(studioId: string): Promise<LocalStudioDto> {
    const config = await this.playback.getStashConfig();
    const studio = await this.stash.getLocalStudio(config, studioId);
    if (!studio) {
      throw new NotFoundException('That studio is not in your Stash library.');
    }
    const { imageVersion, ...rest } = studio;
    return {
      ...rest,
      imageUrl: imageVersion
        ? stashMediaUrl(
            `studios/${encodeURIComponent(studio.id)}/logo`,
            imageVersion,
          )
        : null,
    };
  }

  performerScenes(
    performerId: string,
    page = 1,
    sort: LocalSceneSort = 'DATE',
    seed = 0,
  ) {
    return this.scenePage(
      { performers: { value: [performerId], modifier: 'INCLUDES_ALL' } },
      page,
      sort,
      seed,
    );
  }

  studioScenes(
    studioId: string,
    page = 1,
    sort: LocalSceneSort = 'DATE',
    seed = 0,
  ) {
    // depth -1 includes scenes from the studio's sub-studios.
    return this.scenePage(
      { studios: { value: [studioId], modifier: 'INCLUDES', depth: -1 } },
      page,
      sort,
      seed,
    );
  }

  async setPerformerFavorite(
    performerId: string,
    favorite: boolean,
  ): Promise<LocalPerformerDto> {
    const config = await this.playback.getStashConfig();
    await this.stash.setPerformerFavorite(config, performerId, favorite);
    return this.performer(performerId);
  }

  async setStudioFavorite(
    studioId: string,
    favorite: boolean,
  ): Promise<LocalStudioDto> {
    const config = await this.playback.getStashConfig();
    await this.stash.setStudioFavorite(config, studioId, favorite);
    return this.studio(studioId);
  }

  async search(query: string): Promise<LocalSearchDto> {
    const config = await this.playback.getStashConfig();
    const result = await this.stash.searchLocalPeople(config, query);
    return {
      performers: result.performers.map(({ imageVersion, ...performer }) => ({
        ...performer,
        imageUrl: imageVersion
          ? stashMediaUrl(
              `performers/${encodeURIComponent(performer.id)}/image`,
              imageVersion,
              320,
            )
          : null,
      })),
      studios: result.studios.map(({ imageVersion, ...studio }) => ({
        ...studio,
        imageUrl: imageVersion
          ? stashMediaUrl(
              `studios/${encodeURIComponent(studio.id)}/logo`,
              imageVersion,
            )
          : null,
      })),
    };
  }

  async addMarker(
    sceneId: string,
    marker: { title: string; seconds: number; primaryTagId: string },
  ): Promise<LocalSceneDetailsDto> {
    const config = await this.playback.getStashConfig();
    await this.stash.createSceneMarker(config, sceneId, marker);
    return this.playback.getSceneDetails(sceneId);
  }

  async deleteMarker(
    sceneId: string,
    markerId: string,
  ): Promise<LocalSceneDetailsDto> {
    const config = await this.playback.getStashConfig();
    await this.stash.deleteSceneMarker(config, markerId);
    return this.playback.getSceneDetails(sceneId);
  }

  /** Takes a scene off Continue Watching by forgetting where playback stopped. */
  async clearResume(sceneId: string): Promise<void> {
    const config = await this.playback.getStashConfig();
    await this.stash.saveSceneActivity(config, sceneId, 0, 0);
  }

  // ---------- swipe feed ----------

  feed(page = 1, seed = 1): Promise<LocalScenePageDto> {
    return this.scenePage({}, page, 'RANDOM', seed || 1);
  }

  // ---------- fix my library ----------

  async fixCounts(): Promise<FixCountsDto> {
    const config = await this.playback.getStashConfig();
    const count = (kind: FixKind) =>
      this.stash
        .findLocalScenes(config, {
          page: 1,
          perPage: 1,
          sort: 'created_at',
          direction: 'DESC',
          sceneFilter: FIX_FILTERS[kind],
        })
        .then((page) => page.total)
        .catch((error: unknown) => {
          this.logger.warn(
            `Couldn't count ${kind} scenes in Stash: ${error instanceof Error ? error.message : String(error)}`,
          );
          return 0;
        });
    const [unmatched, untagged, unorganized] = await Promise.all([
      count('unmatched'),
      count('untagged'),
      count('unorganized'),
    ]);
    return { unmatched, untagged, unorganized };
  }

  /**
   * With an offset, the list starts right after the scenes already shown.
   * Scenes fixed meanwhile leave the list, so a plain next page would skip
   * the scenes that moved up into their place.
   */
  async fixScenes(
    kind: FixKind,
    page = 1,
    offset?: number,
  ): Promise<LocalScenePageDto> {
    if (offset === undefined) {
      return this.scenePage(FIX_FILTERS[kind], page, 'ADDED', 0);
    }
    const firstPage = Math.floor(offset / PAGE_SIZE) + 1;
    const skip = offset % PAGE_SIZE;
    const first = await this.scenePage(
      FIX_FILTERS[kind],
      firstPage,
      'ADDED',
      0,
    );
    let items = first.items.slice(skip);
    let total = first.total;
    if (skip > 0 && first.hasMore) {
      const next = await this.scenePage(
        FIX_FILTERS[kind],
        firstPage + 1,
        'ADDED',
        0,
      );
      items = [...items, ...next.items.slice(0, skip)];
      total = next.total;
    }
    return {
      total,
      page: firstPage,
      hasMore: offset + items.length < total,
      items,
    };
  }

  async identify(sceneIds: string[]): Promise<{ jobId: string | null }> {
    if (sceneIds.length === 0) {
      throw new BadRequestException('Pick at least one scene to identify.');
    }
    const config = await this.playback.getStashConfig();
    const jobId = await this.stash.startLibraryTask(
      config,
      'identify',
      sceneIds,
    );
    this.logger.log(
      `Asked Stash to identify ${sceneIds.length} scene(s)${jobId ? ` (job ${jobId})` : ''}.`,
    );
    await this.activity?.record({
      kind: 'match',
      title: `Asked Stash to identify ${sceneIds.length} ${sceneIds.length === 1 ? 'scene' : 'scenes'}.`,
      detail: 'Stash’s Identify runs in Stash jobs, with your stash-boxes.',
      count: sceneIds.length,
    });
    return { jobId };
  }

  // ---------- Stash jobs ----------

  async jobs(): Promise<StashJob[]> {
    const config = await this.playback.getStashConfig();
    return this.stash.getJobQueue(config);
  }

  async startJob(task: StashLibraryTask): Promise<{ jobId: string | null }> {
    const config = await this.playback.getStashConfig();
    const jobId = await this.stash.startLibraryTask(config, task);
    this.logger.log(
      `Started Stash’s ${JOB_NAMES[task]}${jobId ? ` (job ${jobId})` : ''}.`,
    );
    await this.activity?.record({
      kind: 'scan',
      title: `Started Stash’s ${JOB_NAMES[task]}.`,
      detail: 'It runs in Stash; follow it in Tools → Stash jobs.',
    });
    return { jobId };
  }

  /** Generate (previews, sprites, covers, fingerprints) for just these scenes. */
  async generateFor(sceneIds: string[]): Promise<{ jobId: string | null }> {
    // An empty list would make Stash generate for the whole library.
    if (sceneIds.length === 0) {
      throw new BadRequestException('Pick at least one scene.');
    }
    const config = await this.playback.getStashConfig();
    const jobId = await this.stash.startLibraryTask(
      config,
      'generate',
      sceneIds,
    );
    this.logger.log(
      `Started Stash’s Generate for ${sceneIds.length} scene${sceneIds.length === 1 ? '' : 's'}${jobId ? ` (job ${jobId})` : ''}.`,
    );
    return { jobId };
  }

  // ---------- tag cleanup ----------

  async similarTags(): Promise<SimilarTagGroup[]> {
    const config = await this.playback.getStashConfig();
    return groupSimilarTags(await this.stash.listTags(config));
  }

  /**
   * Merges tags into one, after you pick them. Only tags Stash still has, and
   * never a tag into itself.
   */
  async mergeTags(destinationId: string, sourceIds: string[]): Promise<void> {
    const sources = [...new Set(sourceIds)].filter(
      (id) => id !== destinationId,
    );
    if (sources.length === 0) {
      throw new BadRequestException('Pick at least one other tag to merge.');
    }
    const config = await this.playback.getStashConfig();
    const tags = new Map(
      (await this.stash.listTags(config)).map((tag) => [tag.id, tag]),
    );
    const destination = tags.get(destinationId);
    const missing = sources.filter((id) => !tags.has(id));
    if (!destination || missing.length > 0) {
      throw new BadRequestException(
        'One of those tags is gone from Stash. Look again.',
      );
    }
    await this.stash.mergeTags(config, sources, destinationId);
    const names = sources.map((id) => tags.get(id)!.name);
    this.logger.log(
      `Merged tags ${names.join(', ')} into ${destination.name}.`,
    );
    await this.activity?.record({
      kind: 'scan',
      title: `Merged ${names.length} tag${names.length === 1 ? '' : 's'} into ${destination.name}.`,
      detail: names.join(', '),
    });
  }

  // ---------- broken files ----------

  /** Each kind of problem: how many scenes, and the first 50. Null when Stash couldn't say. */
  async problems(): Promise<ProblemListDto[]> {
    const config = await this.playback.getStashConfig();
    return Promise.all(
      PROBLEM_KINDS.map(async (kind) => {
        try {
          const found = await this.stash.findProblemScenes(config, kind);
          return { kind, count: found.count, scenes: found.scenes };
        } catch {
          return { kind, count: null, scenes: [] };
        }
      }),
    );
  }

  async stopJob(jobId: string): Promise<void> {
    const config = await this.playback.getStashConfig();
    await this.stash.stopJob(config, jobId);
    this.logger.log(`Stopped Stash job ${jobId}.`);
  }

  // ---------- duplicates ----------

  async duplicates(
    accuracy: keyof typeof DUPLICATE_DISTANCE = 'exact',
  ): Promise<DuplicateGroupDto[]> {
    const config = await this.playback.getStashConfig();
    const groups = await this.stash.findDuplicateScenes(
      config,
      DUPLICATE_DISTANCE[accuracy],
    );
    return groups.map((group) => ({
      scenes: group.map(({ screenshotVersion, ...scene }) => ({
        ...scene,
        imageUrl: screenshotVersion
          ? stashMediaUrl(
              `scenes/${encodeURIComponent(scene.id)}/screenshot`,
              screenshotVersion,
              480,
            )
          : null,
      })),
      ...(({ id, reason }) => ({ suggestedKeepId: id, keepReason: reason }))(
        pickKeeperWithReason(group),
      ),
    }));
  }

  // ---------- stats ----------

  /** Kept with the Stash address it came from, so another Stash is read afresh. */
  private statsCache: {
    at: number;
    baseUrl: string;
    value: LibraryStatsDto;
  } | null = null;
  /** The read under way, with the Stash address it's reading. */
  private statsRun: {
    baseUrl: string;
    token: symbol;
    value: Promise<LibraryStatsDto>;
  } | null = null;

  /**
   * What the library is made of: size by resolution, codec and studio, the
   * biggest files, and what re-encoding could save. Kept 30 minutes;
   * refresh asks Stash again.
   */
  async stats(refresh = false): Promise<LibraryStatsDto> {
    const config = await this.playback.getStashConfig();
    if (
      !refresh &&
      this.statsCache &&
      this.statsCache.baseUrl === config.baseUrl &&
      Date.now() - this.statsCache.at < STATS_TTL_MS
    ) {
      return this.statsCache.value;
    }
    // One read of the whole library at a time, per Stash.
    if (this.statsRun?.baseUrl === config.baseUrl) {
      return this.statsRun.value;
    }
    const token = Symbol('stats');
    const value = (async () => {
      try {
        const stats = computeLibraryStats(
          await this.stash.listLibraryFiles(config),
        );
        this.statsCache = {
          at: Date.now(),
          baseUrl: config.baseUrl,
          value: stats,
        };
        return stats;
      } finally {
        // A read for another Stash may have taken over meanwhile.
        if (this.statsRun?.token === token) {
          this.statsRun = null;
        }
      }
    })();
    this.statsRun = { baseUrl: config.baseUrl, token, value };
    return value;
  }

  // ---------- samples ----------

  /**
   * Sample clips left over from downloads: "sample" as a word in the file or
   * folder name, and when shorterThanMinutes is set, anything shorter.
   */
  async samples(shorterThanMinutes = 0): Promise<SampleSceneDto[]> {
    const config = await this.playback.getStashConfig();
    const limit = shorterThanMinutes * 60;
    const scenes = await this.stash.findSampleScenes(config, limit);
    return scenes.flatMap(({ screenshotVersion, ...scene }) => {
      const named = isSamplePath(scene.file?.path ?? '');
      const short =
        limit > 0 &&
        scene.file?.duration != null &&
        scene.file.duration < limit;
      // Stash matches "sample" anywhere; keep whole words only.
      if (!named && !short) {
        return [];
      }
      return [
        {
          ...scene,
          reason: named ? 'name' : 'short',
          imageUrl: screenshotVersion
            ? stashMediaUrl(
                `scenes/${encodeURIComponent(scene.id)}/screenshot`,
                screenshotVersion,
                480,
              )
            : null,
        },
      ];
    });
  }

  /**
   * `onlyFile`: Duplicates removes one copy, so it refuses a scene with more
   * than one file, whose other files would go too.
   */
  async deleteScene(
    sceneId: string,
    deleteFile: boolean,
    onlyFile = false,
  ): Promise<void> {
    const config = await this.playback.getStashConfig();
    if (deleteFile && onlyFile) {
      const scene = await this.stash.getOrganizerScene(config, sceneId);
      const count = scene?.files.length ?? 0;
      if (count > 1) {
        throw new BadRequestException(
          `This scene has ${count} files, and deleting it from disk would delete all of them. Remove it from Stash only, or delete the extra file in Stash.`,
        );
      }
    }
    const paths = deleteFile
      ? ((
          await this.stash
            .getOrganizerScene(config, sceneId)
            .catch((error: unknown) => {
              this.logger.debug(
                `Couldn't read the files of Stash scene ${sceneId} before deleting it: ${error instanceof Error ? error.message : String(error)}`,
              );
              return null;
            })
        )?.files.map((file) => file.path) ?? [])
      : [];
    await this.stash.deleteScene(config, sceneId, deleteFile);
    this.logger.log(
      deleteFile
        ? `Deleted Stash scene ${sceneId} and its file${paths[0] ? ` ${paths[0]}` : ''}.`
        : `Removed Stash scene ${sceneId} (file kept).`,
    );
    // Leave the Library list now, not at the next sync.
    await this.prisma?.librarySceneIndex
      .deleteMany({ where: { stashSceneId: sceneId } })
      .catch((error: unknown) =>
        this.logger.debug(
          `Couldn't drop deleted scene ${sceneId} from the library list: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    await this.activity?.record({
      kind: 'delete',
      title: paths[0]
        ? `Deleted ${paths[0].split(/[\\/]/).pop()}`
        : deleteFile
          ? 'Deleted a scene and its file'
          : 'Removed a scene from Stash (file kept)',
      detail: paths.join('\n') || `Stash scene #${sceneId}`,
      count: 1,
    });
    // Whisparr still lists a file it imported until it looks again, and the
    // scene would show as waiting for import.
    if (paths.length > 0) {
      void this.organizer
        ?.forgetDeletedFiles(paths)
        .catch((error: unknown) =>
          this.logger.warn(
            `Couldn't tell Whisparr about deleted files: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
  }

  async searchTags(
    query: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const config = await this.playback.getStashConfig();
    const tags = await this.stash.searchTags(query, config);
    return tags.map((tag) => ({ id: tag.id, name: tag.name }));
  }

  private async scenePage(
    sceneFilter: Record<string, unknown>,
    page: number,
    sort: LocalSceneSort,
    seed: number,
  ): Promise<LocalScenePageDto> {
    const config = await this.playback.getStashConfig();
    const { stashSort, direction } = toStashSort(sort, seed);
    const result = await this.stash.findLocalScenes(config, {
      page,
      perPage: PAGE_SIZE,
      sort: stashSort,
      direction,
      sceneFilter,
    });
    return {
      total: result.total,
      page,
      hasMore: page * PAGE_SIZE < result.total,
      items: result.items.map(toCard),
    };
  }
}

function toStashSort(
  sort: LocalSceneSort,
  seed: number,
): { stashSort: string; direction: 'ASC' | 'DESC' } {
  switch (sort) {
    case 'ADDED':
      return { stashSort: 'created_at', direction: 'DESC' };
    case 'PLAYS':
      return { stashSort: 'play_count', direction: 'DESC' };
    case 'TITLE':
      return { stashSort: 'title', direction: 'ASC' };
    case 'RANDOM':
      return { stashSort: `random_${seed || 1}`, direction: 'ASC' };
    case 'DATE':
    default:
      return { stashSort: 'date', direction: 'DESC' };
  }
}

function seedFrom(value: string): number {
  let hash = 7;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2_147_483_647;
  }
  return hash || 1;
}

export function toCard(scene: StashLocalSceneCard): LocalSceneCardDto {
  const screenshotPath = `scenes/${encodeURIComponent(scene.id)}/screenshot`;
  const screenshot = scene.screenshotVersion
    ? stashMediaUrl(screenshotPath, scene.screenshotVersion)
    : null;
  const progress =
    scene.duration && scene.resumeTime > 0
      ? Math.min(1, scene.resumeTime / scene.duration)
      : null;
  return {
    id: scene.id,
    title: scene.title,
    imageUrl: screenshot,
    cardImageUrl: screenshot
      ? stashMediaUrl(screenshotPath, scene.screenshotVersion, 480)
      : null,
    studioId: scene.studio?.id ?? null,
    studio: scene.studio?.name ?? null,
    studioImageUrl: scene.studio?.imageVersion
      ? stashMediaUrl(
          `studios/${encodeURIComponent(scene.studio.id)}/logo`,
          scene.studio.imageVersion,
        )
      : null,
    releaseDate: scene.date,
    duration: scene.duration,
    playCount: scene.playCount,
    progress,
    type: 'SCENE',
    source: 'STASH',
  };
}

/**
 * How much picture a codec gets from each bit: HEVC needs about 60% of
 * H.264's bit rate for the same picture, AV1 about half.
 */
const CODEC_EFFICIENCY: Record<string, number> = {
  av1: 2,
  hevc: 1.6,
  h265: 1.6,
  vp9: 1.5,
  h264: 1,
  avc: 1,
};

/** Within 5% of the larger counts as the same, whichever is asked first. */
function sameBitRate(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * 0.05;
}

function pixels(scene: StashDuplicateScene): number {
  return (scene.file?.width ?? 0) * (scene.file?.height ?? 0);
}

/** Bit rate as if it were H.264, so an HEVC copy isn't beaten by a bigger H.264 one. */
function effectiveBitRate(scene: StashDuplicateScene): number {
  const codec = (scene.file?.videoCodec ?? '').toLowerCase();
  const factor = CODEC_EFFICIENCY[codec] ?? 0.8;
  return (scene.file?.bitRate ?? 0) * factor;
}

/**
 * The copy to keep: highest resolution, then the most picture for its codec
 * (bit rate weighed by how efficient the codec is), then the longest, then
 * the most played. With why, in plain words.
 */
export function pickKeeperWithReason(group: StashDuplicateScene[]): {
  id: string;
  reason: string;
} {
  const score = (scene: StashDuplicateScene) => [
    pixels(scene),
    effectiveBitRate(scene),
    scene.file?.duration ?? 0,
    scene.playCount,
  ];
  // One pass, keeping the better of each pair, so the pick never depends on
  // the order Stash listed the copies in.
  const better = (left: StashDuplicateScene, right: StashDuplicateScene) => {
    const a = score(left);
    const b = score(right);
    for (let index = 0; index < a.length; index += 1) {
      if (
        index === 1 ? !sameBitRate(a[index], b[index]) : a[index] !== b[index]
      ) {
        return a[index] > b[index] ? left : right;
      }
    }
    // A full tie: the older scene (lower id), the same whichever comes first.
    return left.id.localeCompare(right.id, undefined, { numeric: true }) <= 0
      ? left
      : right;
  };
  const best = group.reduce((kept, scene) => better(kept, scene));
  const rest = group.filter((scene) => scene !== best);
  const next =
    rest.length > 0 ? rest.reduce((kept, scene) => better(kept, scene)) : null;
  return {
    id: best.id,
    reason: next ? keepReason(best, next) : 'The only copy.',
  };
}

/** Highest resolution wins, then picture for the codec, then length, then most played. */
export function pickKeeper(group: StashDuplicateScene[]): string {
  return pickKeeperWithReason(group).id;
}

function keepReason(
  best: StashDuplicateScene,
  next: StashDuplicateScene,
): string {
  if (pixels(best) > pixels(next)) {
    return 'Highest resolution.';
  }
  const bestCodec = (best.file?.videoCodec ?? '').toLowerCase();
  const nextCodec = (next.file?.videoCodec ?? '').toLowerCase();
  if (
    !sameBitRate(effectiveBitRate(best), effectiveBitRate(next)) &&
    effectiveBitRate(best) > effectiveBitRate(next)
  ) {
    return (CODEC_EFFICIENCY[bestCodec] ?? 0) >
      (CODEC_EFFICIENCY[nextCodec] ?? 0)
      ? `Same resolution, and ${bestCodec.toUpperCase()} keeps more picture than ${nextCodec.toUpperCase() || 'the other'}.`
      : 'Same resolution, more picture (higher bit rate).';
  }
  if ((best.file?.duration ?? 0) > (next.file?.duration ?? 0)) {
    return 'Same quality, and the longest.';
  }
  if (best.playCount > next.playCount) {
    return 'Same quality, and the one you’ve played.';
  }
  return 'All copies look the same; this one is first.';
}

/** Each library task as the activity log names it. */
const JOB_NAMES: Record<StashLibraryTask, string> = {
  scan: 'library scan',
  generate: 'Generate (previews, sprites, covers)',
  identify: 'Identify on the whole library',
  'auto-tag': 'Auto Tag',
  clean: 'Clean (removes scenes whose files are gone)',
};
