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

export interface DuplicateGroupDto {
  scenes: DuplicateSceneDto[];
  /** The copy to keep: highest resolution, then bit rate, then file size. */
  suggestedKeepId: string;
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
  }>;
  studios: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
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
      suggestedKeepId: pickKeeper(group),
    }));
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

  async deleteScene(sceneId: string, deleteFile: boolean): Promise<void> {
    const config = await this.playback.getStashConfig();
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

/** Highest resolution wins, then bit rate, then file size, then most played. */
export function pickKeeper(group: StashDuplicateScene[]): string {
  const score = (scene: StashDuplicateScene) => [
    (scene.file?.width ?? 0) * (scene.file?.height ?? 0),
    scene.file?.bitRate ?? 0,
    scene.file?.size ?? 0,
    scene.playCount,
  ];
  return [...group].sort((left, right) => {
    const a = score(left);
    const b = score(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) {
        return b[index] - a[index];
      }
    }
    return 0;
  })[0].id;
}

/** Each library task as the activity log names it. */
const JOB_NAMES: Record<StashLibraryTask, string> = {
  scan: 'library scan',
  generate: 'Generate (previews, sprites, covers)',
  identify: 'Identify on the whole library',
  'auto-tag': 'Auto Tag',
  clean: 'Clean (removes scenes whose files are gone)',
};
