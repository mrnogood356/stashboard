import { Injectable } from '@nestjs/common';
import {
  type CatalogProviderKey,
  findCatalogExternalIdForProvider,
  hasCatalogSceneRef,
  normalizeCatalogSceneRefs,
} from '../catalog/catalog-provider.util';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { stashImageVersion } from './stash-image-version.util';
import {
  type StashAdapterBaseConfig,
  type StashLinkedSceneStashId,
  type StashLocalLibrarySceneItem,
  type StashLocalLibraryScenePage,
  type StashLocalLibraryScenePageConfig,
  type StashLocalPerformer,
  type StashLocalSceneCard,
  type StashLocalSceneDetails,
  type StashLocalSceneFeed,
  type StashLocalSceneFeedConfig,
  type StashLocalSceneFeedItem,
  type StashLocalScenePage,
  type StashLocalSceneRecord,
  type StashLocalSceneUpdate,
  type StashLocalStudio,
  type StashLocalStudioOption,
  type StashLocalTagOption,
  type StashProtectedAssetResponse,
  type StashSceneFeedDirection,
  type StashSceneFeedSort,
  type StashSceneMarker,
  type StashSceneCopy,
  type StashSceneMatch,
  type StashSceneMatchOverlayConfig,
  type StashScenePlayback,
  type StashScenePlaybackRecord,
  type StashStudioSearchRecord,
  type StashTagRecord,
} from './stash.types';
import { StashLibraryToolsApi } from './stash-library-tools.api';
export * from './stash.types';

@Injectable()
export class StashAdapter extends StashLibraryToolsApi {
  constructor(runtimeHealthService: RuntimeHealthService) {
    super(runtimeHealthService);
  }

  async testConnection(config: StashAdapterBaseConfig): Promise<void> {
    await this.checkConnection(config, false);
  }

  async probeConnection(config: StashAdapterBaseConfig): Promise<void> {
    await this.checkConnection(config, true);
  }

  private async checkConnection(
    config: StashAdapterBaseConfig,
    trackRuntimeHealth: boolean,
  ): Promise<void> {
    const query = `
      query ConnectivityCheck {
        __typename
      }
    `;

    await this.executeQuery(config, query, undefined, trackRuntimeHealth);
  }

  async findScenesByStashId(
    stashId: string,
    config: StashAdapterBaseConfig,
    overlays?: StashSceneMatchOverlayConfig,
  ): Promise<StashSceneMatch[]> {
    const normalizedStashId = stashId.trim();
    if (!normalizedStashId) {
      return [];
    }

    const query = `
      query FindScenes($sceneFilter: SceneFilterType) {
        findScenes(scene_filter: $sceneFilter) {
          count
          scenes {
            id
            files {
              height
              width
            }
            stash_ids {
              endpoint
              stash_id
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      sceneFilter: this.buildSceneMatchFilter(normalizedStashId, overlays),
    });

    const scenes = payload.data?.findScenes?.scenes ?? [];

    return scenes
      .map((scene) =>
        this.toSceneMatch(
          scene,
          config.baseUrl,
          normalizedStashId,
          overlays?.providerKey ?? null,
        ),
      )
      .filter((scene): scene is StashSceneMatch => scene !== null)
      .sort((a, b) => {
        const aHeight = a.height ?? 0;
        const bHeight = b.height ?? 0;
        if (bHeight !== aHeight) {
          return bHeight - aHeight;
        }

        return a.id.localeCompare(b.id);
      });
  }

  /**
   * Library scenes matching any of these scene filters (each one criterion,
   * OR-ed together), with a file path and screenshot to show them by. For
   * "you already have this": failures don't count against Stash's health.
   */
  async findSceneCopies(
    config: StashAdapterBaseConfig,
    criteria: Array<Record<string, unknown>>,
    limit = 5,
  ): Promise<StashSceneCopy[]> {
    const sceneFilter = criteria.reduceRight<Record<string, unknown> | null>(
      (rest, criterion) => (rest ? { ...criterion, OR: rest } : criterion),
      null,
    );
    if (!sceneFilter) {
      return [];
    }

    const payload = (await this.executeQuery(
      config,
      `query SceneCopies($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          scenes {
            id
            title
            date
            paths { screenshot }
            studio { name }
            files { path duration }
          }
        }
      }`,
      { filter: { per_page: limit }, scene_filter: sceneFilter },
      false,
    )) as unknown as {
      data?: { findScenes?: { scenes?: Array<Record<string, unknown>> } };
    };

    return (payload.data?.findScenes?.scenes ?? []).flatMap((scene) => {
      const id =
        typeof scene.id === 'string' || typeof scene.id === 'number'
          ? this.normalizeEntityId(String(scene.id))
          : null;
      const files = Array.isArray(scene.files)
        ? (scene.files as Array<Record<string, unknown>>)
        : [];
      // A scene with no file isn't a copy you have.
      if (!id || files.length === 0) {
        return [];
      }
      const studio = scene.studio as Record<string, unknown> | null | undefined;
      const paths = scene.paths as Record<string, unknown> | null | undefined;
      return [
        {
          id,
          title: this.normalizeOptionalString(scene.title),
          date: this.normalizeOptionalString(scene.date),
          studioName: this.normalizeOptionalString(studio?.name),
          path: this.normalizeOptionalString(files[0]?.path),
          duration:
            typeof files[0]?.duration === 'number' ? files[0].duration : null,
          screenshotVersion: stashImageVersion(paths?.screenshot),
        },
      ];
    });
  }

  async getLocalSceneFeed(
    config: StashAdapterBaseConfig,
    feedConfig: StashLocalSceneFeedConfig,
  ): Promise<StashLocalSceneFeed> {
    const page = this.normalizePositiveInteger(feedConfig.page, 1);
    const perPage = this.normalizePositiveInteger(feedConfig.perPage, 16);
    const sort = this.resolveFeedSort(feedConfig.sort);
    const direction = this.resolveFeedDirection(feedConfig.direction);
    const sceneFilter = this.buildSceneFilter(feedConfig);

    const query = `
      query FindScenes($filter: FindFilterType, $sceneFilter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $sceneFilter) {
          count
          scenes {
            id
            title
            details
            date
            paths {
              screenshot
            }
            studio {
              id
              name
              image_path
            }
            files {
              width
              height
              duration
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      filter: {
        page,
        per_page: perPage,
        sort,
        direction,
      },
      sceneFilter,
    });

    const scenes = payload.data?.findScenes?.scenes ?? [];
    const total =
      typeof payload.data?.findScenes?.count === 'number'
        ? payload.data.findScenes.count
        : 0;

    return {
      total,
      items: scenes
        .map((scene) => this.toLocalSceneFeedItem(scene, config.baseUrl))
        .filter((scene): scene is StashLocalSceneFeedItem => scene !== null),
    };
  }

