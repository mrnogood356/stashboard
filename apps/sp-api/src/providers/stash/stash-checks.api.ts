import { WatchedScene } from '../../suggestions/suggestions.util';
import {
  type CatalogProviderKey,
  findCatalogExternalIdForProvider,
  normalizeCatalogSceneRefs,
} from '../catalog/catalog-provider.util';
import { StatsFile } from '../../playback/library-stats.util';
import {
  type StashAdapterBaseConfig,
  type StashCheckScene,
  type StashQuickProblemKind,
  type StashProblemScene,
} from './stash.types';
import { checkSceneOf, idText } from './stash-tools.shared';
import { StashFilesApi } from './stash-files.api';

/** Reading the whole library: problem scenes, missing previews and generated files, watch history, stats and folders. */
export abstract class StashChecksApi extends StashFilesApi {
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
      // Stash read no video stream at all: no codec, so it can't be played.
      unreadable: {
        file_count: { value: 0, modifier: 'GREATER_THAN' },
        video_codec: { value: '', modifier: 'IS_NULL' },
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
   * The library's scenes for the file-by-file checks: each scene's files
   * (path, size, date, fingerprints) and chapters, newest first, up to
   * `maxScenes`. Scenes with no file are left to "no-file".
   */
  async listScenesForChecks(
    config: StashAdapterBaseConfig,
    maxScenes = 20_000,
  ): Promise<StashCheckScene[]> {
    const pageSize = 1000;
    const rows: StashCheckScene[] = [];
    for (let page = 1; rows.length < maxScenes; page += 1) {
      const payload = (await this.executeQuery(
        config,
        `query CheckList($filter: FindFilterType) {
          findScenes(filter: $filter) {
            scenes {
              id title
              files { id path basename size mod_time fingerprints { type value } }
              scene_markers { id }
            }
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
        const row = checkSceneOf(scene, (value) =>
          this.normalizeEntityId(idText(value)),
        );
        if (row && rows.length < maxScenes) {
          rows.push(row);
        }
      }
      if (found.length < pageSize) {
        break;
      }
    }
    return rows;
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

  /**
   * What Stash's Generate makes and a scene lacks: its cover, fingerprint
   * (phash), hover preview, scrubber thumbnails, and each chapter's clip and
   * picture. Files are asked about with a HEAD, 8 at a time; nothing is
   * downloaded. Each scene listed says what it lacks.
   */
  async findGenerateGaps(
    config: StashAdapterBaseConfig,
    /** The scenes to check; read from Stash when not given. */
    scenes?: StashCheckScene[],
  ): Promise<{
    missing: number;
    checked: number;
    unanswered: number;
    unansweredWhy?: string;
    unansweredExample?: string;
    /** Up to 50, those lacking the most first. */
    scenes: StashProblemScene[];
  }> {
    const rows = scenes ?? (await this.listScenesForChecks(config));
    const coverless = await this.sceneIdsMissing(config, 'cover');
    type Ask = {
      scene: number;
      what: 'preview' | 'sprite' | 'clip' | 'picture';
    };
    const asks: Array<Ask & { url: string; placeholder?: string }> = [];
    rows.forEach((row, scene) => {
      asks.push({ scene, what: 'preview', url: `/scene/${row.id}/preview` });
      asks.push({ scene, what: 'sprite', url: `/scene/${row.id}/vtt/sprite` });
      for (const marker of row.markerIds) {
        const base = `/scene/${row.id}/scene_marker/${marker}`;
        asks.push({ scene, what: 'clip', url: `${base}/stream` });
        // A missing picture is answered with Stash's PNG placeholder.
        asks.push({
          scene,
          what: 'picture',
          url: `${base}/screenshot`,
          placeholder: 'image/png',
        });
      }
    });
    const probe = await this.probeAssets(
      config,
      asks,
      (ask) => ask.url,
      (ask) => ask.placeholder,
    );
    const lacking = rows.map(() => ({
      preview: false,
      sprite: false,
      clips: 0,
      pictures: 0,
    }));
    asks.forEach((ask, index) => {
      if (probe.results[index] !== false) {
        return;
      }
      const entry = lacking[ask.scene];
      if (ask.what === 'preview') entry.preview = true;
      if (ask.what === 'sprite') entry.sprite = true;
      if (ask.what === 'clip') entry.clips += 1;
      if (ask.what === 'picture') entry.pictures += 1;
    });
    const listed = rows.flatMap((row, index) => {
      const gaps = lacking[index];
      const chapters = row.markerIds.length;
      const problems = [
        ...(coverless.has(row.id) ? ['No cover picture.'] : []),
        ...(row.files.some((file) => !file.phash)
          ? ['No fingerprint (phash), so Duplicates can’t compare it.']
          : []),
        ...(gaps.preview
          ? ['No hover preview: nothing plays when you point at it.']
          : []),
        ...(gaps.sprite
          ? ['No scrubber thumbnails: the seek bar shows no pictures.']
          : []),
        ...(gaps.clips > 0
          ? [
              `${gaps.clips} of ${chapters} chapter${chapters === 1 ? '' : 's'} have no preview clip.`,
            ]
          : []),
        ...(gaps.pictures > 0
          ? [
              `${gaps.pictures} of ${chapters} chapter${chapters === 1 ? '' : 's'} have no picture.`,
            ]
          : []),
      ];
      return problems.length > 0 ? [{ row, problems }] : [];
    });
    listed.sort((a, b) => b.problems.length - a.problems.length);
    return {
      missing: listed.length,
      checked: rows.length,
      unanswered: probe.unanswered,
      ...(probe.unansweredWhy ? { unansweredWhy: probe.unansweredWhy } : {}),
      ...(probe.unansweredExample
        ? { unansweredExample: probe.unansweredExample }
        : {}),
      scenes: listed.slice(0, 50).map(({ row, problems }) => ({
        id: row.id,
        title: row.title,
        path: row.files[0]?.path ?? null,
        fileCount: row.files.length,
        problems,
      })),
    };
  }

  /**
   * Of these scenes, the ones Stash has no hover preview for: a definite
   * "no" from its preview address (asked with a HEAD; nothing downloaded).
   * Scenes Stash didn't answer for are listed apart, as unknown.
   */
  async scenesWithoutPreview(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
  ): Promise<{ missing: string[]; unanswered: string[] }> {
    const ids = [
      ...new Set(
        sceneIds
          .map((id) => this.normalizeEntityId(id))
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) {
      return { missing: [], unanswered: [] };
    }
    const probe = await this.probeAssets(
      config,
      ids,
      (id) => `/scene/${id}/preview`,
    );
    return {
      missing: ids.filter((_, index) => probe.results[index] === false),
      // Stash didn't answer for these (busy, timed out): neither has nor lacks.
      unanswered: ids.filter(
        (_, index) => typeof probe.results[index] === 'string',
      ),
    };
  }

  /**
   * Rescans these scenes' files with hover previews made as part of the
   * scan. Some Stash builds (0.32 development builds before the fix for
   * Stash issue #7341) make no previews from Generate at all; the scan
   * makes them. Nothing else is generated, and nothing is overwritten.
   */
  async rescanForPreviews(
    config: StashAdapterBaseConfig,
    sceneIds: string[],
  ): Promise<string | null> {
    const ids = [
      ...new Set(
        sceneIds
          .map((id) => this.normalizeEntityId(id))
          .filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) {
      return null;
    }
    const found = (await this.executeQuery(
      config,
      `query PreviewFiles($ids: [ID!]) {
        findScenes(ids: $ids, filter: { per_page: -1 }) { scenes { files { path } } }
      }`,
      { ids },
    )) as unknown as {
      data?: {
        findScenes?: { scenes?: Array<{ files?: Array<{ path?: unknown }> }> };
      };
    };
    const paths = [
      ...new Set(
        (found.data?.findScenes?.scenes ?? []).flatMap((scene) =>
          (scene.files ?? [])
            .map((file) => file.path)
            .filter(
              (path): path is string => typeof path === 'string' && !!path,
            ),
        ),
      ),
    ];
    if (paths.length === 0) {
      return null;
    }
    const payload = (await this.executeQuery(
      config,
      `mutation PreviewScan($input: ScanMetadataInput!) { metadataScan(input: $input) }`,
      {
        input: {
          paths,
          rescan: true,
          scanGenerateCovers: false,
          scanGeneratePreviews: true,
          scanGenerateImagePreviews: true,
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

  /** Ids of every scene Stash says is missing this (one query, ids only). */
  protected async sceneIdsMissing(
    config: StashAdapterBaseConfig,
    what: string,
  ): Promise<Set<string>> {
    const payload = (await this.executeQuery(
      config,
      `query Missing($scene_filter: SceneFilterType, $filter: FindFilterType) {
        findScenes(scene_filter: $scene_filter, filter: $filter) { scenes { id } }
      }`,
      { scene_filter: { is_missing: what }, filter: { per_page: -1 } },
    )) as unknown as {
      data?: { findScenes?: { scenes?: Array<Record<string, unknown>> } };
    };
    return new Set(
      (payload.data?.findScenes?.scenes ?? []).flatMap((scene) => {
        const id = this.normalizeEntityId(idText(scene['id']));
        return id ? [id] : [];
      }),
    );
  }

  /**
   * Asks Stash about each file, 8 at a time: true it has it, false it
   * doesn't, a string why it didn't say. With the count and most common
   * reason of those it didn't say.
   */
  protected async probeAssets<T>(
    config: StashAdapterBaseConfig,
    items: T[],
    urlOf: (item: T) => string,
    placeholderOf: (item: T) => string | undefined = () => undefined,
  ): Promise<{
    results: Array<boolean | string>;
    unanswered: number;
    unansweredWhy?: string;
    /** One address Stash didn't answer for, for the most common reason. */
    unansweredExample?: string;
  }> {
    const results: Array<boolean | string> = new Array<boolean | string>(
      items.length,
    );
    const ask = async (indexes: number[], workers: number) => {
      let next = 0;
      const worker = async () => {
        while (next < indexes.length) {
          const index = indexes[next++];
          results[index] = await this.assetExists(
            config,
            urlOf(items[index]),
            placeholderOf(items[index]),
          );
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));
    };
    await ask(
      items.map((_, index) => index),
      8,
    );
    // Those Stash didn't answer (busy, timed out) get one more try, two at a
    // time, once the rush is over.
    const retry = results.flatMap((answer, index) =>
      typeof answer === 'string' ? [index] : [],
    );
    if (retry.length > 0) {
      await ask(retry, 2);
    }
    const why = new Map<string, number>();
    const example = new Map<string, string>();
    results.forEach((answer, index) => {
      if (typeof answer === 'string') {
        why.set(answer, (why.get(answer) ?? 0) + 1);
        if (!example.has(answer)) {
          example.set(answer, urlOf(items[index]));
        }
      }
    });
    const unanswered = [...why.values()].reduce((sum, n) => sum + n, 0);
    const unansweredWhy = [...why.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    return {
      results,
      unanswered,
      ...(unansweredWhy
        ? {
            unansweredWhy,
            unansweredExample: example.get(unansweredWhy),
          }
        : {}),
    };
  }
}
