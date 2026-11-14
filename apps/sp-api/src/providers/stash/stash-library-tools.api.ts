import {
  type StashAdapterBaseConfig,
  type StashTagSummary,
} from './stash.types';
import {
  DEFAULT_CHAPTER_SECONDS,
  StashChapter,
  StashMergeCandidate,
  mergedValues,
  idText,
} from './stash-tools.shared';
import { StashOrganizerApi } from './stash-organizer.api';

export type { StashChapter, StashMergeCandidate } from './stash-tools.shared';

/** Tags, chapters and merging performers, studios and tags. */
export abstract class StashLibraryToolsApi extends StashOrganizerApi {
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
              performers { id name disambiguation alias_list scene_count death_date stash_ids { endpoint stash_id } }
            }
          }`
        : `query MergeStudios($filter: FindFilterType) {
            findStudios(filter: $filter) {
              studios { id name aliases scene_count parent_studio { name } stash_ids { endpoint stash_id } }
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
          links: (Array.isArray(row['stash_ids'])
            ? row['stash_ids']
            : []
          ).flatMap((link: Record<string, unknown>) =>
            typeof link?.['endpoint'] === 'string' &&
            typeof link?.['stash_id'] === 'string'
              ? [`${link['endpoint']}|${link['stash_id']}`]
              : [],
          ),
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
}
