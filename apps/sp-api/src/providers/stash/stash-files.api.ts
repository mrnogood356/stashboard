import { BadGatewayException } from '@nestjs/common';
import { stashImageVersion } from './stash-image-version.util';
import {
  type StashAdapterBaseConfig,
  type StashDuplicateScene,
  type StashGraphqlResponse,
} from './stash.types';
import { DUPLICATE_SCENE_FIELDS, idText } from './stash-tools.shared';
import { StashJobsApi } from './stash-jobs.api';

/** Scenes and their files: duplicates, samples, deleting and merging scenes, carrying details over. */
export abstract class StashFilesApi extends StashJobsApi {
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

  protected toDuplicateScene(
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
}
