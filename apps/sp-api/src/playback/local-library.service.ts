import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import {
  groupSimilarTags,
  nameKey,
  type SimilarTagGroup,
  cannotBeOne,
  groupMergeCandidates,
} from './tag-cleanup.util';
import type {
  StashBackgroundProblemKind,
  StashProblemKind,
  StashCheckScene,
} from '../providers/stash/stash.types';
import {
  computeLibraryStats,
  type LibraryStatsDto,
} from './library-stats.util';
import {
  BadRequestException,
  ConflictException,
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
import {
  LocalSceneCardDto,
  ChapterDto,
  MergeCandidatesDto,
  LocalScenePageDto,
  LocalPerformerDto,
  SampleSceneDto,
  PROBLEM_KINDS,
  BACKGROUND_KINDS,
  BACKGROUND_LABEL,
  MARKER_CHECK_TTL_MS,
  ProblemListDto,
  DuplicateGroupDto,
  FixCountsDto,
  FIX_FILTERS,
  DUPLICATE_DISTANCE,
  NAMED_SAMPLE_MAX_SECONDS,
  LocalSearchDto,
  LocalStudioDto,
  LocalBulkResultDto,
  STATS_TTL_MS,
} from './local-library.types';
import {
  toStashSort,
  seedFrom,
  rankRelated,
  duplicateKey,
  toCard,
  pickKeeperWithReason,
  JOB_NAMES,
  BackgroundFound,
  sizeText,
  CollectionNarrowing,
  narrowingFilter,
} from './local-library.util';

// Moved out; still exported from here for the code that imports them.
export * from './local-library.types';
export * from './local-library.util';

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

  /**
   * One change on many scenes: a studio set, performers and tags added or
   * taken off. Adding and taking off go to Stash as two bulk edits, as
   * Stash takes one way per list at a time.
   */
  async bulkEditScenes(edit: {
    sceneIds: string[];
    studioId?: string;
    addPerformerIds?: string[];
    removePerformerIds?: string[];
    addTagIds?: string[];
    removeTagIds?: string[];
  }): Promise<{ edited: number }> {
    const ids = [
      ...new Set(edit.sceneIds.map((id) => id.trim()).filter(Boolean)),
    ];
    const list = (values?: string[]) => [
      ...new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
    ];
    const addPerformers = list(edit.addPerformerIds);
    const removePerformers = list(edit.removePerformerIds);
    const addTags = list(edit.addTagIds);
    const removeTags = list(edit.removeTagIds);
    const studioId = edit.studioId?.trim() || undefined;
    if (
      !studioId &&
      addPerformers.length +
        removePerformers.length +
        addTags.length +
        removeTags.length ===
        0
    ) {
      throw new BadRequestException('Pick a change to make to these scenes.');
    }
    if (ids.length === 0) {
      throw new BadRequestException('Pick the scenes to change.');
    }
    const config = await this.playback.getStashConfig();
    if (studioId || addPerformers.length || addTags.length) {
      await this.stash.bulkUpdateLocalScenes(config, ids, {
        studioId,
        performers: { ids: addPerformers, mode: 'ADD' },
        tags: { ids: addTags, mode: 'ADD' },
      });
    }
    if (removePerformers.length || removeTags.length) {
      await this.stash.bulkUpdateLocalScenes(config, ids, {
        performers: { ids: removePerformers, mode: 'REMOVE' },
        tags: { ids: removeTags, mode: 'REMOVE' },
      });
    }
    this.logger.log(`Bulk edit in Stash: ${ids.length} scene(s) changed.`);
    return { edited: ids.length };
  }

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  async updateScene(
    sceneId: string,
    update: StashLocalSceneUpdate,
  ): Promise<LocalSceneDetailsDto> {
    if (update.title !== undefined && !update.title.trim()) {
      throw new BadRequestException('A scene needs a title.');
    }
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

    return rankRelated(scene.id, [
      { items: byPerformers, weight: 3 },
      { items: byStudio, weight: 2 },
      { items: byTags, weight: 1 },
    ])
      .slice(0, RELATED_LIMIT)
      .map(toCard);
  }

  /** Chapters across the library, for chapter playlists. */
  async chapters(options: {
    tagId?: string | null;
    performerId?: string | null;
    query?: string | null;
  }): Promise<ChapterDto[]> {
    const config = await this.playback.getStashConfig();
    // Only plain strings reach Stash, whatever the request held.
    const id = (value: unknown) =>
      typeof value === 'string' && /^\d{1,12}$/.test(value.trim())
        ? value.trim()
        : null;
    const words =
      typeof options.query === 'string' ? options.query.slice(0, 100) : null;
    const chapters = await this.stash.findChapters(config, {
      tagId: id(options.tagId),
      performerId: id(options.performerId),
      query: words,
      limit: 500,
    });
    return chapters.map((chapter) => {
      const scene = encodeURIComponent(chapter.sceneId);
      const marker = encodeURIComponent(chapter.id);
      return {
        ...chapter,
        imageUrl: `/api/media/stash/scenes/${scene}/markers/${marker}/screenshot`,
        previewUrl: `/api/playback/scenes/${scene}/markers/${marker}/preview`,
      };
    });
  }

  async chapterTags(): Promise<
    Array<{ id: string; name: string; count: number }>
  > {
    const config = await this.playback.getStashConfig();
    return this.stash.listChapterTags(config);
  }

  /** What you've played, latest first. */
  async history(page: number): Promise<LocalScenePageDto> {
    const config = await this.playback.getStashConfig();
    const current = Math.max(1, Math.floor(page) || 1);
    const perPage = 40;
    const result = await this.stash.findLocalScenes(config, {
      page: current,
      perPage,
      sort: 'last_played_at',
      direction: 'DESC',
      sceneFilter: { play_count: { value: 0, modifier: 'GREATER_THAN' } },
    });
    return {
      total: result.total,
      page: current,
      hasMore: current * perPage < result.total,
      items: result.items.map(toCard),
    };
  }

  /** Cards for these scenes, in the order given; ones gone from Stash are left out. */
  async cardsFor(ids: string[]): Promise<LocalSceneCardDto[]> {
    if (ids.length === 0) {
      return [];
    }
    const config = await this.playback.getStashConfig();
    const found = new Map<string, StashLocalSceneCard>();
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = ids.slice(start, start + 100);
      const result = await this.stash.findLocalScenes(config, {
        page: 1,
        perPage: 100,
        sort: 'id',
        direction: 'ASC',
        sceneFilter: {},
        ids: chunk,
        // A malformed answer mustn't read as "all gone" (Watch later deletes those).
        strict: true,
      });
      result.items.forEach((item) => found.set(item.id, item));
    }
    return ids.flatMap((id) => {
      const item = found.get(id);
      return item ? [toCard(item)] : [];
    });
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
    narrow: CollectionNarrowing = {},
  ) {
    return this.scenePage(
      {
        performers: { value: [performerId], modifier: 'INCLUDES_ALL' },
        ...narrowingFilter(narrow),
      },
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
    narrow: CollectionNarrowing = {},
  ) {
    // depth -1 includes scenes from the studio's sub-studios.
    return this.scenePage(
      {
        studios: { value: [studioId], modifier: 'INCLUDES', depth: -1 },
        ...narrowingFilter({ tagIds: narrow.tagIds }),
      },
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
    // You asked: it goes in Stash's queue now.
    const jobId = await this.stash.startLibraryTask(
      config,
      'identify',
      sceneIds,
      { now: true },
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

  /**
   * One of Stash's library tasks. From Stash jobs it goes in Stash's queue
   * now; from a schedule (`now` false) it waits until Stash's queue has room.
   */
  async startJob(
    task: StashLibraryTask,
    options: { now?: boolean } = { now: true },
  ): Promise<{ jobId: string | null }> {
    const config = await this.playback.getStashConfig();
    const jobId = await this.stash.startLibraryTask(config, task, undefined, {
      now: options.now ?? true,
    });
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

  /**
   * Generate for just these scenes, made again from scratch: Stash otherwise
   * skips whatever it thinks it already has, which is how they stay broken.
   * Covers come from a plain Generate, only where missing, so a picked one
   * stays. A scene whose file lacks the hash Stash names generated files by
   * is left out of the made-again job: Stash would write every such scene's
   * preview to the same blank name. Then a rescan that makes hover
   * previews, for Stash builds whose Generate doesn't. Says so, and why,
   * when anything was left out or couldn't be asked for.
   */
  async generateFor(
    sceneIds: string[],
  ): Promise<{ jobId: string | null; warning?: string }> {
    // An empty list would make Stash generate for the whole library.
    if (sceneIds.length === 0) {
      throw new BadRequestException('Pick at least one scene.');
    }
    const config = await this.playback.getStashConfig();
    const { named, unknown } = await this.withNamingHash(config, sceneIds);
    const notes: string[] = [];
    let jobId: string | null = null;
    if (named.length > 0) {
      jobId = await this.stash.startLibraryTask(config, 'generate', named, {
        now: true,
        overwrite: true,
      });
    }
    const left = sceneIds.length - named.length - unknown;
    if (unknown > 0) {
      notes.push(
        `${unknown} scene${unknown === 1 ? '' : 's'} couldn’t be made again: Stash didn’t say which hash it names generated files by, or what ${unknown === 1 ? 'this file has' : 'these files have'}. Try again in a moment.`,
      );
    }
    if (left > 0) {
      notes.push(
        `${left} scene${left === 1 ? '' : 's'} couldn’t be made again: ${left === 1 ? 'its file has' : 'their files have'} no hash for Stash to name generated files by yet. Scan ${left === 1 ? 'it' : 'them'} again in Stash first.`,
      );
    }
    try {
      const plain = await this.stash.startLibraryTask(
        config,
        'generate',
        sceneIds,
        { now: true },
      );
      jobId ??= plain;
    } catch (error) {
      // Nothing started at all: say so as an error.
      if (named.length === 0) {
        throw error;
      }
      const why = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Couldn't start Generate for missing covers: ${why}`);
      notes.push(`Missing covers weren’t asked for (${why}); try again.`);
    }
    if (named.length > 0) {
      // Some Stash builds' Generate makes no hover previews at all (Stash
      // issue #7341), though a scan that makes them still works. It only
      // makes the ones still missing, after the jobs above. It waits for a
      // quiet moment in Stash's queue, which can take a minute or more, so
      // it's asked for behind the answer rather than before it.
      void this.stash
        .rescanForPreviews(config, named)
        .catch((error: unknown) => {
          const why = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Couldn't rescan for hover previews: ${why}`);
        });
    }
    this.logger.log(
      `Started Stash’s Generate for ${sceneIds.length} scene${sceneIds.length === 1 ? '' : 's'}, ${named.length} made again${jobId ? ` (job ${jobId})` : ''}.`,
    );
    return notes.length > 0 ? { jobId, warning: notes.join(' ') } : { jobId };
  }

  /**
   * The scenes whose main file has the hash Stash names generated files by,
   * and how many couldn't be checked (the setting or the scene couldn't be
   * read). Those aren't made again either: better nothing than previews
   * written under a blank name.
   */
  private async withNamingHash(
    config: Awaited<ReturnType<PlaybackService['getStashConfig']>>,
    sceneIds: string[],
  ): Promise<{ named: string[]; unknown: number }> {
    const naming = await this.stash
      .generatedFileNaming(config)
      .catch(() => null);
    if (!naming) {
      return { named: [], unknown: sceneIds.length };
    }
    const want = naming === 'MD5' ? 'md5' : 'oshash';
    const scenes = await Promise.all(
      sceneIds.map((id) =>
        this.stash.getOrganizerScene(config, id).catch(() => undefined),
      ),
    );
    return {
      named: sceneIds.filter((_, index) =>
        (scenes[index]?.files[0]?.fingerprints ?? []).some(
          (print) => print.type === want && !!print.value,
        ),
      ),
      // A scene Stash didn't answer for or didn't find, not one it says
      // has no hash.
      unknown: scenes.filter((scene) => !scene).length,
    };
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

  // ---------- merge performers and studios ----------

  /**
   * Performers or studios entered more than once (the same name or alias,
   * ignoring case, accents, spacing and punctuation), and, with `query`,
   * those whose name or an alias has those words, for picking by hand.
   */
  async mergeCandidates(
    kind: 'performer' | 'studio',
    query?: string,
  ): Promise<MergeCandidatesDto> {
    const config = await this.playback.getStashConfig();
    const all = await this.stash.listForMerge(config, kind);
    const groups = groupMergeCandidates(all);
    const words = nameKey(typeof query === 'string' ? query.slice(0, 100) : '');
    const matches = words
      ? all
          .filter((item) =>
            [item.name, ...item.aliases].some((name) =>
              nameKey(name).includes(words),
            ),
          )
          .sort((a, b) => b.sceneCount - a.sceneCount)
          .slice(0, 30)
      : [];
    return { groups, matches };
  }

  /** Merges performers or studios into the one kept, after you pick them. */
  async merge(
    kind: 'performer' | 'studio',
    keepId: string,
    mergeIds: string[],
  ): Promise<void> {
    const sources = [...new Set(mergeIds)].filter((id) => id !== keepId);
    if (sources.length === 0) {
      throw new BadRequestException(
        `Pick at least one other ${kind} to merge.`,
      );
    }
    const config = await this.playback.getStashConfig();
    const all = new Map(
      (await this.stash.listForMerge(config, kind)).map((item) => [
        item.id,
        item,
      ]),
    );
    const keep = all.get(keepId);
    if (!keep || sources.some((id) => !all.has(id))) {
      throw new BadRequestException(
        `One of those ${kind}s is gone from Stash. Look again.`,
      );
    }
    // Every pair, not just each against the one kept: two sources linked to
    // different entries both fit a keeper with no links.
    const picked = [keep, ...sources.map((id) => all.get(id)!)];
    const apart = picked.filter(
      (item, i) =>
        i > 0 && picked.some((other, j) => j !== i && cannotBeOne(other, item)),
    );
    if (apart.length > 0) {
      throw new BadRequestException(
        `${apart.map((item) => item.name).join(', ')} ${apart.length === 1 ? 'is' : 'are'} linked to a different catalog entry, or told apart in Stash, so ${apart.length === 1 ? 'isn’t' : 'aren’t'} the same as the others picked.`,
      );
    }
    if (kind === 'performer') {
      await this.stash.mergePerformers(config, keepId, sources);
    } else {
      try {
        await this.stash.mergeStudios(config, keepId, sources);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Merging studios into ${keep.name} stopped: ${message}`,
        );
        await this.activity?.record({
          kind: 'scan',
          title: `Merging studios into ${keep.name} didn’t finish`,
          detail: message,
          status: 'failed',
        });
        throw new ConflictException(message);
      }
    }
    const names = sources.map((id) => all.get(id)!.name);
    this.logger.log(`Merged ${kind}s ${names.join(', ')} into ${keep.name}.`);
    await this.activity?.record({
      kind: 'scan',
      title: `Merged ${names.length} ${kind}${names.length === 1 ? '' : 's'} into ${keep.name}.`,
      detail: `${names.join(', ')}: their scenes are now ${keep.name}'s, and their names are aliases.`,
    });
  }

  // ---------- broken files ----------

  /** Each kind of problem: how many scenes, and the first 50. Null when Stash couldn't say. */
  async problems(refresh = false): Promise<ProblemListDto[]> {
    const [lists, skips] = await Promise.all([
      this.problemLists(refresh),
      this.problemSkips(),
    ]);
    return lists.map((list) => withoutSkipped(list, skips.get(list.kind)));
  }

  /** The scenes skipped on each list, by kind. */
  private async problemSkips(): Promise<Map<string, Set<string>>> {
    const rows =
      (await this.prisma?.brokenFileSkip
        .findMany({ select: { kind: true, sceneId: true } })
        .catch((error: unknown) => {
          this.logger.warn(
            `Broken files: couldn't read skipped scenes: ${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        })) ?? [];
    const skips = new Map<string, Set<string>>();
    for (const row of rows) {
      skips.set(row.kind, (skips.get(row.kind) ?? new Set()).add(row.sceneId));
    }
    return skips;
  }

  /** Leaves a scene off one list (a damaged file you keep anyway, say). */
  async skipProblem(kind: StashProblemKind, sceneId: string): Promise<void> {
    if (!this.prisma) {
      throw new BadRequestException('Skipping needs the database.');
    }
    await this.prisma.brokenFileSkip.upsert({
      where: { kind_sceneId: { kind, sceneId } },
      create: { kind, sceneId },
      update: {},
    });
  }

  /** Shows every skipped scene again. */
  async clearProblemSkips(): Promise<void> {
    await this.prisma?.brokenFileSkip.deleteMany({});
  }

  private async problemLists(refresh: boolean): Promise<ProblemListDto[]> {
    const config = await this.playback.getStashConfig();
    const lists = await Promise.all(
      PROBLEM_KINDS.map(async (kind): Promise<ProblemListDto> => {
        try {
          const found = await this.stash.findProblemScenes(config, kind);
          return { kind, count: found.count, scenes: found.scenes };
        } catch (error) {
          this.logger.warn(
            `Broken files: couldn't ask Stash for "${kind}": ${error instanceof Error ? error.message : String(error)}`,
          );
          return { kind, count: null, scenes: [] };
        }
      }),
    );
    // These ask Stash about every file, so they can take minutes: they run
    // in the background and the page asks again until they're done.
    return [
      ...lists,
      ...BACKGROUND_KINDS.map((kind) =>
        this.backgroundList(kind, config, refresh),
      ),
    ];
  }

  /** Background checks under way, by kind: the Stash each is for. */
  private readonly backgroundRuns = new Map<
    StashBackgroundProblemKind,
    string
  >();

  private readonly backgroundResults = new Map<
    StashBackgroundProblemKind,
    { at: number; baseUrl: string; value: ProblemListDto }
  >();

  /** A background kind: the last result, or "checking" while a check runs. */
  private backgroundList(
    kind: StashBackgroundProblemKind,
    config: { baseUrl: string; apiKey?: string | null },
    refresh: boolean,
  ): ProblemListDto {
    const result = this.backgroundResults.get(kind);
    const kept = result?.baseUrl === config.baseUrl ? result : null;
    const running = this.backgroundRuns.get(kind) === config.baseUrl;
    const fresh = kept && Date.now() - kept.at < MARKER_CHECK_TTL_MS;
    if (!running && (refresh || !fresh)) {
      this.backgroundRuns.set(kind, config.baseUrl);
      void this.runBackgroundCheck(kind, config).finally(() => {
        if (this.backgroundRuns.get(kind) === config.baseUrl) {
          this.backgroundRuns.delete(kind);
        }
      });
    }
    const checking = this.backgroundRuns.get(kind) === config.baseUrl;
    if (kept && !(checking && refresh)) {
      return { ...kept.value, checking };
    }
    return { kind, count: null, scenes: [], checking };
  }

  private async runBackgroundCheck(
    kind: StashBackgroundProblemKind,
    config: { baseUrl: string; apiKey?: string | null },
  ): Promise<void> {
    const label = BACKGROUND_LABEL[kind];
    const started = Date.now();
    this.logger.log(`Broken files: checking ${label.what} in Stash…`);
    try {
      const found: BackgroundFound =
        kind === 'generate'
          ? await this.stash.findGenerateGaps(
              config,
              await this.checkRows(config),
            )
          : await this.checkFilesOnDisk(config);
      // Unanswered checks aren't an all-clear: with nothing found missing,
      // the count is unknown rather than 0.
      const value: ProblemListDto = {
        kind,
        count:
          found.note || (found.missing === 0 && found.unanswered > 0)
            ? null
            : found.missing,
        scenes: found.note ? [] : found.scenes.slice(0, 50),
        ...(found.note ? { note: found.note } : {}),
        ...(found.unanswered > 0 && !found.note
          ? {
              unanswered: found.unanswered,
              ...(found.unansweredWhy
                ? { unansweredWhy: found.unansweredWhy }
                : {}),
              note: `${kind === 'generate' ? 'Stash' : 'The disk'} didn’t answer for ${found.unanswered} ${found.unanswered === 1 ? 'file' : 'files'} across ${found.checked} scenes${found.unansweredWhy ? ` (${found.unansweredWhy})` : ''}, so they couldn’t be checked.`,
            }
          : {}),
      };
      this.backgroundResults.set(kind, {
        at: Date.now(),
        baseUrl: config.baseUrl,
        value,
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      const unanswered =
        found.unanswered > 0
          ? `; Stash didn't answer for ${found.unanswered}${found.unansweredWhy ? ` (mostly: ${found.unansweredWhy}${found.unansweredExample ? `, e.g. ${found.unansweredExample}` : ''})` : ''}`
          : '';
      const line = found.note
        ? `Broken files: couldn't check ${label.what}: ${found.note}`
        : `Broken files: ${found.missing} of ${found.checked} ${label.unit} ${label.lacking}${unanswered} (checked in ${seconds}s).`;
      if (found.unanswered > 0 || found.note) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Broken files: the check for ${label.what} failed: ${message}`,
      );
      this.backgroundResults.set(kind, {
        at: Date.now(),
        baseUrl: config.baseUrl,
        value: {
          kind,
          count: null,
          scenes: [],
          note: `The check failed: ${message.slice(0, 200)}`,
        },
      });
    }
  }

  /** The scene list both background checks read, while one is being read. */
  private checkRowsRun: {
    baseUrl: string;
    value: Promise<StashCheckScene[]>;
  } | null = null;

  /**
   * The library's scenes for the file-by-file checks. Both checks start
   * together, so they share one read of the list rather than each asking
   * Stash for every scene; the next run reads it afresh.
   */
  private checkRows(config: {
    baseUrl: string;
    apiKey?: string | null;
  }): Promise<StashCheckScene[]> {
    if (this.checkRowsRun?.baseUrl !== config.baseUrl) {
      const value = this.stash.listScenesForChecks(config);
      const run = { baseUrl: config.baseUrl, value };
      this.checkRowsRun = run;
      void value
        .catch(() => undefined)
        .finally(() => {
          if (this.checkRowsRun === run) {
            this.checkRowsRun = null;
          }
        });
    }
    return this.checkRowsRun.value;
  }

  /** Swapped in tests. */
  statFile: (path: string) => Promise<{ size: number; mtimeMs: number }> = (
    path,
  ) => fs.stat(path);

  /**
   * Each scene's files on disk against what Stash scanned: gone, unreadable,
   * or a different size. A size change with the same date is what disk
   * damage or a cut-off copy looks like; with a new date, the file was
   * simply changed and needs scanning again. Needs Stashboard to see the
   * media at the same paths as Stash.
   */
  private async checkFilesOnDisk(config: {
    baseUrl: string;
    apiKey?: string | null;
  }): Promise<BackgroundFound> {
    const rows = await this.checkRows(config);
    const files = rows.flatMap((row, scene) =>
      row.files.map((file) => ({ scene, file })),
    );
    type Seen =
      | { kind: 'ok' }
      | { kind: 'gone' | 'denied' | 'io' }
      | { kind: 'stat'; size: number; mtimeMs: number }
      | { kind: 'unknown'; why: string };
    const seen: Seen[] = new Array<Seen>(files.length);
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const index = next++;
        try {
          const stat = await this.statFile(files[index].file.path);
          seen[index] = {
            kind: 'stat',
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          seen[index] =
            code === 'ENOENT' || code === 'ENOTDIR'
              ? { kind: 'gone' }
              : code === 'EACCES' || code === 'EPERM'
                ? { kind: 'denied' }
                : code === 'EIO'
                  ? { kind: 'io' }
                  : { kind: 'unknown', why: code || 'error' };
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    const gone = seen.filter((entry) => entry.kind === 'gone').length;
    if (files.length > 0 && gone === files.length) {
      return {
        missing: 0,
        checked: rows.length,
        unanswered: 0,
        note: 'Stashboard can’t see any of your media. Mount the same media folder into Stashboard as Stash uses, at the same path (for example /data), so it can check the files.',
        scenes: [],
      };
    }
    const why = new Map<string, number>();
    const problems = rows.map(
      () => [] as Array<{ line: string; weight: number }>,
    );
    files.forEach(({ scene, file }, index) => {
      const entry = seen[index];
      const name =
        rows[scene].files.length > 1 ? `${basename(file.path)}: ` : '';
      const add = (line: string, weight: number) =>
        problems[scene].push({ line: name + line, weight });
      if (entry.kind === 'gone') {
        add(
          'The file isn’t there. Stash still lists it, so it was moved or deleted outside Stash. Scan again to find it, or remove the scene.',
          2,
        );
      } else if (entry.kind === 'denied') {
        add(
          'Stashboard isn’t allowed to read it. Check the file’s owner and permissions (PUID/PGID).',
          1,
        );
      } else if (entry.kind === 'io') {
        add(
          'The disk couldn’t read it (an I/O error): a sign the disk or the file is damaged.',
          3,
        );
      } else if (entry.kind === 'unknown') {
        why.set(entry.why, (why.get(entry.why) ?? 0) + 1);
      } else if (entry.kind === 'stat' && file.size !== null) {
        if (entry.size !== file.size) {
          const changedDate =
            file.modTime !== null &&
            Math.abs(entry.mtimeMs - Date.parse(file.modTime)) > 2000;
          const diff = `${sizeText(Math.abs(entry.size - file.size))} ${entry.size < file.size ? 'smaller' : 'bigger'}`;
          if (entry.size === 0) {
            add(
              'The file is empty (0 bytes): its contents are gone. Get it again, or remove the scene.',
              3,
            );
          } else if (changedDate) {
            add(
              `It changed since Stash scanned it (${diff} and a newer date). Scan again so Stash reads it afresh.`,
              1,
            );
          } else {
            add(
              `It’s ${diff} than when Stash scanned it, but its date hasn’t changed: what disk damage or a cut-off copy looks like. Play it to check, and get it again if it’s broken.`,
              3,
            );
          }
        }
      }
    });
    const listed = rows.flatMap((row, index) =>
      problems[index].length > 0 ? [{ row, found: problems[index] }] : [],
    );
    const weightOf = (found: Array<{ weight: number }>) =>
      Math.max(...found.map((entry) => entry.weight));
    listed.sort((a, b) => weightOf(b.found) - weightOf(a.found));
    const unanswered = [...why.values()].reduce((sum, n) => sum + n, 0);
    const unansweredWhy = [...why.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    return {
      missing: listed.length,
      checked: rows.length,
      unanswered,
      ...(unansweredWhy ? { unansweredWhy } : {}),
      scenes: listed.slice(0, 50).map(({ row, found }) => ({
        id: row.id,
        title: row.title,
        path: row.files[0]?.path ?? null,
        fileCount: row.files.length,
        problems: found.map((entry) => entry.line),
      })),
    };
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
    const found = await this.stash.findDuplicateScenes(
      config,
      DUPLICATE_DISTANCE[accuracy],
    );
    const ignored = new Set(
      (
        (await this.prisma?.duplicateIgnore
          .findMany({ select: { sceneKey: true } })
          .catch(() => [])) ?? []
      ).map((row) => row.sceneKey),
    );
    const groups = found.filter(
      (group) => !ignored.has(duplicateKey(group.map((scene) => scene.id))),
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

  /** A set you checked and found aren't copies: hidden until its scenes change. */
  async ignoreDuplicates(sceneIds: string[]): Promise<void> {
    const ids = [...new Set(sceneIds)];
    if (ids.length < 2 || !this.prisma) {
      throw new BadRequestException('Pick a set of at least two scenes.');
    }
    const sceneKey = duplicateKey(ids);
    await this.prisma.duplicateIgnore.upsert({
      where: { sceneKey },
      create: { sceneKey },
      update: {},
    });
  }

  /** How many sets are hidden as not duplicates. */
  async ignoredDuplicateCount(): Promise<number> {
    return (await this.prisma?.duplicateIgnore.count().catch(() => 0)) ?? 0;
  }

  /** Shows every hidden set again. */
  async clearIgnoredDuplicates(): Promise<void> {
    await this.prisma?.duplicateIgnore.deleteMany({});
  }

  /** Before a copy is removed: its plays, tags, chapters and more go to the copy kept. */
  async carryDetails(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) {
      throw new BadRequestException('A copy can’t be carried into itself.');
    }
    const config = await this.playback.getStashConfig();
    const carried = await this.stash.carrySceneDetails(config, fromId, toId);
    this.logger.log(
      `Carried Stash scene ${fromId}'s details to ${toId}: ${carried.plays} plays, ${carried.os} Os, ${carried.chapters} chapters.`,
    );
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
      // "sample" in the path counts only for a short file: a real scene in
      // a folder called Samples is still a real scene.
      const named =
        isSamplePath(scene.file?.path ?? '') &&
        (scene.file?.duration == null ||
          scene.file.duration < NAMED_SAMPLE_MAX_SECONDS);
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

  /** Stash's own performers and studios whose names match, most scenes first. */
  async searchPeople(query: string): Promise<{
    performers: Array<{ id: string; name: string }>;
    studios: Array<{ id: string; name: string }>;
  }> {
    const config = await this.playback.getStashConfig();
    const found = await this.stash.searchLocalPeople(config, query);
    return {
      performers: found.performers.map(({ id, name }) => ({ id, name })),
      studios: found.studios.map(({ id, name }) => ({ id, name })),
    };
  }

  /** A performer or studio by this name: Stash's own, or a new one. */
  async createPerson(
    kind: 'performer' | 'studio',
    name: string,
  ): Promise<{ id: string; name: string; created: boolean }> {
    const config = await this.playback.getStashConfig();
    return this.stash.createNamed(config, kind, name);
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
    // Production date only exists from Stash 0.32: older ones sort by release date.
    const usable =
      sort === 'PRODUCED' && !(await this.stash.supportsProductionDate(config))
        ? 'DATE'
        : sort;
    const { stashSort, direction } = toStashSort(usable, seed);
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

/**
 * A list without the scenes you skipped on it. Its count drops by the ones
 * listed; a skipped scene past the first 50 isn't known to be in it.
 */
function withoutSkipped(
  list: ProblemListDto,
  skipped: Set<string> | undefined,
): ProblemListDto {
  const left = skipped
    ? list.scenes.filter((scene) => !skipped.has(scene.id))
    : list.scenes;
  const dropped = list.scenes.length - left.length;
  return {
    ...list,
    scenes: left,
    count: list.count === null ? null : Math.max(0, list.count - dropped),
    ...(skipped?.size ? { skipped: skipped.size } : {}),
  };
}
