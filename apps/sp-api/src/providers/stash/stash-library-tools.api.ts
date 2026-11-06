import type { WatchedScene } from '../../suggestions/suggestions.util';
import {
  type CatalogProviderKey,
  findCatalogExternalIdForProvider,
  normalizeCatalogSceneRefs,
} from '../catalog/catalog-provider.util';
import type { StatsFile } from '../../playback/library-stats.util';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { stashImageVersion } from './stash-image-version.util';
import {
  type StashAdapterBaseConfig,
  type StashDuplicateScene,
  type StashGraphqlResponse,
  type StashJob,
  type StashLibraryTask,
  type StashOrganizerScene,
  type StashQuickProblemKind,
  type StashProblemScene,
  type StashTagSummary,
  type StashSceneMatchInput,
} from './stash.types';
import { StashGraphqlClient } from './stash-graphql.client';
import { trimTrailingSeparators } from '../../path-separators';

/**
 * Stash's library tasks (scan, identify, generate, clean, jobs), duplicates,
 * and what the organizer needs: scenes with their files, moving files, and
 * saving matches.
 */
/** A chapter with no end and nothing after it plays this long. */
const DEFAULT_CHAPTER_SECONDS = 60;

export interface StashChapter {
  id: string;
  title: string;
  seconds: number;
  endSeconds: number;
  tagName: string | null;
  sceneId: string;
  sceneTitle: string;
}

/** A performer or studio, for Library tools → Merge. */
export interface StashMergeCandidate {
  id: string;
  name: string;
  aliases: string[];
  sceneCount: number;
  /** A performer's disambiguation, or a studio's parent. */
  note: string | null;
  /** Performers: when they died, when Stash has it. */
  deathDate: string | null;
}

/** The kept one's aliases and links, plus the merged ones' names, aliases and links. */
function mergedValues(
  keep: Record<string, unknown>,
  sources: Array<Record<string, unknown>>,
  aliasField: 'alias_list' | 'aliases',
): {
  aliases: string[];
  stashIds: Array<{ endpoint: string; stash_id: string }>;
} {
  const keepName = (typeof keep['name'] === 'string' ? keep['name'] : '')
    .trim()
    .toLowerCase();
  const aliases = new Map<string, string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      const key = value.trim().toLowerCase();
      if (key !== keepName && !aliases.has(key)) {
        aliases.set(key, value.trim());
      }
    }
  };
  const list = (row: Record<string, unknown>, field: string) =>
    Array.isArray(row[field]) ? (row[field] as unknown[]) : [];
  list(keep, aliasField).forEach(add);
  for (const source of sources) {
    add(source['name']);
    list(source, aliasField).forEach(add);
  }
  const links = new Map<string, { endpoint: string; stash_id: string }>();
  for (const row of [keep, ...sources]) {
    for (const link of list(row, 'stash_ids') as Array<
      Record<string, unknown>
    >) {
      const endpoint = link?.['endpoint'];
      const stashId = link?.['stash_id'];
      if (typeof endpoint === 'string' && typeof stashId === 'string') {
        links.set(`${endpoint} ${stashId}`, { endpoint, stash_id: stashId });
      }
    }
  }
  return { aliases: [...aliases.values()], stashIds: [...links.values()] };
}

export abstract class StashLibraryToolsApi extends StashGraphqlClient {
  /**
   * Jobs Stashboard queued, by what they do. Stash runs one job at a time, so
   * while one still waits its turn, asking again for the same scan or the
   * same scenes' previews gets that job back instead of a copy behind it.
   */
  private readonly queuedJobs = new Map<string, Promise<string | null>>();

  protected async queueOnce(
    config: StashAdapterBaseConfig,
    key: string,
    start: () => Promise<string | null>,
    alsoReuse: string[] = [],
  ): Promise<string | null> {
    const fullKey = `${config.baseUrl}|${key}`;
    const candidates = [
      fullKey,
      ...alsoReuse.map((k) => `${config.baseUrl}|${k}`),
    ];
    const earlier = candidates
      .map((candidate) => this.queuedJobs.get(candidate))
      .filter((job): job is Promise<string | null> => !!job);
    if (earlier.length > 0) {
      const ids = (
        await Promise.all(earlier.map((job) => job.catch(() => null)))
      ).filter((id): id is string => !!id);
      if (ids.length > 0) {
        const queue = await this.getJobQueue(config).catch(() => []);
        const waiting = ids.find((id) =>
          queue.some((job) => job.id === id && job.status === 'READY'),
        );
        if (waiting) {
          return waiting;
        }
      }
    }
    const started = start();
    this.queuedJobs.set(fullKey, started);
    started.catch(() => {
      if (this.queuedJobs.get(fullKey) === started) {
        this.queuedJobs.delete(fullKey);
      }
    });
    return started;
  }

  async getJobQueue(config: StashAdapterBaseConfig): Promise<StashJob[]> {
    const payload = (await this.executeQuery(
      config,
      `query Jobs { jobQueue { id status description progress subTasks addTime startTime } }`,
    )) as unknown as {
      data?: { jobQueue?: Array<Record<string, unknown>> | null };
    };
    return (payload.data?.jobQueue ?? []).flatMap((job) => {
      const id = this.normalizeOptionalString(job.id);
      if (!id) {
        return [];
      }
      return [
        {
          id,
          status: this.normalizeOptionalString(job.status) ?? 'READY',
          description:
            this.normalizeOptionalString(job.description) ?? 'Stash task',
          progress: typeof job.progress === 'number' ? job.progress : null,
          subTasks: Array.isArray(job.subTasks)
            ? job.subTasks.filter(
                (task): task is string => typeof task === 'string',
              )
            : [],
          addTime: this.normalizeOptionalString(job.addTime),
          startTime: this.normalizeOptionalString(job.startTime),
        },
      ];
    });
  }