  /**
   * Library scenes by playback: never played (newest first) or most played.
   * Uses Stash's own play counts, so it reflects what was watched in Stash.
   */
  async getLocalScenesByPlayback(
    config: StashAdapterBaseConfig,
    mode: 'UNWATCHED' | 'MOST_PLAYED',
    limit: number,
  ): Promise<StashLocalSceneFeedItem[]> {
    const perPage = this.normalizePositiveInteger(limit, 16);
    const query = `
      query FindScenesByPlayback($filter: FindFilterType, $sceneFilter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $sceneFilter) {
          scenes {
            id
            title
            details
            date
            paths {
              screenshot
            }
            studio {
              id
              name
              image_path
            }
            files {
              width
              height
              duration
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      filter: {
        page: 1,
        per_page: perPage,
        sort: mode === 'MOST_PLAYED' ? 'play_count' : 'created_at',
        direction: 'DESC',
      },
      sceneFilter: {
        play_count:
          mode === 'MOST_PLAYED'
            ? { value: 0, modifier: 'GREATER_THAN' }
            : { value: 0, modifier: 'EQUALS' },
      },
    });

    const scenes = payload.data?.findScenes?.scenes ?? [];
    return scenes
      .map((scene) => this.toLocalSceneFeedItem(scene, config.baseUrl))
      .filter((scene): scene is StashLocalSceneFeedItem => scene !== null);
  }

  /** Everything the player needs for one library scene, in one GraphQL call. */
  async getScenePlayback(
    config: StashAdapterBaseConfig,
    sceneId: string,
  ): Promise<StashScenePlayback | null> {
    const normalizedSceneId = this.normalizeEntityId(sceneId);
    if (!normalizedSceneId) {
      return null;
    }

    const query = `
      query ScenePlayback($id: ID!) {
        findScene(id: $id) {
          id
          title
          resume_time
          play_count
          paths {
            screenshot
            vtt
          }
          studio {
            name
          }
          scene_markers {
            id
            title
            seconds
            primary_tag {
              name
            }
          }
          files {
            duration
            width
            height
            video_codec
            audio_codec
            format
          }
        }
        sceneStreams(id: $id) {
          url
          mime_type
          label
        }
      }
    `;

    const payload = (await this.executeQuery(config, query, {
      id: normalizedSceneId,
    })) as unknown as {
      data?: {
        findScene?: StashScenePlaybackRecord | null;
        sceneStreams?: Array<{
          url?: unknown;
          mime_type?: unknown;
          label?: unknown;
        }>;
      };
    };
    const scene = payload.data?.findScene;
    if (!scene || typeof scene.id !== 'string') {
      return null;
    }

    const file = (scene.files ?? [])[0] ?? {};
    return {
      id: scene.id,
      title:
        typeof scene.title === 'string' && scene.title.trim()
          ? scene.title.trim()
          : `Scene #${scene.id}`,
      studio: typeof scene.studio?.name === 'string' ? scene.studio.name : null,
      resumeTime: typeof scene.resume_time === 'number' ? scene.resume_time : 0,
      playCount: typeof scene.play_count === 'number' ? scene.play_count : 0,
      duration: typeof file.duration === 'number' ? file.duration : null,
      width: typeof file.width === 'number' ? file.width : null,
      height: typeof file.height === 'number' ? file.height : null,
      videoCodec:
        typeof file.video_codec === 'string' ? file.video_codec : null,
      audioCodec:
        typeof file.audio_codec === 'string' ? file.audio_codec : null,
      container: typeof file.format === 'string' ? file.format : null,
      vttPath: typeof scene.paths?.vtt === 'string' ? scene.paths.vtt : null,
      screenshotVersion: stashImageVersion(scene.paths?.screenshot),
      streams: payload.data?.sceneStreams ?? [],
      markers: this.toMarkers(scene.scene_markers),
      viewUrl: this.resolveSceneViewUrl(config.baseUrl, scene.id),
    };
  }

  /** Everything the local scene page shows for one Stash scene. */
  async getLocalSceneDetails(
    config: StashAdapterBaseConfig,
    sceneId: string,
  ): Promise<StashLocalSceneDetails | null> {
    const normalizedSceneId = this.normalizeEntityId(sceneId);
    if (!normalizedSceneId) {
      return null;
    }

    const query = `
      query LocalSceneDetails($id: ID!) {
        findScene(id: $id) {
          id
          title
          code
          details
          date
          rating100
          o_counter
          play_count
          resume_time
          organized
          paths {
            screenshot
          }
          studio {
            id
            name
            image_path
          }
          performers {
            id
            name
            gender
            favorite
            image_path
          }
          tags {
            id
            name
          }
          scene_markers {
            id
            title
            seconds
            primary_tag {
              name
            }
          }
          files {
            basename
            size
            duration
            width
            height
            video_codec
            audio_codec
            format
            frame_rate
            bit_rate
          }
        }
      }
    `;

    const payload = (await this.executeQuery(config, query, {
      id: normalizedSceneId,
    })) as unknown as { data?: { findScene?: Record<string, unknown> | null } };
    const scene = payload.data?.findScene;
    const id = this.normalizeOptionalString(scene?.id);
    if (!scene || !id) {
      return null;
    }

    const num = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const str = (value: unknown): string | null =>
      this.normalizeOptionalString(value);
    const list = (value: unknown): Array<Record<string, unknown>> =>
      Array.isArray(value)
        ? value.filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === 'object' && entry !== null,
          )
        : [];

    const studio = scene.studio as Record<string, unknown> | null | undefined;
    const studioId = str(studio?.id);
    const studioName = str(studio?.name);
    const paths = scene.paths as Record<string, unknown> | null | undefined;

    return {
      id,
      title: str(scene.title) ?? `Scene #${id}`,
      code: str(scene.code),
      details: str(scene.details),
      date: str(scene.date),
      rating100: num(scene.rating100),
      oCounter: num(scene.o_counter) ?? 0,
      playCount: num(scene.play_count) ?? 0,
      resumeTime: num(scene.resume_time) ?? 0,
      organized: scene.organized === true,
      screenshotVersion: stashImageVersion(paths?.screenshot),
      studio:
        studioId && studioName
          ? {
              id: studioId,
              name: studioName,
              imageVersion: stashImageVersion(studio?.image_path, {
                realOnly: true,
              }),
            }
          : null,
      performers: list(scene.performers).flatMap((performer) => {
        const performerId = str(performer.id);
        const name = str(performer.name);
        return performerId && name
          ? [
              {
                id: performerId,
                name,
                gender: str(performer.gender),
                favorite: performer.favorite === true,
                imageVersion: stashImageVersion(performer.image_path, {
                  realOnly: true,
                }),
              },
            ]
          : [];
      }),
      tags: list(scene.tags).flatMap((tag) => {
        const tagId = str(tag.id);
        const name = str(tag.name);
        return tagId && name ? [{ id: tagId, name }] : [];
      }),
      markers: this.toMarkers(scene.scene_markers),
      files: list(scene.files).map((file) => ({
        basename: str(file.basename),
        size:
          num(file.size) ??
          (typeof file.size === 'string' ? Number(file.size) || null : null),
        duration: num(file.duration),
        width: num(file.width),
        height: num(file.height),
        videoCodec: str(file.video_codec),
        audioCodec: str(file.audio_codec),
        container: str(file.format),
        frameRate: num(file.frame_rate),
        bitRate: num(file.bit_rate),
      })),
      viewUrl: this.resolveSceneViewUrl(config.baseUrl, id),
    };
  }

  async openPerformerImage(
    performerId: string,
    config: StashAdapterBaseConfig,
  ): Promise<StashProtectedAssetResponse | null> {
    const normalizedPerformerId = this.normalizeEntityId(performerId);
    if (!normalizedPerformerId) {
      return null;
    }

    const payload = await this.executeQuery(
      config,
      `query FindPerformer($id: ID!) { findPerformer(id: $id) { id image_path } }`,
      { id: normalizedPerformerId },
    );
    const imageUrl = this.parseAssetUrl(
      (
        payload.data as
          { findPerformer?: { image_path?: unknown } | null } | undefined
      )?.findPerformer?.image_path,
    );
    if (!imageUrl) {
      return null;
    }

    return this.fetchProtectedAsset(config, imageUrl);
  }

  // ---------- local library: organize, browse, related ----------

  /** Rating, organized flag and tags, saved straight to Stash. */
  async updateLocalScene(
    config: StashAdapterBaseConfig,
    sceneId: string,
    update: StashLocalSceneUpdate,
  ): Promise<void> {
    const id = this.normalizeEntityId(sceneId);
    if (!id) {
      return;
    }
    const input: Record<string, unknown> = { id };
    if (update.rating100 !== undefined) {
      input['rating100'] = update.rating100;
    }
    if (update.organized !== undefined) {
      input['organized'] = update.organized;
    }
    if (update.tagIds !== undefined) {
      input['tag_ids'] = update.tagIds;
    }
    await this.executeQuery(
      config,
      `mutation UpdateScene($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
      { input },
      false,
    );
  }

  /** Watched adds a play; unwatched clears the play count. Both clear the resume point. */
  async setSceneWatched(
    config: StashAdapterBaseConfig,
    sceneId: string,
    watched: boolean,
  ): Promise<void> {
    const id = this.normalizeEntityId(sceneId);
    if (!id) {
      return;
    }
    if (watched) {
      await this.addScenePlay(config, id);
    } else {
      try {
        await this.executeQuery(
          config,
          `mutation ResetPlays($id: ID!) { sceneResetPlayCount(id: $id) }`,
          { id },
          false,
        );
      } catch (error) {
        if (
          !/sceneResetPlayCount|Cannot query field|Unknown field/i.test(
            this.errorMessage(error),
          )
        ) {
          throw error;
        }
        // Older Stash keeps the count on the scene itself.
        await this.executeQuery(
          config,
          `mutation ClearPlays($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
          { input: { id, play_count: 0 } },
          false,
        );
      }
    }
    await this.saveSceneActivity(config, id, 0, 0);
  }

  /** One page of library scenes, filtered with a Stash scene filter. */
  async findLocalScenes(
    config: StashAdapterBaseConfig,
    options: {
      page: number;
      perPage: number;
      sort: string;
      direction: 'ASC' | 'DESC';
      sceneFilter: Record<string, unknown>;
    },
  ): Promise<StashLocalScenePage> {
    const payload = (await this.executeQuery(
      config,
      `query LocalScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes {
            id
            title
            date
            play_count
            resume_time
            paths {
              screenshot
            }
            studio {
              id
              name
              image_path
            }
            files {
              duration
            }
          }
        }
      }`,
      {
        filter: {
          page: Math.max(1, Math.floor(options.page)),
          per_page: Math.min(100, Math.max(1, Math.floor(options.perPage))),
          sort: options.sort,
          direction: options.direction,
        },
        scene_filter: options.sceneFilter,
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
    return {
      total: typeof result?.count === 'number' ? result.count : 0,
      items: (result?.scenes ?? []).flatMap((scene) => {
        const card = this.toLocalSceneCard(scene);
        return card ? [card] : [];
      }),
    };
  }

  async getLocalPerformer(
    config: StashAdapterBaseConfig,
    performerId: string,
  ): Promise<StashLocalPerformer | null> {
    const id = this.normalizeEntityId(performerId);
    if (!id) {
      return null;
    }
    const full = `id name disambiguation gender birthdate country details favorite image_path scene_count`;
    const basic = `id name gender favorite image_path scene_count`;
    const performer = await this.queryWithFallback(
      config,
      (fields) =>
        `query LocalPerformer($id: ID!) { findPerformer(id: $id) { ${fields} } }`,
      [full, basic],
      { id },
      (data) =>
        (data as { findPerformer?: Record<string, unknown> | null })
          .findPerformer,
    );
    const name = this.normalizeOptionalString(performer?.name);
    if (!performer || !name) {
      return null;
    }
    const str = (value: unknown) => this.normalizeOptionalString(value);
    return {
      id,
      name,
      disambiguation: str(performer.disambiguation),
      gender: str(performer.gender),
      birthdate: str(performer.birthdate),
      country: str(performer.country),
      details: str(performer.details),
      favorite: performer.favorite === true,
      imageVersion: stashImageVersion(performer.image_path, { realOnly: true }),
      sceneCount:
        typeof performer.scene_count === 'number' ? performer.scene_count : 0,
    };
  }

  async getLocalStudio(
    config: StashAdapterBaseConfig,
    studioId: string,
  ): Promise<StashLocalStudio | null> {
    const id = this.normalizeEntityId(studioId);
    if (!id) {
      return null;
    }
    const full = `id name favorite image_path scene_count parent_studio { id name } child_studios { id name }`;
    const basic = `id name image_path scene_count parent_studio { id name } child_studios { id name }`;
    const studio = await this.queryWithFallback(
      config,
      (fields) =>
        `query LocalStudio($id: ID!) { findStudio(id: $id) { ${fields} } }`,
      [full, basic],
      { id },
      (data) =>
        (data as { findStudio?: Record<string, unknown> | null }).findStudio,
    );
    const name = this.normalizeOptionalString(studio?.name);
    if (!studio || !name) {
      return null;
    }
    const ref = (value: unknown) => {
      const entry = value as
        { id?: unknown; name?: unknown } | null | undefined;
      const refId = this.normalizeOptionalString(entry?.id);
      const refName = this.normalizeOptionalString(entry?.name);
      return refId && refName ? { id: refId, name: refName } : null;
    };
    return {
      id,
      name,
      favorite: studio.favorite === true,
      imageVersion: stashImageVersion(studio.image_path, { realOnly: true }),
      sceneCount:
        typeof studio.scene_count === 'number' ? studio.scene_count : 0,
      parent: ref(studio.parent_studio),
      children: Array.isArray(studio.child_studios)
        ? studio.child_studios.flatMap((child) => {
            const entry = ref(child);
            return entry ? [entry] : [];
          })
        : [],
    };
  }

  async setPerformerFavorite(
    config: StashAdapterBaseConfig,
    performerId: string,
    favorite: boolean,
  ): Promise<void> {
    const id = this.normalizeEntityId(performerId);
    if (!id) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation FavoritePerformer($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }`,
      { input: { id, favorite } },
      false,
    );
  }

  async setStudioFavorite(
    config: StashAdapterBaseConfig,
    studioId: string,
    favorite: boolean,
  ): Promise<void> {
    const id = this.normalizeEntityId(studioId);
    if (!id) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation FavoriteStudio($input: StudioUpdateInput!) { studioUpdate(input: $input) { id } }`,
      { input: { id, favorite } },
      false,
    );
  }

  async openSceneMarkerScreenshot(
    config: StashAdapterBaseConfig,
    sceneId: string,
    markerId: string,
  ): Promise<StashProtectedAssetResponse | null> {
    const scene = this.normalizeEntityId(sceneId);
    const marker = this.normalizeEntityId(markerId);
    if (!scene || !marker) {
      return null;
    }
    return this.fetchProtectedAsset(
      config,
      `/scene/${scene}/scene_marker/${marker}/screenshot`,
    );
  }

  /** Library performers and studios whose names match, most scenes first. */
  async searchLocalPeople(
    config: StashAdapterBaseConfig,
    query: string,
  ): Promise<{
    performers: Array<{
      id: string;
      name: string;
      imageVersion: string | null;
      sceneCount: number;
      favorite: boolean;
    }>;
    studios: Array<{
      id: string;
      name: string;
      imageVersion: string | null;
      sceneCount: number;
    }>;
  }> {
    const q = query.trim().slice(0, 100);
    if (!q) {
      return { performers: [], studios: [] };
    }
    const payload = (await this.executeQuery(
      config,
      `query SearchPeople($filter: FindFilterType) {
        findPerformers(filter: $filter) {
          performers { id name image_path scene_count favorite }
        }
        findStudios(filter: $filter) {
          studios { id name image_path scene_count }
        }
      }`,
      {
        filter: {
          q,
          page: 1,
          per_page: 12,
          sort: 'scenes_count',
          direction: 'DESC',
        },
      },
    )) as unknown as {
      data?: {
        findPerformers?: { performers?: Array<Record<string, unknown>> };
        findStudios?: { studios?: Array<Record<string, unknown>> };
      };
    };
    const count = (value: unknown) => (typeof value === 'number' ? value : 0);
    return {
      performers: (payload.data?.findPerformers?.performers ?? []).flatMap(
        (entry) => {
          const id = this.normalizeOptionalString(entry.id);
          const name = this.normalizeOptionalString(entry.name);
          return id && name
            ? [
                {
                  id,
                  name,
                  imageVersion: stashImageVersion(entry.image_path, {
                    realOnly: true,
                  }),
                  sceneCount: count(entry.scene_count),
                  favorite: entry.favorite === true,
                },
              ]
            : [];
        },
      ),
      studios: (payload.data?.findStudios?.studios ?? []).flatMap((entry) => {
        const id = this.normalizeOptionalString(entry.id);
        const name = this.normalizeOptionalString(entry.name);
        return id && name
          ? [
              {
                id,
                name,
                imageVersion: stashImageVersion(entry.image_path, {
                  realOnly: true,
                }),
                sceneCount: count(entry.scene_count),
              },
            ]
          : [];
      }),
    };
  }

  /** Adds a chapter (scene marker). Stash requires a primary tag for every marker. */
  async createSceneMarker(
    config: StashAdapterBaseConfig,
    sceneId: string,
    marker: { title: string; seconds: number; primaryTagId: string },
  ): Promise<void> {
    const scene = this.normalizeEntityId(sceneId);
    const tag = this.normalizeEntityId(marker.primaryTagId);
    if (!scene || !tag) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation AddMarker($input: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $input) { id } }`,
      {
        input: {
          scene_id: scene,
          title: marker.title,
          seconds: Math.max(0, marker.seconds),
          primary_tag_id: tag,
        },
      },
      false,
    );
  }

  async deleteSceneMarker(
    config: StashAdapterBaseConfig,
    markerId: string,
  ): Promise<void> {
    const id = this.normalizeEntityId(markerId);
    if (!id) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation DeleteMarker($id: ID!) { sceneMarkerDestroy(id: $id) }`,
      { id },
      false,
    );
  }

  // ---------- library tools: jobs, identify, duplicates ----------

  private toLocalSceneCard(
    scene: Record<string, unknown>,
  ): StashLocalSceneCard | null {
    const id = this.normalizeOptionalString(scene.id);
    if (!id) {
      return null;
    }
    const studio = scene.studio as Record<string, unknown> | null | undefined;
    const studioId = this.normalizeOptionalString(studio?.id);
    const studioName = this.normalizeOptionalString(studio?.name);
    const paths = scene.paths as Record<string, unknown> | null | undefined;
    const files = Array.isArray(scene.files)
      ? (scene.files as Array<Record<string, unknown>>)
      : [];
    const duration = files.find(
      (file) => typeof file?.duration === 'number',
    )?.duration;
    return {
      id,
      title: this.normalizeOptionalString(scene.title) ?? `Scene #${id}`,
      date: this.normalizeOptionalString(scene.date),
      screenshotVersion: stashImageVersion(paths?.screenshot),
      studio:
        studioId && studioName
          ? {
              id: studioId,
              name: studioName,
              imageVersion: stashImageVersion(studio?.image_path, {
                realOnly: true,
              }),
            }
          : null,
      duration: typeof duration === 'number' ? duration : null,
      playCount: typeof scene.play_count === 'number' ? scene.play_count : 0,
      resumeTime: typeof scene.resume_time === 'number' ? scene.resume_time : 0,
    };
  }

  private toMarkers(value: unknown): StashSceneMarker[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .flatMap((entry) => {
        const marker = entry as Record<string, unknown> | null;
        const id = this.normalizeOptionalString(marker?.id);
        const seconds =
          typeof marker?.seconds === 'number' ? marker.seconds : null;
        if (!id || seconds === null || seconds < 0) {
          return [];
        }
        const tag = marker?.primary_tag as
          { name?: unknown } | null | undefined;
        const title =
          this.normalizeOptionalString(marker?.title) ??
          this.normalizeOptionalString(tag?.name) ??
          'Chapter';
        return [{ id, title, seconds }];
      })
      .sort((left, right) => left.seconds - right.seconds);
  }

  /** Stash adds default=true to image paths when nothing was uploaded. */
  /** Saves where playback stopped, and adds the seconds watched since the last save. */
  async saveSceneActivity(
    config: StashAdapterBaseConfig,
    sceneId: string,
    resumeTime: number,
    playDuration: number,
  ): Promise<void> {
    const normalizedSceneId = this.normalizeEntityId(sceneId);
    if (!normalizedSceneId) {
      return;
    }

    await this.executeQuery(
      config,
      `mutation SaveActivity($id: ID!, $resume: Float, $played: Float) {
        sceneSaveActivity(id: $id, resume_time: $resume, playDuration: $played)
      }`,
      { id: normalizedSceneId, resume: resumeTime, played: playDuration },
      false,
    );
  }

  /** Records one play. Uses sceneAddPlay, or the older sceneIncrementPlayCount on older Stash. */
  async addScenePlay(
    config: StashAdapterBaseConfig,
    sceneId: string,
  ): Promise<void> {
    const normalizedSceneId = this.normalizeEntityId(sceneId);
    if (!normalizedSceneId) {
      return;
    }

    try {
      await this.executeQuery(
        config,
        `mutation AddPlay($id: ID!) { sceneAddPlay(id: $id) { count } }`,
        { id: normalizedSceneId },
        false,
      );
    } catch (error) {
      const message = this.errorMessage(error);
      if (!/sceneAddPlay|Cannot query field|Unknown field/i.test(message)) {
        throw error;
      }
      await this.executeQuery(
        config,
        `mutation IncrementPlay($id: ID!) { sceneIncrementPlayCount(id: $id) }`,
        { id: normalizedSceneId },
        false,
      );
    }
  }

  /** Library scenes started but not finished, most recently watched first. */
  async getScenesInProgress(
    config: StashAdapterBaseConfig,
    limit: number,
  ): Promise<Array<StashLocalSceneFeedItem & { resumeTime: number }>> {
    const perPage = this.normalizePositiveInteger(limit, 16);
    const query = `
      query ScenesInProgress($filter: FindFilterType, $sceneFilter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $sceneFilter) {
          scenes {
            id
            title
            details
            date
            resume_time
            paths {
              screenshot
            }
            studio {
              id
              name
              image_path
            }
            files {
              width
              height
              duration
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      filter: {
        page: 1,
        per_page: perPage,
        sort: 'last_played_at',
        direction: 'DESC',
      },
      sceneFilter: { resume_time: { value: 0, modifier: 'GREATER_THAN' } },
    });

    const scenes = (payload.data?.findScenes?.scenes ?? []) as Array<
      StashLocalSceneRecord & { resume_time?: unknown }
    >;
    return scenes
      .map((scene) => {
        const item = this.toLocalSceneFeedItem(scene, config.baseUrl);
        return item
          ? {
              ...item,
              resumeTime:
                typeof scene.resume_time === 'number' ? scene.resume_time : 0,
            }
          : null;
      })
      .filter(
        (item): item is StashLocalSceneFeedItem & { resumeTime: number } =>
          item !== null,
      );
  }

  /**
   * Opens a stream path below Stash's /scene/ without buffering it, forwarding
   * Range so seeking works. The caller pipes the body and aborts via `signal`.
   */
  async openSceneStream(
    config: StashAdapterBaseConfig,
    stashPath: string,
    query: URLSearchParams,
    requestHeaders: { range?: string; forwardedPrefix?: string },
    signal: AbortSignal,
  ): Promise<Response> {
    const base = new URL(config.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const target = new URL(`${basePath}/scene/${stashPath}`, base.origin);
    query.forEach((value, key) => target.searchParams.set(key, value));

    const headers: Record<string, string> = {};
    if (requestHeaders.forwardedPrefix) {
      headers['X-Forwarded-Prefix'] = requestHeaders.forwardedPrefix;
    }
    if (config.apiKey?.trim()) {
      headers.ApiKey = config.apiKey.trim();
    }
    if (requestHeaders.range) {
      headers.Range = requestHeaders.range;
    }

    return fetch(target, { headers, signal, redirect: 'manual' });
  }

  async getLocalLibraryScenePage(
    config: StashAdapterBaseConfig,
    pageConfig: StashLocalLibraryScenePageConfig,
    activeCatalogProviderKey?: CatalogProviderKey | null,
  ): Promise<StashLocalLibraryScenePage> {
    const page = this.normalizePositiveInteger(pageConfig.page, 1);
    const perPage = this.normalizePositiveInteger(pageConfig.perPage, 100);

    const query = `
      query FindScenes($filter: FindFilterType) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            details
            date
            created_at
            updated_at
            stash_ids {
              endpoint
              stash_id
            }
            paths {
              screenshot
            }
            studio {
              id
              name
              image_path
              favorite
            }
            performers {
              id
              name
              favorite
            }
            tags {
              id
              name
              favorite
            }
            files {
              duration
            }
          }
        }
      }
    `;

    // Oldest first: a scene added mid-sync lands on the last page. Sorting by
    // updated_at would move any scene edited mid-sync (a scan, a rename) to
    // page 1, shift the rest down one, and skip the scene at a page boundary,
    // which then looks deleted until the next sync.
    const payload = await this.executeQuery(config, query, {
      filter: {
        page,
        per_page: perPage,
        sort: 'created_at',
        direction: 'ASC',
      },
    });

    const scenes = payload.data?.findScenes?.scenes ?? [];
    const total =
      typeof payload.data?.findScenes?.count === 'number'
        ? payload.data.findScenes.count
        : 0;

    return {
      total,
      page,
      perPage,
      hasMore: page * perPage < total,
      items: scenes
        .map((scene) =>
          this.toLocalLibrarySceneItem(
            scene,
            config.baseUrl,
            activeCatalogProviderKey ?? null,
          ),
        )
        .filter((scene): scene is StashLocalLibrarySceneItem => scene !== null),
    };
  }

  /**
   * A cheap fingerprint of the library: the scene count plus the most recently
   * changed scene. It moves whenever a scene is added, removed or updated, so a
   * caller can skip a full library sync while it stays the same.
   */
  async getLibraryChangeMarker(
    config: StashAdapterBaseConfig,
  ): Promise<string> {
    const query = `
      query LibraryChangeMarker($filter: FindFilterType) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            updated_at
          }
        }
      }
    `;
    const payload = await this.executeQuery(config, query, {
      filter: { page: 1, per_page: 1, sort: 'updated_at', direction: 'DESC' },
    });
    const found = payload.data?.findScenes;
    const latest: unknown = found?.scenes?.[0];
    const field = (key: string): string => {
      const value =
        latest && typeof latest === 'object'
          ? (latest as Record<string, unknown>)[key]
          : null;
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    };
    const count = typeof found?.count === 'number' ? found.count : 0;
    return `${count}|${field('id')}|${field('updated_at')}`;
  }

  async searchTags(
    query: string,
    config: StashAdapterBaseConfig,
  ): Promise<StashLocalTagOption[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const gql = `
      query FindTags($filter: FindFilterType) {
        findTags(filter: $filter) {
          tags {
            id
            name
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, gql, {
      filter: {
        q: normalizedQuery,
        page: 1,
        per_page: 25,
      },
    });

    return (payload.data?.findTags?.tags ?? [])
      .map((tag) => this.toTagOption(tag))
      .filter((tag): tag is StashLocalTagOption => tag !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async searchStudios(
    query: string,
    config: StashAdapterBaseConfig,
  ): Promise<StashLocalStudioOption[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const gql = `
      query FindStudios($filter: FindFilterType) {
        findStudios(filter: $filter) {
          studios {
            id
            name
            parent_studio {
              id
              name
            }
            child_studios {
              id
              name
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, gql, {
      filter: {
        q: normalizedQuery,
        page: 1,
        per_page: 25,
      },
    });

    return this.toStudioOptions(payload.data?.findStudios?.studios ?? []);
  }

  async openSceneScreenshot(
    sceneId: string,
    config: StashAdapterBaseConfig,
  ): Promise<StashProtectedAssetResponse | null> {
    const normalizedSceneId = this.normalizeEntityId(sceneId);
    if (!normalizedSceneId) {
      return null;
    }

    const query = `
      query FindScene($id: ID!) {
        findScene(id: $id) {
          id
          paths {
            screenshot
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      id: normalizedSceneId,
    });
    const screenshotUrl = this.parseAssetUrl(
      payload.data?.findScene?.paths?.screenshot,
    );
    if (!screenshotUrl) {
      return null;
    }

    return this.fetchProtectedAsset(config, screenshotUrl);
  }

  async openStudioLogo(
    studioId: string,
    config: StashAdapterBaseConfig,
  ): Promise<StashProtectedAssetResponse | null> {
    const normalizedStudioId = this.normalizeEntityId(studioId);
    if (!normalizedStudioId) {
      return null;
    }

    const query = `
      query FindStudio($id: ID!) {
        findStudio(id: $id) {
          id
          image_path
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      id: normalizedStudioId,
    });
    const imageUrl = this.parseAssetUrl(payload.data?.findStudio?.image_path);
    if (!imageUrl) {
      return null;
    }

    return this.fetchProtectedAsset(config, imageUrl);
  }

  private pickBestResolution(
    files: Array<{ width?: unknown; height?: unknown }>,
  ): { width: number | null; height: number | null } {
    if (files.length === 0) {
      return { width: null, height: null };
    }

    return files.reduce<{ width: number | null; height: number | null }>(
      (best, file) => {
        const width = typeof file.width === 'number' ? file.width : null;
        const height = typeof file.height === 'number' ? file.height : null;
        const bestHeight = best.height ?? 0;
        const currentHeight = height ?? 0;

        if (currentHeight > bestHeight) {
          return { width, height };
        }

        if (currentHeight === bestHeight) {
          const bestWidth = best.width ?? 0;
          const currentWidth = width ?? 0;
          if (currentWidth > bestWidth) {
            return { width, height };
          }
        }

        return best;
      },
      { width: null, height: null },
    );
  }

  private buildSceneLabel(id: string, height: number | null): string {
    if (height && height > 0) {
      return `${height}p`;
    }

    return `Scene #${id}`;
  }

  private toLocalSceneFeedItem(
    scene: StashLocalSceneRecord,
    baseUrl: string,
  ): StashLocalSceneFeedItem | null {
    if (typeof scene.id !== 'string' || scene.id.trim().length === 0) {
      return null;
    }

    const title =
      typeof scene.title === 'string' && scene.title.trim().length > 0
        ? scene.title.trim()
        : `Scene #${scene.id}`;
    const description =
      typeof scene.details === 'string' && scene.details.trim().length > 0
        ? scene.details.trim()
        : null;
    const releaseDate =
      typeof scene.date === 'string' && scene.date.trim().length > 0
        ? scene.date.trim()
        : null;
    const imageUrl =
      scene.paths &&
      typeof scene.paths.screenshot === 'string' &&
      scene.paths.screenshot.trim().length > 0
        ? scene.paths.screenshot.trim()
        : null;
    const studioId =
      scene.studio &&
      typeof scene.studio.id === 'string' &&
      scene.studio.id.trim().length > 0
        ? scene.studio.id.trim()
        : null;
    const studio =
      scene.studio &&
      typeof scene.studio.name === 'string' &&
      scene.studio.name.trim().length > 0
        ? scene.studio.name.trim()
        : null;
    const studioImageUrl =
      scene.studio &&
      typeof scene.studio.image_path === 'string' &&
      scene.studio.image_path.trim().length > 0
        ? scene.studio.image_path.trim()
        : null;
    const duration = this.pickFirstDuration(scene.files ?? []);

    return {
      id: scene.id,
      title,
      description,
      imageUrl,
      cardImageUrl: imageUrl,
      studioId,
      studio,
      studioImageUrl,
      releaseDate,
      duration,
      viewUrl: this.resolveSceneViewUrl(baseUrl, scene.id),
    };
  }

  private toLinkedSceneStashId(value: {
    endpoint?: unknown;
    stash_id?: unknown;
  }): StashLinkedSceneStashId | null {
    const endpoint = this.normalizeOptionalString(value.endpoint);
    const stashId = this.normalizeOptionalString(value.stash_id);
    if (!endpoint || !stashId) {
      return null;
    }

    return {
      endpoint,
      stashId,
    };
  }

  private toLocalLibrarySceneItem(
    scene: StashLocalSceneRecord,
    baseUrl: string,
    activeCatalogProviderKey: CatalogProviderKey | null,
  ): StashLocalLibrarySceneItem | null {
    const id = this.normalizeOptionalString(scene.id);
    if (!id) {
      return null;
    }

    const linkedEntries = Array.isArray(scene.stash_ids)
      ? scene.stash_ids
          .map((entry) => this.toLinkedSceneStashId(entry))
          .filter((entry): entry is StashLinkedSceneStashId => entry !== null)
      : [];
    const linkedCatalogRefs = this.toLinkedCatalogRefs(linkedEntries);
    const performers = this.toNamedEntities(scene.performers ?? []);
    const tags = this.toNamedEntities(scene.tags ?? []);
    const duration = this.pickFirstDuration(scene.files ?? []);

    return {
      id,
      activeCatalogSceneId: activeCatalogProviderKey
        ? findCatalogExternalIdForProvider(
            linkedCatalogRefs,
            activeCatalogProviderKey,
          )
        : null,
      hasFile: Array.isArray(scene.files) && scene.files.length > 0,
      linkedCatalogRefs,
      title: this.normalizeOptionalString(scene.title) ?? `Scene #${id}`,
      description: this.normalizeOptionalString(scene.details),
      imageUrl: this.parseAssetUrl(scene.paths?.screenshot),
      studioId: this.normalizeOptionalString(scene.studio?.id),
      studio: this.normalizeOptionalString(scene.studio?.name),
      studioImageUrl: this.normalizeOptionalString(scene.studio?.image_path),
      performerIds: performers.ids,
      performerNames: performers.names,
      tagIds: tags.ids,
      tagNames: tags.names,
      releaseDate: this.normalizeOptionalString(scene.date),
      duration,
      viewUrl: this.resolveSceneViewUrl(baseUrl, id),
      createdAt: this.parseOptionalDate(scene.created_at),
      updatedAt: this.parseOptionalDate(scene.updated_at),
      hasFavoritePerformer: Array.isArray(scene.performers)
        ? scene.performers.some((performer) => performer?.favorite === true)
        : false,
      favoriteStudio: scene.studio?.favorite === true,
      hasFavoriteTag: Array.isArray(scene.tags)
        ? scene.tags.some((tag) => tag?.favorite === true)
        : false,
    };
  }

  private toSceneMatch(
    scene: StashLocalSceneRecord,
    baseUrl: string,
    stashId: string,
    providerKey: CatalogProviderKey | null,
  ): StashSceneMatch | null {
    const id = this.normalizeOptionalString(scene.id);
    if (!id) {
      return null;
    }

    // A scene linked to the id but with no file isn't a copy you have.
    if (!Array.isArray(scene.files) || scene.files.length === 0) {
      return null;
    }

    if (providerKey) {
      const linkedEntries = Array.isArray(scene.stash_ids)
        ? scene.stash_ids
            .map((entry) => this.toLinkedSceneStashId(entry))
            .filter((entry): entry is StashLinkedSceneStashId => entry !== null)
        : [];
      const linkedCatalogRefs = this.toLinkedCatalogRefs(linkedEntries);

      if (!hasCatalogSceneRef(linkedCatalogRefs, providerKey, stashId)) {
        return null;
      }
    }

    const { width, height } = this.pickBestResolution(scene.files ?? []);

    return {
      id,
      width,
      height,
      viewUrl: this.resolveSceneViewUrl(baseUrl, id),
      label: this.buildSceneLabel(id, height),
    };
  }

  private buildSceneFilter(
    feedConfig: StashLocalSceneFeedConfig,
  ): Record<string, unknown> | undefined {
    const titleQuery = this.normalizeOptionalString(feedConfig.titleQuery);
    const tagIds = this.normalizeStringArray(feedConfig.tagIds);
    const studioIds = this.normalizeStringArray(feedConfig.studioIds);
    const favoritePerformersOnly = feedConfig.favoritePerformersOnly === true;
    const favoriteStudiosOnly = feedConfig.favoriteStudiosOnly === true;
    const favoriteTagsOnly = feedConfig.favoriteTagsOnly === true;
    const filter: Record<string, unknown> = {};

    if (titleQuery) {
      filter['title'] = {
        value: titleQuery,
        modifier: 'INCLUDES',
      };
    }

    if (tagIds.length > 0) {
      filter['tags'] = {
        value: tagIds,
        modifier: feedConfig.tagMode === 'AND' ? 'INCLUDES_ALL' : 'INCLUDES',
      };
    }

    if (studioIds.length > 0) {
      filter['studios'] = {
        value: studioIds,
        modifier: 'INCLUDES',
      };
    }

    if (favoritePerformersOnly) {
      filter['performers_filter'] = {
        filter_favorites: true,
      };
    }

    if (favoriteStudiosOnly) {
      filter['studios_filter'] = {
        favorite: true,
      };
    }

    if (favoriteTagsOnly) {
      filter['tags_filter'] = {
        favorite: true,
      };
    }

    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  private buildSceneMatchFilter(
    stashId: string,
    overlays?: StashSceneMatchOverlayConfig,
  ): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      stash_id_endpoint: {
        modifier: 'EQUALS',
        stash_id: stashId,
      },
    };

    if (overlays?.favoritePerformersOnly === true) {
      filter['performers_filter'] = {
        filter_favorites: true,
      };
    }

    if (overlays?.favoriteStudiosOnly === true) {
      filter['studios_filter'] = {
        favorite: true,
      };
    }

    if (overlays?.favoriteTagsOnly === true) {
      filter['tags_filter'] = {
        favorite: true,
      };
    }

    return filter;
  }

  private toTagOption(tag: StashTagRecord): StashLocalTagOption | null {
    const id = this.normalizeOptionalString(tag.id);
    const name = this.normalizeOptionalString(tag.name);
    if (!id || !name) {
      return null;
    }

    return { id, name };
  }

  private toNamedEntities(
    values: Array<{ id?: unknown; name?: unknown } | null | undefined>,
  ): { ids: string[]; names: string[] } {
    const deduped = new Map<string, string>();

    for (const value of values) {
      const id = this.normalizeOptionalString(value?.id);
      const name = this.normalizeOptionalString(value?.name);
      if (!id || !name || deduped.has(id)) {
        continue;
      }

      deduped.set(id, name);
    }

    return {
      ids: [...deduped.keys()],
      names: [...deduped.values()],
    };
  }

  private toLinkedCatalogRefs(
    linkedEntries: StashLinkedSceneStashId[],
  ): string[] {
    return normalizeCatalogSceneRefs(
      linkedEntries.map((entry) => ({
        endpoint: entry.endpoint,
        externalId: entry.stashId,
      })),
    );
  }

  private toStudioOptions(
    studios: StashStudioSearchRecord[],
  ): StashLocalStudioOption[] {
    const grouped = new Map<
      string,
      {
        id: string;
        name: string;
        childStudios: Map<string, string>;
      }
    >();

    for (const studio of studios) {
      const studioId = this.normalizeOptionalString(studio.id);
      const studioName = this.normalizeOptionalString(studio.name);
      if (!studioId || !studioName) {
        continue;
      }

      const parentId = this.normalizeOptionalString(studio.parent_studio?.id);
      const parentName = this.normalizeOptionalString(
        studio.parent_studio?.name,
      );

      if (parentId && parentName) {
        const group = this.getOrCreateStudioGroup(
          grouped,
          parentId,
          parentName,
        );
        group.childStudios.set(studioId, studioName);
        continue;
      }

      const group = this.getOrCreateStudioGroup(grouped, studioId, studioName);
      for (const child of studio.child_studios ?? []) {
        const childId = this.normalizeOptionalString(child.id);
        const childName = this.normalizeOptionalString(child.name);
        if (childId && childName) {
          group.childStudios.set(childId, childName);
        }
      }
    }

    return [...grouped.values()]
      .map((group) => ({
        id: group.id,
        name: group.name,
        childStudios: [...group.childStudios.entries()]
          .map(([id, name]) => ({ id, name }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private getOrCreateStudioGroup(
    groups: Map<
      string,
      {
        id: string;
        name: string;
        childStudios: Map<string, string>;
      }
    >,
    id: string,
    name: string,
  ) {
    const existing = groups.get(id);
    if (existing) {
      return existing;
    }

    const created = {
      id,
      name,
      childStudios: new Map<string, string>(),
    };
    groups.set(id, created);
    return created;
  }

  private resolveFeedSort(sort: StashSceneFeedSort): string {
    switch (sort) {
      case 'CREATED_AT':
        return 'created_at';
      case 'UPDATED_AT':
        return 'updated_at';
      case 'TITLE':
        return 'title';
      default:
        return 'created_at';
    }
  }

  private resolveFeedDirection(direction: StashSceneFeedDirection): string {
    return direction === 'ASC' ? 'ASC' : 'DESC';
  }

  /** Stash's version, e.g. "v0.27.2". Null when it doesn't say. */
  async getVersion(config: StashAdapterBaseConfig): Promise<string | null> {
    const payload = (await this.executeQuery(
      config,
      `query Version { version { version } }`,
      undefined,
      false,
    )) as unknown as { data?: { version?: { version?: unknown } } };
    return this.normalizeOptionalString(payload.data?.version?.version);
  }
}