  /**
   * Waits for a Stash job to finish. Stash drops finished jobs from its queue
   * shortly after, so "gone from the queue" also counts as finished.
   */
  async waitForJob(
    config: StashAdapterBaseConfig,
    jobId: string,
    options: {
      pollMs?: number;
      timeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<'FINISHED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'> {
    const pollMs = options.pollMs ?? 5000;
    const deadline = Date.now() + (options.timeoutMs ?? 3 * 3600_000);
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (Date.now() < deadline) {
      const job = (await this.getJobQueue(config)).find(
        (entry) => entry.id === jobId,
      );
      if (!job || job.status === 'FINISHED') {
        return 'FINISHED';
      }
      if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        return job.status;
      }
      await sleep(pollMs);
    }
    return 'TIMEOUT';
  }

  async stopJob(config: StashAdapterBaseConfig, jobId: string): Promise<void> {
    const id = this.normalizeEntityId(jobId);
    if (!id) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation StopJob($id: ID!) { stopJob(job_id: $id) }`,
      { id },
      false,
    );
  }

  /** Starts one of Stash's library tasks and returns its job id. */
  /**
   * Scans only these folders, without generating covers, previews, sprites or
   * phashes — just enough for Stash to find new files and follow moved ones
   * (it recognizes a moved file by its fingerprint and keeps the scene).
   */
  async scanPaths(
    config: StashAdapterBaseConfig,
    paths: string[],
  ): Promise<string | null> {
    const unique = [
      ...new Set(
        paths.map((path) => trimTrailingSeparators(path)).filter(Boolean),
      ),
    ];
    if (unique.length === 0) {
      return null;
    }
    const payload = (await this.executeQuery(
      config,
      `mutation QuickScan($input: ScanMetadataInput!) { metadataScan(input: $input) }`,
      {
        input: {
          paths: unique,
          scanGenerateCovers: false,
          scanGeneratePreviews: false,
          scanGenerateImagePreviews: false,
          scanGenerateSprites: false,
          scanGeneratePhashes: false,
          scanGenerateThumbnails: false,
          scanGenerateClipPreviews: false,
        },
      },
    )) as unknown as { data?: { metadataScan?: unknown } };
    const job = payload.data?.metadataScan;
    return typeof job === 'string' || typeof job === 'number'
      ? String(job)
      : null;
  }

  /**
   * Scans only these folders, with Stash's own scan settings (covers and the
   * rest as the library's default scan would make them).
   */
  async scanLibraryFolders(
    config: StashAdapterBaseConfig,
    folders: string[],
  ): Promise<string | null> {
    const paths = [
      ...new Set(
        folders.map((path) => trimTrailingSeparators(path)).filter(Boolean),
      ),
    ];
    if (paths.length === 0) {
      return null;
    }
    // A waiting scan of the same folders, or of everything, covers this one.
    return this.queueOnce(
      config,
      `scan:${[...paths].sort().join('\n')}`,
      async () => {
        const payload = (await this.executeQuery(
          config,
          `mutation ScanFolders($input: ScanMetadataInput!) { metadataScan(input: $input) }`,
          { input: { paths } },
          false,
        )) as unknown as { data?: { metadataScan?: unknown } };
        const job = payload.data?.metadataScan;
        return typeof job === 'string' || typeof job === 'number'
          ? String(job)
          : null;
      },
      ['scan:*'],
    );
  }

  async startLibraryTask(
    config: StashAdapterBaseConfig,
    task: StashLibraryTask,
    sceneIds?: string[],
  ): Promise<string | null> {
    const ids = sceneIds
      ?.map((id) => this.normalizeEntityId(id))
      .filter((id): id is string => !!id);
    // Scenes were named but none is a real id: never fall through to the
    // whole library.
    if (sceneIds && ids?.length === 0) {
      throw new BadRequestException('None of those is a scene Stash knows.');
    }
    let mutation: string;
    let variables: Record<string, unknown> = {};
    switch (task) {
      case 'scan':
        mutation = `mutation Scan($input: ScanMetadataInput!) { metadataScan(input: $input) }`;
        variables = { input: {} };
        break;
      case 'generate':
        mutation = `mutation Generate($input: GenerateMetadataInput!) { metadataGenerate(input: $input) }`;
        variables = {
          input: {
            covers: true,
            sprites: true,
            previews: true,
            markers: true,
            markerScreenshots: true,
            phashes: true,
            ...(ids?.length ? { sceneIDs: ids } : {}),
          },
        };
        break;
      case 'identify': {
        const endpoints = await this.getStashBoxEndpoints(config);
        if (endpoints.length === 0) {
          throw new BadGatewayException(
            'Stash has no StashDB-style source set up. Add one in Stash under Settings → Metadata Providers.',
          );
        }
        mutation = `mutation Identify($input: IdentifyMetadataInput!) { metadataIdentify(input: $input) }`;
        variables = {
          input: {
            sources: endpoints.map((endpoint) => ({
              source: { stash_box_endpoint: endpoint },
            })),
            ...(ids?.length ? { sceneIDs: ids } : {}),
          },
        };
        break;
      }
      case 'auto-tag':
        mutation = `mutation AutoTag($input: AutoTagMetadataInput!) { metadataAutoTag(input: $input) }`;
        variables = {
          input: { performers: ['*'], studios: ['*'], tags: ['*'] },
        };
        break;
      case 'clean':
        mutation = `mutation Clean($input: CleanMetadataInput!) { metadataClean(input: $input) }`;
        variables = { input: { dryRun: false } };
        break;
    }
    const scope = ids?.length ? [...ids].sort().join(',') : '*';
    return this.queueOnce(config, `${task}:${scope}`, async () => {
      const payload = (await this.executeQuery(
        config,
        mutation,
        variables,
        false,
      )) as unknown as {
        data?: Record<string, unknown>;
      };
      const value = Object.values(payload.data ?? {})[0];
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
    });
  }

  protected async getStashBoxEndpoints(
    config: StashAdapterBaseConfig,
  ): Promise<string[]> {
    const payload = (await this.executeQuery(
      config,
      `query Boxes { configuration { general { stashBoxes { endpoint } } } }`,
    )) as unknown as {
      data?: {
        configuration?: {
          general?: { stashBoxes?: Array<{ endpoint?: unknown }> };
        };
      };
    };
    return (payload.data?.configuration?.general?.stashBoxes ?? [])
      .map((box) => this.normalizeOptionalString(box.endpoint))
      .filter((endpoint): endpoint is string => !!endpoint);
  }

  /**
   * Groups of scenes that look like the same video (Stash's perceptual hash).
   * distance 0 is identical; higher finds more but looser matches.
   */
  async findDuplicateScenes(
    config: StashAdapterBaseConfig,
    distance: number,
  ): Promise<StashDuplicateScene[][]> {
    const fields = DUPLICATE_SCENE_FIELDS;
    const run = (withDuration: boolean) =>
      this.executeQuery(
        config,
        withDuration
          ? `query Dupes($distance: Int, $diff: Float) { findDuplicateScenes(distance: $distance, duration_diff: $diff) { ${fields} } }`
          : `query Dupes($distance: Int) { findDuplicateScenes(distance: $distance) { ${fields} } }`,
        withDuration ? { distance, diff: 2 } : { distance },
      );
    let payload: StashGraphqlResponse;
    try {
      payload = await run(true);
    } catch (error) {
      if (
        !/duration_diff|Unknown argument|unknown argument/i.test(
          this.errorMessage(error),
        )
      ) {
        throw error;
      }
      payload = await run(false);
    }
    const groups = ((
      payload as unknown as { data?: { findDuplicateScenes?: unknown } }
    ).data?.findDuplicateScenes ?? []) as Array<Array<Record<string, unknown>>>;
    return groups
      .map((group) =>
        (Array.isArray(group) ? group : []).flatMap((scene) => {
          const parsed = this.toDuplicateScene(scene);
          return parsed ? [parsed] : [];
        }),
      )
      .filter((group) => group.length > 1);
  }

  /**
   * Which of these files Stash already has. Up to 100 are asked about; any
   * past that, or that Stash can't answer for, count as not known.
   */
  async knownFilePaths(
    config: StashAdapterBaseConfig,
    paths: string[],
  ): Promise<Set<string>> {
    const known = new Set<string>();
    for (const filePath of paths.slice(0, 100)) {
      try {
        const payload = (await this.executeQuery(
          config,
          `query ByPath($scene_filter: SceneFilterType) { findScenes(scene_filter: $scene_filter, filter: { per_page: 1 }) { count } }`,
          { scene_filter: { path: { value: filePath, modifier: 'EQUALS' } } },
        )) as unknown as { data?: { findScenes?: { count?: unknown } } };
        if (Number(payload.data?.findScenes?.count) > 0) {
          known.add(filePath);
        }
      } catch {
        // Unknown: scanning it again does no harm.
      }
    }
    return known;
  }

  /** The scenes Stash has for these exact file paths. */
  async sceneIdsForPaths(
    config: StashAdapterBaseConfig,
    paths: string[],
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const filePath of paths.slice(0, 100)) {
      try {
        const payload = (await this.executeQuery(
          config,
          `query ScenesByPath($scene_filter: SceneFilterType) { findScenes(scene_filter: $scene_filter, filter: { per_page: 5 }) { scenes { id } } }`,
          { scene_filter: { path: { value: filePath, modifier: 'EQUALS' } } },
        )) as unknown as {
          data?: { findScenes?: { scenes?: Array<{ id?: unknown }> } };
        };
        for (const scene of payload.data?.findScenes?.scenes ?? []) {
          const id =
            typeof scene.id === 'string' || typeof scene.id === 'number'
              ? this.normalizeEntityId(String(scene.id))
              : null;
          if (id) {
            ids.add(id);
          }
        }
      } catch {
        // Not found this time; the created-since lookup may still have it.
      }
    }
    return [...ids];
  }

  /**
   * Sample files: a name or folder with the word "sample" in it, and when
   * shorterThan is set, any video shorter than that many seconds.
   */
  async findSampleScenes(
    config: StashAdapterBaseConfig,
    shorterThan: number,
  ): Promise<StashDuplicateScene[]> {
    const byName = { path: { value: 'sample', modifier: 'INCLUDES' } };
    const sceneFilter =
      shorterThan > 0
        ? {
            ...byName,
            OR: { duration: { value: shorterThan, modifier: 'LESS_THAN' } },
          }
        : byName;
    const found: StashDuplicateScene[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const payload = (await this.executeQuery(
        config,
        `query Samples($filter: FindFilterType, $scene_filter: SceneFilterType) {
          findScenes(filter: $filter, scene_filter: $scene_filter) {
            count
            scenes { ${DUPLICATE_SCENE_FIELDS} }
          }
        }`,
        {
          filter: { page, per_page: 100, sort: 'path', direction: 'ASC' },
          scene_filter: sceneFilter,
        },
      )) as unknown as {
        data?: { findScenes?: { count?: unknown; scenes?: unknown[] } };
      };
      const scenes = payload.data?.findScenes?.scenes ?? [];
      for (const scene of scenes) {
        const parsed = this.toDuplicateScene(scene as Record<string, unknown>);
        if (parsed) {
          found.push(parsed);
        }
      }
      if (scenes.length < 100) {
        break;
      }
    }
    return found;
  }

  private toDuplicateScene(
    scene: Record<string, unknown>,
  ): StashDuplicateScene | null {
    const num = (value: unknown) =>
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value) || null
          : null;
    const id = this.normalizeOptionalString(scene.id);
    if (!id) {
      return null;
    }
    const file = (Array.isArray(scene.files) ? scene.files[0] : null) as Record<
      string,
      unknown
    > | null;
    const paths = scene.paths as Record<string, unknown> | null | undefined;
    const studio = scene.studio as Record<string, unknown> | null | undefined;
    return {
      id,
      title: this.normalizeOptionalString(scene.title) ?? `Scene #${id}`,
      date: this.normalizeOptionalString(scene.date),
      screenshotVersion: stashImageVersion(paths?.screenshot),
      studio: this.normalizeOptionalString(studio?.name),
      playCount: typeof scene.play_count === 'number' ? scene.play_count : 0,
      organized: scene.organized === true,
      fileCount: Array.isArray(scene.files) ? scene.files.length : 0,
      file: file
        ? {
            path: this.normalizeOptionalString(file.path),
            basename: this.normalizeOptionalString(file.basename),
            size: num(file.size),
            width: num(file.width),
            height: num(file.height),
            duration: num(file.duration),
            videoCodec: this.normalizeOptionalString(file.video_codec),
            bitRate: num(file.bit_rate),
            frameRate: num(file.frame_rate),
          }
        : null,
    };
  }

  /** Removes a scene from Stash, and its file from disk when asked. */
  async deleteScene(
    config: StashAdapterBaseConfig,
    sceneId: string,
    deleteFile: boolean,
  ): Promise<void> {
    const id = this.normalizeEntityId(sceneId);
    if (!id) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation DeleteScene($input: SceneDestroyInput!) { sceneDestroy(input: $input) }`,
      { input: { id, delete_file: deleteFile, delete_generated: true } },
      false,
    );
  }

  /**
   * Deletes one file of a scene from disk, keeping the scene: another of its
   * files becomes the main one first, so the scene never loses its video.
   */
  async removeExtraFile(
    config: StashAdapterBaseConfig,
    sceneId: string,
    keepFileId: string,
    removeFileId: string,
  ): Promise<void> {
    const scene = this.normalizeEntityId(sceneId);
    const keep = this.normalizeEntityId(keepFileId);
    const remove = this.normalizeEntityId(removeFileId);
    if (!scene || !keep || !remove || keep === remove) {
      throw new BadGatewayException('Missing the scene or its files.');
    }
    await this.executeQuery(
      config,
      `mutation KeepFile($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
      { input: { id: scene, primary_file_id: keep } },
      false,
    );
    const payload = (await this.executeQuery(
      config,
      `mutation RemoveFile($ids: [ID!]!) { deleteFiles(ids: $ids) }`,
      { ids: [remove] },
      false,
    )) as unknown as { data?: { deleteFiles?: unknown } };
    if (payload.data?.deleteFiles === false) {
      throw new BadGatewayException('Stash could not delete the file.');
    }
  }

  /**
   * Merges these scenes into another: their files, plays and markers move
   * to it, and its own details (title, performers and the rest) are kept.
   */
  async mergeScenes(
    config: StashAdapterBaseConfig,
    sourceIds: string[],
    destinationId: string,
  ): Promise<void> {
    const destination = this.normalizeEntityId(destinationId);
    const sources = sourceIds
      .map((id) => this.normalizeEntityId(id))
      .filter((id): id is string => !!id && id !== destination);
    if (!destination || sources.length === 0) {
      throw new BadGatewayException('Missing the scenes to merge.');
    }
    await this.executeQuery(
      config,
      `mutation Merge($input: SceneMergeInput!) { sceneMerge(input: $input) { id } }`,
      {
        input: {
          source: sources,
          destination,
          play_history: true,
          o_history: true,
        },
      },
      false,
    );
  }

  // ---------- organizer: matching and renaming ----------

  /** Scenes with their files and fingerprints, for matching and renaming. */
  async findOrganizerScenes(
    config: StashAdapterBaseConfig,
    options: {
      page: number;
      perPage: number;
      sceneFilter: Record<string, unknown>;
      sort?: string;
      direction?: 'ASC' | 'DESC';
      /** Stash's own search: title, file name, folder and more. */
      q?: string;
    },
  ): Promise<{ total: number; items: StashOrganizerScene[] }> {
    const payload = (await this.executeQuery(
      config,
      `query OrganizerScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes { ${STASH_ORGANIZER_SCENE_FIELDS} }
        }
      }`,
      {
        filter: {
          page: Math.max(1, Math.floor(options.page)),
          per_page: Math.min(100, Math.max(1, Math.floor(options.perPage))),
          sort: options.sort ?? 'created_at',
          direction: options.direction ?? 'DESC',
          ...(options.q?.trim() ? { q: options.q.trim() } : {}),
        },
        scene_filter: options.sceneFilter,
      },
    )) as unknown as {
      data?: { findScenes?: { count?: unknown; scenes?: unknown[] } };
    };
    const result = payload.data?.findScenes;
    return {
      total: typeof result?.count === 'number' ? result.count : 0,
      items: (result?.scenes ?? []).flatMap((scene) => {
        const parsed = this.toOrganizerScene(scene);
        return parsed ? [parsed] : [];
      }),
    };
  }

  async getOrganizerScene(
    config: StashAdapterBaseConfig,
    sceneId: string,
  ): Promise<StashOrganizerScene | null> {
    const id = this.normalizeEntityId(sceneId);
    if (!id) {
      return null;
    }
    const payload = (await this.executeQuery(
      config,
      `query OrganizerScene($id: ID!) { findScene(id: $id) { ${STASH_ORGANIZER_SCENE_FIELDS} } }`,
      { id },
    )) as unknown as { data?: { findScene?: unknown } };
    return this.toOrganizerScene(payload.data?.findScene);
  }

  /** The folders Stash's library is made of (Settings → Library). */
  async getLibraryRoots(config: StashAdapterBaseConfig): Promise<string[]> {
    const payload = (await this.executeQuery(
      config,
      `query Roots { configuration { general { stashes { path } } } }`,
    )) as unknown as {
      data?: {
        configuration?: { general?: { stashes?: Array<{ path?: unknown }> } };
      };
    };
    return (payload.data?.configuration?.general?.stashes ?? [])
      .map((entry) => this.normalizeOptionalString(entry.path))
      .filter((path): path is string => !!path);
  }

  /**
   * The scenes you've watched, rated or marked (O), with their performers
   * and studio as this catalog knows them, for "You may enjoy". Up to a few
   * hundred of each, most recent and highest first.
   */
  async listWatchHistory(
    config: StashAdapterBaseConfig,
    providerKey: CatalogProviderKey,
  ): Promise<WatchedScene[]> {
    const filters: Array<{ filter: Record<string, unknown>; sort: string }> = [
      {
        filter: { play_count: { value: 0, modifier: 'GREATER_THAN' } },
        sort: 'last_played_at',
      },
      {
        filter: { o_counter: { value: 0, modifier: 'GREATER_THAN' } },
        sort: 'o_counter',
      },
      {
        filter: { rating100: { value: 60, modifier: 'GREATER_THAN' } },
        sort: 'rating',
      },
    ];
    const ref = { endpoint: '', stash_id: '' };
    const catalogId = (value: unknown): string | null => {
      const refs = normalizeCatalogSceneRefs(
        (Array.isArray(value) ? value : []).flatMap((entry) => {
          const item = (entry ?? ref) as {
            endpoint?: unknown;
            stash_id?: unknown;
          };
          return typeof item.endpoint === 'string' &&
            typeof item.stash_id === 'string'
            ? [{ endpoint: item.endpoint, externalId: item.stash_id }]
            : [];
        }),
      );
      return findCatalogExternalIdForProvider(refs, providerKey);
    };
    const byId = new Map<string, WatchedScene>();
    for (const { filter, sort } of filters) {
      const payload = (await this.executeQuery(
        config,
        `query WatchHistory($filter: FindFilterType, $scene_filter: SceneFilterType) {
          findScenes(filter: $filter, scene_filter: $scene_filter) {
            scenes {
              id play_count o_counter rating100 last_played_at
              performers { name favorite stash_ids { endpoint stash_id } }
              studio { name favorite stash_ids { endpoint stash_id } }
            }
          }
        }`,
        {
          filter: { page: 1, per_page: 300, sort, direction: 'DESC' },
          scene_filter: filter,
        },
      )) as unknown as {
        data?: { findScenes?: { scenes?: Array<Record<string, unknown>> } };
      };
      for (const scene of payload.data?.findScenes?.scenes ?? []) {
        const id = this.normalizeOptionalString(scene.id);
        if (!id || byId.has(id)) {
          continue;
        }
        const number = (value: unknown) =>
          typeof value === 'number' ? value : 0;
        const studio = scene.studio as Record<string, unknown> | null;
        const studioName = this.normalizeOptionalString(studio?.name);
        byId.set(id, {
          playCount: number(scene.play_count),
          oCounter: number(scene.o_counter),
          rating100:
            typeof scene.rating100 === 'number' ? scene.rating100 : null,
          lastPlayedAt: this.normalizeOptionalString(scene.last_played_at),
          performers: (Array.isArray(scene.performers)
            ? scene.performers
            : []
          ).flatMap((raw) => {
            const performer = raw as Record<string, unknown>;
            const name = this.normalizeOptionalString(performer.name);
            return name
              ? [
                  {
                    name,
                    favorite: performer.favorite === true,
                    catalogId: catalogId(performer.stash_ids),
                  },
                ]
              : [];
          }),
          studio: studioName
            ? {
                name: studioName,
                favorite: studio?.favorite === true,
                catalogId: catalogId(studio?.stash_ids),
              }
            : null,
        });
      }
    }
    return [...byId.values()];
  }

  /**
   * Every video file in the library with its size, resolution and codec, for
   * Library stats. Pages through Stash 500 scenes at a time.
   */
  async listLibraryFiles(config: StashAdapterBaseConfig): Promise<StatsFile[]> {
    const files: StatsFile[] = [];
    const perPage = 500;
    for (let page = 1; page <= 200; page += 1) {
      const payload = (await this.executeQuery(
        config,
        `query LibraryFiles($filter: FindFilterType) {
          findScenes(filter: $filter) {
            count
            scenes {
              id title
              studio { id name }
              files { basename size width height video_codec duration }
            }
          }
        }`,
        // Oldest first, as the library sync does: a scene added meanwhile lands on the last page.
        {
          filter: {
            page,
            per_page: perPage,
            sort: 'created_at',
            direction: 'ASC',
          },
        },
      )) as unknown as {
        data?: {
          findScenes?: {
            count?: unknown;
            scenes?: Array<Record<string, unknown>>;
          };
        };
      };
      const result = payload.data?.findScenes;
      const scenes = Array.isArray(result?.scenes) ? result.scenes : [];
      for (const scene of scenes) {
        const sceneId = this.normalizeOptionalString(scene.id);
        if (!sceneId) {
          continue;
        }
        const studio = scene.studio as Record<string, unknown> | null;
        for (const raw of Array.isArray(scene.files) ? scene.files : []) {
          const file = raw as Record<string, unknown>;
          const number = (value: unknown) =>
            typeof value === 'number'
              ? value
              : typeof value === 'string' && value.trim() !== ''
                ? Number(value)
                : null;
          files.push({
            sceneId,
            title:
              this.normalizeOptionalString(scene.title) ??
              this.normalizeOptionalString(file.basename) ??
              `Scene #${sceneId}`,
            studioId: this.normalizeOptionalString(studio?.id),
            studioName: this.normalizeOptionalString(studio?.name),
            size: number(file.size) ?? 0,
            width: number(file.width),
            height: number(file.height),
            codec: this.normalizeOptionalString(file.video_codec),
            duration: number(file.duration),
          });
        }
      }
      const count = typeof result?.count === 'number' ? result.count : 0;
      if (scenes.length === 0 || page * perPage >= count) {
        break;
      }
    }
    return files;
  }

  /**
   * Whether Stash transcodes with the GPU (Settings → System → Transcoding,
   * hardware encoding). Null when this Stash doesn't have the setting.
   */
  async getTranscodeHardwareAcceleration(
    config: StashAdapterBaseConfig,
  ): Promise<boolean | null> {
    try {
      const payload = (await this.executeQuery(
        config,
        `query Transcoding { configuration { general { transcodeHardwareAcceleration } } }`,
        undefined,
        // Older Stash has no such field: that's not Stash being unwell.
        false,
      )) as unknown as {
        data?: {
          configuration?: {
            general?: { transcodeHardwareAcceleration?: unknown };
          };
        };
      };
      const value =
        payload.data?.configuration?.general?.transcodeHardwareAcceleration;
      return typeof value === 'boolean' ? value : null;
    } catch {
      // Older Stash: no such field.
      return null;
    }
  }

  /**
   * The folders Stash has galleries in: folder galleries and the folders of
   * zip galleries. Loose images (like a scene's cover .jpg) don't count.
   */
  async listGalleryFolders(config: StashAdapterBaseConfig): Promise<string[]> {
    const payload = (await this.executeQuery(
      config,
      `query GalleryFolders { findGalleries(filter: { per_page: -1 }) { galleries { folder { path } files { path } } } }`,
      undefined,
      false,
    )) as unknown as {
      data?: {
        findGalleries?: {
          galleries?: Array<{
            folder?: { path?: unknown } | null;
            files?: Array<{ path?: unknown }>;
          }>;
        };
      };
    };
    const galleries = payload.data?.findGalleries?.galleries;
    if (!Array.isArray(galleries)) {
      throw new Error('Stash didn’t list its galleries.');
    }
    return galleries.flatMap((gallery) => {
      const folder = this.normalizeOptionalString(gallery.folder?.path);
      const zips = (gallery.files ?? []).flatMap((file) => {
        const path = this.normalizeOptionalString(file.path);
        const parent = path ? path.replace(/[\\/][^\\/]*$/, '') : null;
        return parent ? [parent] : [];
      });
      return [...(folder ? [folder] : []), ...zips];
    });
  }

  /** Stash-box endpoints (StashDB and friends) set up in Stash. */
  listStashBoxEndpoints(config: StashAdapterBaseConfig): Promise<string[]> {
    return this.getStashBoxEndpoints(config);
  }

  /** Every stash-box set up in Stash (StashDB, FansDB, ThePornDB…), with its key. */
  async listStashBoxes(
    config: StashAdapterBaseConfig,
  ): Promise<Array<{ name: string; endpoint: string; apiKey: string | null }>> {
    const payload = (await this.executeQuery(
      config,
      `query Boxes { configuration { general { stashBoxes { name endpoint api_key } } } }`,
    )) as unknown as {
      data?: {
        configuration?: {
          general?: { stashBoxes?: Array<Record<string, unknown>> };
        };
      };
    };
    return (payload.data?.configuration?.general?.stashBoxes ?? []).flatMap(
      (box) => {
        const endpoint = this.normalizeOptionalString(box.endpoint);
        if (!endpoint) {
          return [];
        }
        return [
          {
            name: this.normalizeOptionalString(box.name) ?? hostLabel(endpoint),
            endpoint,
            apiKey: this.normalizeOptionalString(box.api_key),
          },
        ];
      },
    );
  }

  /**
   * The parts of Stash's Identify defaults a match should follow: whether to
   * add male performers, and per field (performers, studio, tags) whether
   * to create ones that don't exist yet. Null where Stash says nothing, and
   * all null when it can't be asked.
   */
  async getIdentifyDefaults(config: StashAdapterBaseConfig): Promise<{
    includeMalePerformers: boolean | null;
    createMissing: Record<'performers' | 'studio' | 'tags', boolean | null>;
  }> {
    const none = {
      includeMalePerformers: null,
      createMissing: { performers: null, studio: null, tags: null },
    };
    const payload = (await this.executeQuery(
      config,
      `query IdentifyDefaults { configuration { defaults { identify { options {
        includeMalePerformers
        fieldOptions { field createMissing }
      } } } } }`,
    ).catch(() => null)) as unknown as {
      data?: {
        configuration?: {
          defaults?: {
            identify?: {
              options?: {
                includeMalePerformers?: unknown;
                fieldOptions?: Array<{
                  field?: unknown;
                  createMissing?: unknown;
                }>;
              } | null;
            } | null;
          };
        };
      };
    } | null;
    const options = payload?.data?.configuration?.defaults?.identify?.options;
    if (!options) {
      return none;
    }
    const createFor = (field: string) => {
      const entry = (options.fieldOptions ?? []).find(
        (option) => String(option.field).toLowerCase() === field,
      );
      return typeof entry?.createMissing === 'boolean'
        ? entry.createMissing
        : null;
    };
    return {
      includeMalePerformers:
        typeof options.includeMalePerformers === 'boolean'
          ? options.includeMalePerformers
          : null,
      createMissing: {
        performers: createFor('performers'),
        studio: createFor('studio'),
        tags: createFor('tags'),
      },
    };
  }

  /** Stash's installed scene scrapers that can look a scene up from its file (by fragment). */
  async listFragmentSceneScrapers(
    config: StashAdapterBaseConfig,
  ): Promise<Array<{ id: string; name: string }>> {
    const payload = (await this.executeQuery(
      config,
      `query Scrapers { listScrapers(types: [SCENE]) { id name scene { supported_scrapes } } }`,
    )) as unknown as {
      data?: {
        listScrapers?: Array<{
          id?: unknown;
          name?: unknown;
          scene?: { supported_scrapes?: unknown } | null;
        }>;
      };
    };
    return (payload.data?.listScrapers ?? []).flatMap((scraper) => {
      const id = this.normalizeOptionalString(scraper.id);
      const supported = Array.isArray(scraper.scene?.supported_scrapes)
        ? scraper.scene.supported_scrapes
        : [];
      if (!id || !supported.includes('FRAGMENT')) {
        return [];
      }
      return [{ id, name: this.normalizeOptionalString(scraper.name) ?? id }];
    });
  }

  /**
   * Stash's own Identify with the given scrapers as sources. Stash only saves
   * what a scraper returns for that exact file, one result per scene.
   */
  async identifyWithScrapers(
    config: StashAdapterBaseConfig,
    scraperIds: string[],
    sceneIds: string[],
  ): Promise<string | null> {
    const ids = sceneIds
      .map((id) => this.normalizeEntityId(id))
      .filter((id): id is string => !!id);
    if (scraperIds.length === 0 || ids.length === 0) {
      return null;
    }
    const payload = (await this.executeQuery(
      config,
      `mutation Identify($input: IdentifyMetadataInput!) { metadataIdentify(input: $input) }`,
      {
        input: {
          sources: scraperIds.map((scraperId) => ({
            source: { scraper_id: scraperId },
          })),
          sceneIDs: ids,
        },
      },
      false,
    )) as unknown as { data?: Record<string, unknown> };
    const value = Object.values(payload.data ?? {})[0];
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : null;
  }

  /** Moves or renames a file; Stash keeps the scene, its history and generated files. */
  async moveFile(
    config: StashAdapterBaseConfig,
    fileId: string,
    destinationFolder: string,
    destinationBasename: string,
  ): Promise<void> {
    const id = this.normalizeEntityId(fileId);
    if (!id) {
      throw new BadGatewayException('That file has no id in Stash.');
    }
    const payload = (await this.executeQuery(
      config,
      `mutation Move($input: MoveFilesInput!) { moveFiles(input: $input) }`,
      {
        input: {
          ids: [id],
          destination_folder: destinationFolder,
          destination_basename: destinationBasename,
        },
      },
      false,
    )) as unknown as { data?: { moveFiles?: unknown } };
    if (payload.data?.moveFiles === false) {
      throw new BadGatewayException('Stash could not move the file.');
    }
  }

  /** A local studio for a StashDB studio: by StashDB id, then by name, else a new one. */
  async ensureStudio(
    config: StashAdapterBaseConfig,
    studio: {
      name: string;
      stashId: string;
      endpoint: string;
      imageUrl?: string | null;
      /** False to only link one that already exists, as Stash's Identify can be set to. */
      create?: boolean;
    },
  ): Promise<string | null> {
    const found =
      (await this.findEntityByStashId(
        config,
        'studio',
        studio.endpoint,
        studio.stashId,
      )) ?? (await this.findEntityByName(config, 'studio', studio.name));
    if (found) {
      await this.fillMissingImage(config, 'studio', found, studio.imageUrl);
      return found;
    }
    // StashDB's "Mr Anal" may be the local "Mr. Anal", with this as an alias.
    const aliased = await this.findEntityByAlias(config, 'studio', studio.name);
    if (aliased) {
      await this.fillMissingImage(config, 'studio', aliased, studio.imageUrl);
      return aliased;
    }
    if (studio.create === false) {
      return null;
    }
    let payload: { data?: { studioCreate?: { id?: unknown } } };
    try {
      payload = await this.withImageOrWithout(
        studio.imageUrl,
        (image) =>
          this.executeQuery(
            config,
            `mutation NewStudio($input: StudioCreateInput!) { studioCreate(input: $input) { id } }`,
            {
              input: {
                name: studio.name,
                stash_ids: [
                  { endpoint: studio.endpoint, stash_id: studio.stashId },
                ],
                ...(image ? { image } : {}),
              },
            },
            false,
          ) as unknown as Promise<{
            data?: { studioCreate?: { id?: unknown } };
          }>,
      );
    } catch (error) {
      // Stash names the studio that has it as an alias; use that one.
      const owner = this.aliasOwner(error);
      const existing = owner
        ? await this.findEntityByName(config, 'studio', owner)
        : null;
      if (existing) {
        return existing;
      }
      throw error;
    }
    const id = this.normalizeOptionalString(payload.data?.studioCreate?.id);
    if (!id) {
      throw new BadGatewayException(
        `Stash did not create the studio ${studio.name}.`,
      );
    }
    return id;
  }

  /** A local performer for a StashDB performer: by StashDB id, then by name, else a new one. */
  async ensurePerformer(
    config: StashAdapterBaseConfig,
    performer: {
      name: string;
      disambiguation: string | null;
      gender: string | null;
      stashId: string;
      endpoint: string;
      imageUrl?: string | null;
      /** False to only link one that already exists, as Stash's Identify can be set to. */
      create?: boolean;
    },
  ): Promise<string | null> {
    const found =
      (await this.findEntityByStashId(
        config,
        'performer',
        performer.endpoint,
        performer.stashId,
      )) ??
      (await this.findEntityByName(
        config,
        'performer',
        performer.name,
        performer.disambiguation,
      ));
    if (found) {
      await this.fillMissingImage(
        config,
        'performer',
        found,
        performer.imageUrl,
      );
      return found;
    }
    if (performer.create === false) {
      return null;
    }
    const gender =
      performer.gender && STASH_GENDERS.has(performer.gender)
        ? performer.gender
        : undefined;
    const payload = await this.withImageOrWithout(
      performer.imageUrl,
      (image) =>
        this.executeQuery(
          config,
          `mutation NewPerformer($input: PerformerCreateInput!) { performerCreate(input: $input) { id } }`,
          {
            input: {
              name: performer.name,
              ...(performer.disambiguation
                ? { disambiguation: performer.disambiguation }
                : {}),
              ...(gender ? { gender } : {}),
              ...(image ? { image } : {}),
              stash_ids: [
                { endpoint: performer.endpoint, stash_id: performer.stashId },
              ],
            },
          },
          false,
        ) as unknown as Promise<{
          data?: { performerCreate?: { id?: unknown } };
        }>,
    );
    const id = this.normalizeOptionalString(payload.data?.performerCreate?.id);
    if (!id) {
      throw new BadGatewayException(
        `Stash did not create the performer ${performer.name}.`,
      );
    }
    return id;
  }

  /** A local tag with this name or alias, created when missing. Null if Stash refuses it. */
  async ensureTag(
    config: StashAdapterBaseConfig,
    name: string,
    create = true,
  ): Promise<string | null> {
    const found = await this.findEntityByName(config, 'tag', name);
    if (found) {
      return found;
    }
    try {
      const aliasId = await this.findEntityByAlias(config, 'tag', name);
      if (aliasId || !create) {
        return aliasId;
      }
      const payload = (await this.executeQuery(
        config,
        `mutation NewTag($input: TagCreateInput!) { tagCreate(input: $input) { id } }`,
        { input: { name } },
        false,
      )) as unknown as { data?: { tagCreate?: { id?: unknown } } };
      return this.normalizeOptionalString(payload.data?.tagCreate?.id);
    } catch {
      return null;
    }
  }

  /** Saves a StashDB match onto a local scene. */
  async applySceneMatch(
    config: StashAdapterBaseConfig,
    sceneId: string,
    match: StashSceneMatchInput,
  ): Promise<void> {
    const id = this.normalizeEntityId(sceneId);
    if (!id) {
      return;
    }
    const input: Record<string, unknown> = {
      id,
      stash_ids: match.stashIds.map((entry) => ({
        endpoint: entry.endpoint,
        stash_id: entry.stashId,
      })),
      performer_ids: match.performerIds,
      tag_ids: match.tagIds,
    };
    if (match.title) input['title'] = match.title;
    if (match.code) input['code'] = match.code;
    if (match.details) input['details'] = match.details;
    if (match.director) input['director'] = match.director;
    if (match.date) input['date'] = match.date;
    if (match.studioId) input['studio_id'] = match.studioId;
    if (match.coverImageUrl) input['cover_image'] = match.coverImageUrl;
    const run = (body: Record<string, unknown>) =>
      this.executeQuery(
        config,
        `mutation MatchScene($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
        { input: body },
        false,
      );
    try {
      await run(match.urls.length ? { ...input, urls: match.urls } : input);
    } catch (error) {
      const message = this.errorMessage(error);
      if (/cover|image/i.test(message) && input['cover_image']) {
        // The cover couldn't be downloaded; keep everything else.
        const { cover_image: _cover, ...rest } = input;
        await run(match.urls.length ? { ...rest, urls: match.urls } : rest);
        return;
      }
      if (!/urls/i.test(message) || match.urls.length === 0) {
        throw error;
      }
      // Older Stash has a single url field.
      await run({ ...input, url: match.urls[0] });
    }
  }

  protected async findEntityByStashId(
    config: StashAdapterBaseConfig,
    kind: 'studio' | 'performer',
    endpoint: string,
    stashId: string,
  ): Promise<string | null> {
    const plural = kind === 'studio' ? 'Studios' : 'Performers';
    const list = kind === 'studio' ? 'studios' : 'performers';
    const filterType =
      kind === 'studio' ? 'StudioFilterType' : 'PerformerFilterType';
    try {
      const payload = (await this.executeQuery(
        config,
        `query ByStashId($filter: ${filterType}) { find${plural}(${kind}_filter: $filter, filter: { per_page: 1 }) { ${list} { id } } }`,
        {
          filter: {
            stash_id_endpoint: {
              endpoint,
              stash_id: stashId,
              modifier: 'EQUALS',
            },
          },
        },
      )) as unknown as {
        data?: Record<
          string,
          { [key: string]: Array<{ id?: unknown }> } | undefined
        >;
      };
      return this.normalizeOptionalString(
        payload.data?.[`find${plural}`]?.[list]?.[0]?.id,
      );
    } catch {
      // Older Stash can't filter by StashDB id; fall back to the name.
      return null;
    }
  }

  /**
   * Gives a studio or performer that still has Stash's placeholder the
   * StashDB image. Best effort: a missing logo never fails a match.
   */
  protected async fillMissingImage(
    config: StashAdapterBaseConfig,
    kind: 'studio' | 'performer',
    id: string,
    imageUrl: string | null | undefined,
  ): Promise<void> {
    if (!imageUrl) {
      return;
    }
    const find = kind === 'studio' ? 'findStudio' : 'findPerformer';
    try {
      const payload = (await this.executeQuery(
        config,
        `query CurrentImage($id: ID!) { ${find}(id: $id) { image_path } }`,
        { id },
      )) as unknown as {
        data?: Record<string, { image_path?: unknown } | null | undefined>;
      };
      const path = payload.data?.[find]?.image_path;
      if (typeof path === 'string' && !path.includes('default=true')) {
        return;
      }
      const update = kind === 'studio' ? 'studioUpdate' : 'performerUpdate';
      const input =
        kind === 'studio' ? 'StudioUpdateInput' : 'PerformerUpdateInput';
      await this.executeQuery(
        config,
        `mutation SetImage($input: ${input}!) { ${update}(input: $input) { id } }`,
        { input: { id, image: imageUrl } },
        false,
      );
    } catch {
      // Stash couldn't fetch the image; leave it as it is.
    }
  }

  /**
   * Creates with the StashDB image, and without it when Stash refuses (it
   * couldn't download the image, say): a missing logo beats a failed match.
   */
  protected async withImageOrWithout<T>(
    imageUrl: string | null | undefined,
    create: (image: string | null) => Promise<T>,
  ): Promise<T> {
    if (!imageUrl) {
      return create(null);
    }
    try {
      return await create(imageUrl);
    } catch (error) {
      if (this.aliasOwner(error)) {
        throw error;
      }
      return create(null);
    }
  }

  /** A studio or tag that lists this name among its aliases. */
  protected async findEntityByAlias(
    config: StashAdapterBaseConfig,
    kind: 'studio' | 'tag',
    name: string,
  ): Promise<string | null> {
    const [plural, list, filterType] =
      kind === 'studio'
        ? ['Studios', 'studios', 'StudioFilterType']
        : ['Tags', 'tags', 'TagFilterType'];
    const payload = (await this.executeQuery(
      config,
      `query ByAlias($filter: ${filterType}) { find${plural}(${kind}_filter: $filter, filter: { per_page: 1 }) { ${list} { id } } }`,
      { filter: { aliases: { value: name, modifier: 'EQUALS' } } },
    ).catch(() => null)) as unknown as {
      data?: Record<
        string,
        Record<string, Array<{ id?: unknown }>> | undefined
      >;
    } | null;
    return this.normalizeOptionalString(
      payload?.data?.[`find${plural}`]?.[list]?.[0]?.id,
    );
  }

  /** From "name 'Mr Anal' is used as alias for 'Mr. Anal'", the 'Mr. Anal'. */
  protected aliasOwner(error: unknown): string | null {
    const message = error instanceof Error ? error.message : String(error);
    return /is used as alias for '([^']+)'/.exec(message)?.[1] ?? null;
  }

  protected async findEntityByName(
    config: StashAdapterBaseConfig,
    kind: 'studio' | 'performer' | 'tag',
    name: string,
    disambiguation?: string | null,
  ): Promise<string | null> {
    const plural =
      kind === 'studio'
        ? 'Studios'
        : kind === 'performer'
          ? 'Performers'
          : 'Tags';
    const list =
      kind === 'studio'
        ? 'studios'
        : kind === 'performer'
          ? 'performers'
          : 'tags';
    const filterType =
      kind === 'studio'
        ? 'StudioFilterType'
        : kind === 'performer'
          ? 'PerformerFilterType'
          : 'TagFilterType';
    const extra = kind === 'performer' ? ' disambiguation' : '';
    const payload = (await this.executeQuery(
      config,
      `query ByName($filter: ${filterType}) { find${plural}(${kind}_filter: $filter, filter: { per_page: 10 }) { ${list} { id name${extra} } } }`,
      { filter: { name: { value: name, modifier: 'EQUALS' } } },
    )) as unknown as {
      data?: Record<
        string,
        { [key: string]: Array<Record<string, unknown>> } | undefined
      >;
    };
    const rows = payload.data?.[`find${plural}`]?.[list] ?? [];
    const exact = rows.filter(
      (row) =>
        (this.normalizeOptionalString(row.name) ?? '').toLowerCase() ===
        name.toLowerCase(),
    );
    if (kind === 'performer' && disambiguation) {
      const same = exact.find(
        (row) =>
          (
            this.normalizeOptionalString(row.disambiguation) ?? ''
          ).toLowerCase() === disambiguation.toLowerCase(),
      );
      return this.normalizeOptionalString(same?.id);
    }
    return this.normalizeOptionalString(exact[0]?.id);
  }

  protected toOrganizerScene(value: unknown): StashOrganizerScene | null {
    const scene = value as Record<string, unknown> | null | undefined;
    const id = this.normalizeOptionalString(scene?.id);
    if (!scene || !id) {
      return null;
    }
    const num = (input: unknown) =>
      typeof input === 'number' && Number.isFinite(input) ? input : null;
    const studio = scene.studio as Record<string, unknown> | null | undefined;
    const studioId = this.normalizeOptionalString(studio?.id);
    const studioName = this.normalizeOptionalString(studio?.name);
    const paths = scene.paths as Record<string, unknown> | null | undefined;
    return {
      id,
      title: this.normalizeOptionalString(scene.title),
      code: this.normalizeOptionalString(scene.code),
      date: this.normalizeOptionalString(scene.date),
      organized: scene.organized === true,
      createdAt: this.normalizeOptionalString(scene.created_at),
      screenshotVersion: stashImageVersion(paths?.screenshot),
      studio:
        studioId && studioName ? { id: studioId, name: studioName } : null,
      performers: (Array.isArray(scene.performers)
        ? scene.performers
        : []
      ).flatMap((entry) => {
        const name = this.normalizeOptionalString(
          (entry as Record<string, unknown> | null)?.name,
        );
        return name ? [name] : [];
      }),
      performerDetails: (Array.isArray(scene.performers)
        ? scene.performers
        : []
      ).flatMap((entry) => {
        const record = entry as Record<string, unknown> | null;
        const name = this.normalizeOptionalString(record?.name);
        return name
          ? [{ name, gender: this.normalizeOptionalString(record?.gender) }]
          : [];
      }),
      tagIds: (Array.isArray(scene.tags) ? scene.tags : []).flatMap((entry) => {
        const tagId = this.normalizeOptionalString(
          (entry as Record<string, unknown> | null)?.id,
        );
        return tagId ? [tagId] : [];
      }),
      stashIds: (Array.isArray(scene.stash_ids) ? scene.stash_ids : []).flatMap(
        (entry) => {
          const row = entry as Record<string, unknown> | null;
          const endpoint = this.normalizeOptionalString(row?.endpoint);
          const stashId = this.normalizeOptionalString(row?.stash_id);
          return endpoint && stashId ? [{ endpoint, stashId }] : [];
        },
      ),
      files: (Array.isArray(scene.files) ? scene.files : []).flatMap(
        (entry) => {
          const file = entry as Record<string, unknown> | null;
          const fileId = this.normalizeOptionalString(file?.id);
          const path = this.normalizeOptionalString(file?.path);
          if (!file || !fileId || !path) {
            return [];
          }
          return [
            {
              id: fileId,
              path,
              basename:
                this.normalizeOptionalString(file.basename) ??
                path.split(/[\\/]/).pop() ??
                path,
              duration: num(file.duration),
              size:
                num(file.size) ??
                (typeof file.size === 'string'
                  ? Number(file.size) || null
                  : null),
              width: num(file.width),
              height: num(file.height),
              fingerprints: (Array.isArray(file.fingerprints)
                ? file.fingerprints
                : []
              ).flatMap((print) => {
                const row = print as Record<string, unknown> | null;
                const type = this.normalizeOptionalString(row?.type);
                const value = row?.value;
                const fingerprint =
                  typeof value === 'string' || typeof value === 'number'
                    ? String(value).trim()
                    : null;
                return type && fingerprint
                  ? [{ type: type.toLowerCase(), value: fingerprint }]
                  : [];
              }),
            },
          ];
        },
      ),
    };
  }

  // ---------- tag cleanup ----------

  /** Every tag with its aliases and how many scenes use it. */
  async listTags(config: StashAdapterBaseConfig): Promise<StashTagSummary[]> {
    const payload = (await this.executeQuery(
      config,
      `query AllTags($filter: FindFilterType) {
        findTags(filter: $filter) {
          tags { id name aliases scene_count }
        }
      }`,
      { filter: { per_page: -1, sort: 'name', direction: 'ASC' } },
    )) as unknown as {
      data?: { findTags?: { tags?: Array<Record<string, unknown>> } };
    };
    return (payload.data?.findTags?.tags ?? []).flatMap((tag) => {
      const id = this.normalizeEntityId(idText(tag['id']));
      const name = typeof tag['name'] === 'string' ? tag['name'] : null;
      if (!id || !name) {
        return [];
      }
      return [
        {
          id,
          name,
          aliases: Array.isArray(tag['aliases'])
            ? tag['aliases'].filter(
                (alias): alias is string => typeof alias === 'string',
              )
            : [],
          sceneCount:
            typeof tag['scene_count'] === 'number' ? tag['scene_count'] : 0,
        },
      ];
    });
  }

  /**
   * Chapters (scene markers) across the library, by tag, performer or words
   * in the title. Each says where it ends: its own end time, else the next
   * chapter in its scene, else a minute on (never past the scene's end).
   */
  async findChapters(
    config: StashAdapterBaseConfig,
    options: {
      tagId?: string | null;
      performerId?: string | null;
      query?: string | null;
      limit: number;
    },
  ): Promise<StashChapter[]> {
    const markerFilter: Record<string, unknown> = {};
    if (options.tagId) {
      // A chapter counts when its main tag or any of its tags is this one.
      markerFilter['tags'] = {
        value: [options.tagId],
        modifier: 'INCLUDES',
        depth: 0,
      };
    }
    if (options.performerId) {
      markerFilter['performers'] = {
        value: [options.performerId],
        modifier: 'INCLUDES',
      };
    }
    const payload = (await this.executeQuery(
      config,
      `query Chapters($filter: FindFilterType, $marker_filter: SceneMarkerFilterType) {
        findSceneMarkers(filter: $filter, scene_marker_filter: $marker_filter) {
          scene_markers {
            id title seconds end_seconds
            primary_tag { id name }
            scene { id title files { duration } scene_markers { seconds } }
          }
        }
      }`,
      {
        filter: {
          per_page: Math.min(1000, Math.max(1, Math.floor(options.limit))),
          sort: 'created_at',
          direction: 'DESC',
          ...(options.query?.trim() ? { q: options.query.trim() } : {}),
        },
        marker_filter: markerFilter,
      },
    )) as unknown as {
      data?: {
        findSceneMarkers?: { scene_markers?: Array<Record<string, unknown>> };
      };
    };
    return (payload.data?.findSceneMarkers?.scene_markers ?? []).flatMap(
      (marker) => {
        const id = this.normalizeEntityId(idText(marker['id']));
        const scene = marker['scene'] as Record<string, unknown> | null;
        const sceneId = this.normalizeEntityId(idText(scene?.['id']));
        const seconds = marker['seconds'];
        if (!id || !sceneId || typeof seconds !== 'number' || seconds < 0) {
          return [];
        }
        const tag = marker['primary_tag'] as Record<string, unknown> | null;
        const files = Array.isArray(scene?.['files'])
          ? (scene['files'] as Array<Record<string, unknown>>)
          : [];
        const duration = files.find(
          (file) => typeof file['duration'] === 'number',
        )?.['duration'] as number | undefined;
        const others = (
          Array.isArray(scene?.['scene_markers'])
            ? (scene['scene_markers'] as Array<Record<string, unknown>>)
            : []
        )
          .map((other) => other['seconds'])
          .filter(
            (value): value is number =>
              typeof value === 'number' && value > seconds + 0.5,
          )
          .sort((a, b) => a - b);
        const own = marker['end_seconds'];
        let end =
          typeof own === 'number' && own > seconds
            ? own
            : (others[0] ?? seconds + DEFAULT_CHAPTER_SECONDS);
        if (duration && duration > seconds) {
          end = Math.min(end, duration);
        }
        const title =
          (typeof marker['title'] === 'string' && marker['title'].trim()) ||
          (typeof tag?.['name'] === 'string' ? tag['name'] : '') ||
          'Chapter';
        const sceneTitle =
          typeof scene?.['title'] === 'string' && scene['title'].trim()
            ? scene['title'].trim()
            : `Scene #${sceneId}`;
        return [
          {
            id,
            title,
            seconds,
            endSeconds: end,
            tagName: typeof tag?.['name'] === 'string' ? tag['name'] : null,
            sceneId,
            sceneTitle,
          },
        ];
      },
    );
  }

  /** Tags used on chapters, the most used first. */
  async listChapterTags(
    config: StashAdapterBaseConfig,
  ): Promise<Array<{ id: string; name: string; count: number }>> {
    const payload = (await this.executeQuery(
      config,
      `query ChapterTags($filter: FindFilterType, $tag_filter: TagFilterType) {
        findTags(filter: $filter, tag_filter: $tag_filter) {
          tags { id name scene_marker_count }
        }
      }`,
      {
        filter: {
          per_page: 200,
          sort: 'scene_markers_count',
          direction: 'DESC',
        },
        tag_filter: { marker_count: { value: 0, modifier: 'GREATER_THAN' } },
      },
    )) as unknown as {
      data?: { findTags?: { tags?: Array<Record<string, unknown>> } };
    };
    return (payload.data?.findTags?.tags ?? [])
      .flatMap((tag) => {
        const id = this.normalizeEntityId(idText(tag['id']));
        const name = typeof tag['name'] === 'string' ? tag['name'] : null;
        const count =
          typeof tag['scene_marker_count'] === 'number'
            ? tag['scene_marker_count']
            : 0;
        return id && name && count > 0 ? [{ id, name, count }] : [];
      })
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /** Every performer or studio, for finding ones entered twice. */
  async listForMerge(
    config: StashAdapterBaseConfig,
    kind: 'performer' | 'studio',
  ): Promise<StashMergeCandidate[]> {
    const query =
      kind === 'performer'
        ? `query MergePerformers($filter: FindFilterType) {
            findPerformers(filter: $filter) {
              performers { id name disambiguation alias_list scene_count death_date }
            }
          }`
        : `query MergeStudios($filter: FindFilterType) {
            findStudios(filter: $filter) {
              studios { id name aliases scene_count parent_studio { name } }
            }
          }`;
    const payload = (await this.executeQuery(config, query, {
      filter: { per_page: -1, sort: 'name', direction: 'ASC' },
    })) as unknown as {
      data?: {
        findPerformers?: { performers?: Array<Record<string, unknown>> };
        findStudios?: { studios?: Array<Record<string, unknown>> };
      };
    };
    const rows =
      kind === 'performer'
        ? (payload.data?.findPerformers?.performers ?? [])
        : (payload.data?.findStudios?.studios ?? []);
    return rows.flatMap((row) => {
      const id = this.normalizeEntityId(idText(row['id']));
      const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
      if (!id || !name) {
        return [];
      }
      const aliases = row[kind === 'performer' ? 'alias_list' : 'aliases'];
      const parent = row['parent_studio'] as Record<string, unknown> | null;
      const note =
        kind === 'performer'
          ? (typeof row['disambiguation'] === 'string' &&
              row['disambiguation'].trim()) ||
            null
          : typeof parent?.['name'] === 'string'
            ? `Part of ${parent['name']}`
            : null;
      return [
        {
          id,
          name,
          aliases: Array.isArray(aliases)
            ? aliases.filter(
                (alias): alias is string => typeof alias === 'string',
              )
            : [],
          sceneCount:
            typeof row['scene_count'] === 'number' ? row['scene_count'] : 0,
          note,
          deathDate:
            typeof row['death_date'] === 'string' && row['death_date']
              ? row['death_date']
              : null,
        },
      ];
    });
  }

  /**
   * Merges performers into one with Stash's performerMerge (scenes,
   * galleries, images and tags), keeping the others' names as aliases and
   * their StashDB/FansDB links, which the merge itself drops.
   */
  async mergePerformers(
    config: StashAdapterBaseConfig,
    keepId: string,
    mergeIds: string[],
  ): Promise<void> {
    const ids = [keepId, ...mergeIds];
    const payload = (await this.executeQuery(
      config,
      `query MergeSources($ids: [ID!]) {
        findPerformers(ids: $ids, filter: { per_page: -1 }) {
          performers { id name alias_list stash_ids { endpoint stash_id } }
        }
      }`,
      { ids },
    )) as unknown as {
      data?: {
        findPerformers?: { performers?: Array<Record<string, unknown>> };
      };
    };
    const found = payload.data?.findPerformers?.performers ?? [];
    const keep = found.find((row) => idText(row['id']) === keepId);
    const sources = found.filter((row) =>
      mergeIds.includes(idText(row['id']) ?? ''),
    );
    if (!keep || sources.length !== mergeIds.length) {
      throw new Error('One of those performers is no longer in Stash.');
    }
    const values = mergedValues(keep, sources, 'alias_list');
    await this.executeQuery(
      config,
      `mutation MergePerformers($input: PerformerMergeInput!) {
        performerMerge(input: $input) { id }
      }`,
      {
        input: {
          source: mergeIds,
          destination: keepId,
          values: {
            id: keepId,
            alias_list: values.aliases,
            stash_ids: values.stashIds,
          },
        },
      },
    );
  }

  /**
   * Merges studios into one. Stash has no studio merge, so this moves each
   * one's scenes, galleries, images, groups and sub-studios to the one kept,
   * adds its name and aliases as aliases and its StashDB/FansDB links, then
   * deletes it. Stops at the first failure; what moved stays moved.
   */
  async mergeStudios(
    config: StashAdapterBaseConfig,
    keepId: string,
    mergeIds: string[],
  ): Promise<void> {
    const studioFields =
      'id name aliases stash_ids { endpoint stash_id } child_studios { id }';
    const payload = (await this.executeQuery(
      config,
      `query MergeStudioSources($ids: [ID!]) {
        findStudios(ids: $ids, filter: { per_page: -1 }) { studios { ${studioFields} } }
      }`,
      { ids: [keepId, ...mergeIds] },
    )) as unknown as {
      data?: { findStudios?: { studios?: Array<Record<string, unknown>> } };
    };
    const found = payload.data?.findStudios?.studios ?? [];
    const keep = found.find((row) => idText(row['id']) === keepId);
    const sources = found.filter((row) =>
      mergeIds.includes(idText(row['id']) ?? ''),
    );
    if (!keep || sources.length !== mergeIds.length) {
      throw new Error('One of those studios is no longer in Stash.');
    }
    const kinds = [
      {
        find: 'findScenes',
        list: 'scenes',
        filter: 'scene_filter',
        type: 'SceneFilterType',
        bulk: 'bulkSceneUpdate',
        input: 'BulkSceneUpdateInput',
      },
      {
        find: 'findGalleries',
        list: 'galleries',
        filter: 'gallery_filter',
        type: 'GalleryFilterType',
        bulk: 'bulkGalleryUpdate',
        input: 'BulkGalleryUpdateInput',
      },
      {
        find: 'findImages',
        list: 'images',
        filter: 'image_filter',
        type: 'ImageFilterType',
        bulk: 'bulkImageUpdate',
        input: 'BulkImageUpdateInput',
      },
      {
        find: 'findGroups',
        list: 'groups',
        filter: 'group_filter',
        type: 'GroupFilterType',
        bulk: 'bulkGroupUpdate',
        input: 'BulkGroupUpdateInput',
      },
    ];
    for (const source of sources) {
      const sourceId = idText(source['id']);
      for (const kind of kinds) {
        const listed = (await this.executeQuery(
          config,
          `query StudioItems($f: ${kind.type}) {
            ${kind.find}(${kind.filter}: $f, filter: { per_page: -1 }) { ${kind.list} { id } }
          }`,
          {
            f: {
              studios: { value: [sourceId], modifier: 'INCLUDES', depth: 0 },
            },
          },
        )) as unknown as {
          data?: Record<string, Record<string, Array<{ id: unknown }>>>;
        };
        const itemIds = (listed.data?.[kind.find]?.[kind.list] ?? [])
          .map((item) => idText(item.id))
          .filter((id): id is string => !!id);
        for (let start = 0; start < itemIds.length; start += 500) {
          await this.executeQuery(
            config,
            `mutation MoveToStudio($input: ${kind.input}!) { ${kind.bulk}(input: $input) { id } }`,
            {
              input: {
                ids: itemIds.slice(start, start + 500),
                studio_id: keepId,
              },
            },
          );
        }
      }
      const children = Array.isArray(source['child_studios'])
        ? (source['child_studios'] as Array<Record<string, unknown>>)
        : [];
      for (const child of children) {
        const childId = idText(child['id']);
        if (childId && childId !== keepId) {
          await this.executeQuery(
            config,
            `mutation MoveSubStudio($input: StudioUpdateInput!) { studioUpdate(input: $input) { id } }`,
            { input: { id: childId, parent_id: keepId } },
          );
        }
      }
    }
    // A studio's alias can't be another studio's name, so the merged ones go first.
    for (const id of mergeIds) {
      await this.executeQuery(
        config,
        `mutation RemoveStudio($input: StudioDestroyInput!) { studioDestroy(input: $input) }`,
        { input: { id } },
      );
    }
    const values = mergedValues(keep, sources, 'aliases');
    try {
      await this.executeQuery(
        config,
        `mutation KeepStudio($input: StudioUpdateInput!) { studioUpdate(input: $input) { id } }`,
        {
          input: {
            id: keepId,
            aliases: values.aliases,
            stash_ids: values.stashIds,
          },
        },
      );
    } catch (error) {
      // The merged studios are gone by now: say exactly what to add by hand.
      const links = values.stashIds.map(
        (link) => `${link.endpoint} ${link.stash_id}`,
      );
      throw new Error(
        `The scenes were moved and the other studios removed, but their names couldn't be added to ${String(keep['name'])}: ${error instanceof Error ? error.message : String(error)}. Add these in Stash: aliases ${values.aliases.join(', ') || '(none)'}${links.length ? `; StashDB/FansDB links ${links.join(', ')}` : ''}.`,
      );
    }
  }

  /**
   * Before a duplicate is removed: puts its plays and O history, tags,
   * performers, galleries, groups, links and rating on the copy kept, and its
   * chapters too when both run the same length (within 3 seconds).
   */
  async carrySceneDetails(
    config: StashAdapterBaseConfig,
    fromId: string,
    toId: string,
  ): Promise<{ plays: number; os: number; chapters: number }> {
    const payload = (await this.executeQuery(
      config,
      `query CarryScenes($ids: [ID!]) {
        findScenes(ids: $ids, filter: { per_page: -1 }) {
          scenes {
            id rating100 organized play_history o_history urls
            tags { id } performers { id } galleries { id }
            groups { group { id } scene_index }
            stash_ids { endpoint stash_id }
            files { duration }
            scene_markers { title seconds end_seconds primary_tag { id } tags { id } }
          }
        }
      }`,
      { ids: [fromId, toId] },
    )) as unknown as {
      data?: { findScenes?: { scenes?: Array<Record<string, unknown>> } };
    };
    const scenes = payload.data?.findScenes?.scenes ?? [];
    const from = scenes.find((scene) => idText(scene['id']) === fromId);
    const to = scenes.find((scene) => idText(scene['id']) === toId);
    if (!from || !to) {
      throw new Error('One of the copies is no longer in Stash.');
    }
    const list = (scene: Record<string, unknown>, field: string) =>
      Array.isArray(scene[field])
        ? (scene[field] as Array<Record<string, unknown>>)
        : [];
    const ids = (field: string) => [
      ...new Set(
        [...list(to, field), ...list(from, field)]
          .map((item) => idText(item['id']))
          .filter((id): id is string => !!id),
      ),
    ];
    const groups = new Map<
      string,
      { group_id: string; scene_index: number | null }
    >();
    for (const entry of [...list(to, 'groups'), ...list(from, 'groups')]) {
      const groupId = idText(
        (entry['group'] as Record<string, unknown> | null)?.['id'],
      );
      if (groupId && !groups.has(groupId)) {
        groups.set(groupId, {
          group_id: groupId,
          scene_index:
            typeof entry['scene_index'] === 'number'
              ? entry['scene_index']
              : null,
        });
      }
    }
    const links = new Map<string, { endpoint: string; stash_id: string }>();
    for (const link of [...list(to, 'stash_ids'), ...list(from, 'stash_ids')]) {
      if (
        typeof link['endpoint'] === 'string' &&
        typeof link['stash_id'] === 'string'
      ) {
        links.set(`${link['endpoint']} ${link['stash_id']}`, {
          endpoint: link['endpoint'],
          stash_id: link['stash_id'],
        });
      }
    }
    const strings = (scene: Record<string, unknown>, field: string) =>
      Array.isArray(scene[field])
        ? (scene[field] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
    await this.executeQuery(
      config,
      `mutation CarryDetails($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
      {
        input: {
          id: toId,
          tag_ids: ids('tags'),
          performer_ids: ids('performers'),
          gallery_ids: ids('galleries'),
          groups: [...groups.values()],
          stash_ids: [...links.values()],
          urls: [
            ...new Set([...strings(to, 'urls'), ...strings(from, 'urls')]),
          ],
          rating100:
            typeof to['rating100'] === 'number'
              ? to['rating100']
              : (from['rating100'] ?? null),
          organized: to['organized'] === true || from['organized'] === true,
        },
      },
    );
    // Chapters first (already-there ones are skipped), history last: a
    // retry after a failure then doesn't add the plays twice.
    const length = (scene: Record<string, unknown>) =>
      Math.max(
        0,
        ...list(scene, 'files').map((file) =>
          typeof file['duration'] === 'number' ? file['duration'] : 0,
        ),
      );
    let chapters = 0;
    if (Math.abs(length(from) - length(to)) <= 3 && length(to) > 0) {
      const existing = list(to, 'scene_markers');
      for (const marker of list(from, 'scene_markers')) {
        const tagId = idText(
          (marker['primary_tag'] as Record<string, unknown> | null)?.['id'],
        );
        const seconds = marker['seconds'];
        if (!tagId || typeof seconds !== 'number') {
          continue;
        }
        const already = existing.some(
          (other) =>
            typeof other['seconds'] === 'number' &&
            Math.abs(other['seconds'] - seconds) <= 1 &&
            idText(
              (other['primary_tag'] as Record<string, unknown> | null)?.['id'],
            ) === tagId,
        );
        if (already) {
          continue;
        }
        await this.executeQuery(
          config,
          `mutation CarryChapter($input: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $input) { id } }`,
          {
            input: {
              scene_id: toId,
              title: typeof marker['title'] === 'string' ? marker['title'] : '',
              seconds,
              ...(typeof marker['end_seconds'] === 'number'
                ? { end_seconds: marker['end_seconds'] }
                : {}),
              primary_tag_id: tagId,
              tag_ids: list(marker, 'tags')
                .map((tag) => idText(tag['id']))
                .filter((id): id is string => !!id),
            },
          },
        );
        chapters += 1;
      }
    }
    const plays = strings(from, 'play_history');
    const os = strings(from, 'o_history');
    if (plays.length > 0) {
      await this.executeQuery(
        config,
        `mutation CarryPlays($id: ID!, $times: [Timestamp!]) { sceneAddPlay(id: $id, times: $times) { count } }`,
        { id: toId, times: plays },
      );
    }
    if (os.length > 0) {
      await this.executeQuery(
        config,
        `mutation CarryOs($id: ID!, $times: [Timestamp!]) { sceneAddO(id: $id, times: $times) { count } }`,
        { id: toId, times: os },
      );
    }
    return { plays: plays.length, os: os.length, chapters };
  }

  /** Stash moves the sources' scenes onto the destination and deletes the sources. */
  async mergeTags(
    config: StashAdapterBaseConfig,
    sourceIds: string[],
    destinationId: string,
  ): Promise<void> {
    await this.executeQuery(
      config,
      `mutation MergeTags($input: TagsMergeInput!) { tagsMerge(input: $input) { id } }`,
      { input: { source: sourceIds, destination: destinationId } },
      false,
    );
  }

  // ---------- broken files ----------

  /** Scenes with one kind of problem: how many, and the first few. */
  async findProblemScenes(
    config: StashAdapterBaseConfig,
    kind: StashQuickProblemKind,
    perPage = 50,
  ): Promise<{ count: number; scenes: StashProblemScene[] }> {
    const filters: Record<StashQuickProblemKind, Record<string, unknown>> = {
      'no-file': { file_count: { value: 0, modifier: 'EQUALS' } },
      'no-length': {
        file_count: { value: 0, modifier: 'GREATER_THAN' },
        duration: { value: 1, modifier: 'LESS_THAN' },
      },
      'no-cover': { is_missing: 'cover' },
      'no-fingerprint': {
        file_count: { value: 0, modifier: 'GREATER_THAN' },
        is_missing: 'phash',
      },
    };
    const payload = (await this.executeQuery(
      config,
      `query ProblemScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes { id title files { path basename } }
        }
      }`,
      {
        filter: { page: 1, per_page: perPage, sort: 'path', direction: 'ASC' },
        scene_filter: filters[kind],
      },
    )) as unknown as {
      data?: {
        findScenes?: {
          count?: unknown;
          scenes?: Array<Record<string, unknown>>;
        };
      };
    };
    const found = payload.data?.findScenes;
    return {
      count: typeof found?.count === 'number' ? found.count : 0,
      scenes: (found?.scenes ?? []).flatMap((scene) => {
        const id = this.normalizeEntityId(idText(scene['id']));
        if (!id) {
          return [];
        }
        const files = Array.isArray(scene['files'])
          ? (scene['files'] as Array<Record<string, unknown>>)
          : [];
        const path =
          typeof files[0]?.['path'] === 'string' ? files[0]['path'] : null;
        const basename =
          typeof files[0]?.['basename'] === 'string'
            ? files[0]['basename']
            : null;
        const title =
          typeof scene['title'] === 'string' && scene['title']
            ? scene['title']
            : null;
        return [
          {
            id,
            title: title ?? basename ?? `Scene ${id}`,
            path,
            fileCount: files.length,
          },
        ];
      }),
    };
  }

  /**
   * Markers whose preview clip Stash hasn't made: each is asked with a HEAD
   * (nothing downloaded), 8 at a time, up to `maxMarkers`. Returns the scenes
   * they belong to, most missing first, and how many markers were checked.
   */
  async findMarkersWithoutPreview(
    config: StashAdapterBaseConfig,
    maxMarkers = 3000,
  ): Promise<{
    missing: number;
    checked: number;
    /** Stash didn't answer for these (timed out or an error): not known either way. */
    unanswered: number;
    /** The most common reason, when some went unanswered. */
    unansweredWhy?: string;
    scenes: StashProblemScene[];
  }> {
    const payload = (await this.executeQuery(
      config,
      `query MarkerList($filter: FindFilterType) {
        findSceneMarkers(filter: $filter) {
          scene_markers { id scene { id title files { path basename } } }
        }
      }`,
      {
        filter: { per_page: maxMarkers, sort: 'created_at', direction: 'DESC' },
      },
    )) as unknown as {
      data?: {
        findSceneMarkers?: { scene_markers?: Array<Record<string, unknown>> };
      };
    };
    const markers = (
      payload.data?.findSceneMarkers?.scene_markers ?? []
    ).flatMap((marker) => {
      const id = this.normalizeEntityId(idText(marker['id']));
      const scene = marker['scene'] as
        Record<string, unknown> | null | undefined;
      const sceneId = this.normalizeEntityId(idText(scene?.['id']));
      return id && sceneId && scene ? [{ id, sceneId, scene }] : [];
    });
    const probe = await this.probeAssets(
      config,
      markers,
      (marker) => `/scene/${marker.sceneId}/scene_marker/${marker.id}/stream`,
    );
    const bySceneMissing = new Map<
      string,
      { scene: Record<string, unknown>; count: number }
    >();
    markers.forEach((marker, index) => {
      if (probe.results[index] === false) {
        const entry = bySceneMissing.get(marker.sceneId) ?? {
          scene: marker.scene,
          count: 0,
        };
        entry.count += 1;
        bySceneMissing.set(marker.sceneId, entry);
      }
    });
    let missing = 0;
    const scenes = [...bySceneMissing.entries()]
      .map(([id, { scene, count }]) => {
        missing += count;
        const files = Array.isArray(scene['files'])
          ? (scene['files'] as Array<Record<string, unknown>>)
          : [];
        const title =
          typeof scene['title'] === 'string' && scene['title']
            ? scene['title']
            : null;
        const basename =
          typeof files[0]?.['basename'] === 'string'
            ? files[0]['basename']
            : null;
        return {
          id,
          title: title ?? basename ?? `Scene ${id}`,
          path:
            typeof files[0]?.['path'] === 'string' ? files[0]['path'] : null,
          markers: count,
        };
      })
      .sort((a, b) => b.markers - a.markers);
    return {
      missing,
      checked: markers.length,
      unanswered: probe.unanswered,
      ...(probe.unansweredWhy ? { unansweredWhy: probe.unansweredWhy } : {}),
      scenes,
    };
  }

  /**
   * Scenes whose hover preview (the short clip Stash plays when you point at
   * a scene) Stash hasn't made: each asked with a HEAD, 8 at a time, newest
   * first, up to `maxScenes`. Scenes with no file are left to "no-file".
   */
  async findScenesWithoutPreview(
    config: StashAdapterBaseConfig,
    maxScenes = 20_000,
  ): Promise<{
    missing: number;
    checked: number;
    unanswered: number;
    unansweredWhy?: string;
    /** The first 50 missing, newest first. */
    scenes: StashProblemScene[];
  }> {
    const pageSize = 1000;
    const rows: Array<{ id: string; scene: Record<string, unknown> }> = [];
    for (let page = 1; rows.length < maxScenes; page += 1) {
      const payload = (await this.executeQuery(
        config,
        `query PreviewList($filter: FindFilterType) {
          findScenes(filter: $filter) {
            scenes { id title files { path basename } }
          }
        }`,
        {
          filter: {
            page,
            per_page: pageSize,
            sort: 'created_at',
            direction: 'DESC',
          },
        },
      )) as unknown as {
        data?: { findScenes?: { scenes?: Array<Record<string, unknown>> } };
      };
      const found = payload.data?.findScenes?.scenes ?? [];
      for (const scene of found) {
        const id = this.normalizeEntityId(idText(scene['id']));
        const files = Array.isArray(scene['files']) ? scene['files'] : [];
        if (id && files.length > 0 && rows.length < maxScenes) {
          rows.push({ id, scene });
        }
      }
      if (found.length < pageSize) {
        break;
      }
    }
    const probe = await this.probeAssets(
      config,
      rows,
      (row) => `/scene/${row.id}/preview`,
    );
    const missingRows = rows.filter(
      (_, index) => probe.results[index] === false,
    );
    return {
      missing: missingRows.length,
      checked: rows.length,
      unanswered: probe.unanswered,
      ...(probe.unansweredWhy ? { unansweredWhy: probe.unansweredWhy } : {}),
      scenes: missingRows.slice(0, 50).map(({ id, scene }) => {
        const files = scene['files'] as Array<Record<string, unknown>>;
        const title =
          typeof scene['title'] === 'string' && scene['title']
            ? scene['title']
            : null;
        const basename =
          typeof files[0]?.['basename'] === 'string'
            ? files[0]['basename']
            : null;
        return {
          id,
          title: title ?? basename ?? `Scene ${id}`,
          path:
            typeof files[0]?.['path'] === 'string' ? files[0]['path'] : null,
        };
      }),
    };
  }

  /**
   * Asks Stash about each file, 8 at a time: true it has it, false it
   * doesn't, a string why it didn't say. With the count and most common
   * reason of those it didn't say.
   */
  private async probeAssets<T>(
    config: StashAdapterBaseConfig,
    items: T[],
    urlOf: (item: T) => string,
  ): Promise<{
    results: Array<boolean | string>;
    unanswered: number;
    unansweredWhy?: string;
  }> {
    const results: Array<boolean | string> = new Array<boolean | string>(
      items.length,
    );
    const why = new Map<string, number>();
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const index = next++;
        const answer = await this.assetExists(config, urlOf(items[index]));
        results[index] = answer;
        if (typeof answer === 'string') {
          why.set(answer, (why.get(answer) ?? 0) + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    const unanswered = [...why.values()].reduce((sum, n) => sum + n, 0);
    const unansweredWhy = [...why.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    return {
      results,
      unanswered,
      ...(unansweredWhy ? { unansweredWhy } : {}),
    };
  }
}

/** What the duplicate and sample finders show for each scene. */
const DUPLICATE_SCENE_FIELDS = `id title date play_count organized
  paths { screenshot }
  studio { name }
  files { path basename size width height duration video_codec bit_rate frame_rate }`;

const STASH_ORGANIZER_SCENE_FIELDS = `
  id title code date organized created_at
  paths { screenshot }
  studio { id name }
  performers { name gender }
  tags { id }
  stash_ids { endpoint stash_id }
  files { id path basename duration size width height fingerprints { type value } }
`;

const STASH_GENDERS = new Set([
  'MALE',
  'FEMALE',
  'TRANSGENDER_MALE',
  'TRANSGENDER_FEMALE',
  'INTERSEX',
  'NON_BINARY',
]);

/** Stash sends ids as strings; anything else reads as no id. */
function idText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function hostLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
