import { BadGatewayException } from '@nestjs/common';
import { stashImageVersion } from './stash-image-version.util';
import {
  type StashAdapterBaseConfig,
  type StashOrganizerScene,
  type StashSceneMatchInput,
} from './stash.types';
import {
  STASH_ORGANIZER_SCENE_FIELDS,
  STASH_GENDERS,
  hostLabel,
} from './stash-tools.shared';
import { StashChecksApi } from './stash-checks.api';

/** What Match & rename needs: scenes with their files, StashDB lookups, moving files and saving matches. */
export abstract class StashOrganizerApi extends StashChecksApi {
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
    const link = { endpoint: studio.endpoint, stashId: studio.stashId };
    const found =
      (await this.findEntityByStashId(
        config,
        'studio',
        studio.endpoint,
        studio.stashId,
      )) ??
      (await this.findEntityByName(config, 'studio', studio.name, null, link));
    if (found) {
      await this.fillMissingImage(config, 'studio', found, studio.imageUrl);
      return found;
    }
    // StashDB's "Mr Anal" may be the local "Mr. Anal", with this as an alias.
    const aliased = await this.findEntityByAlias(
      config,
      'studio',
      studio.name,
      link,
    );
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
        ? await this.findEntityByName(config, 'studio', owner, null, link)
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
        { endpoint: performer.endpoint, stashId: performer.stashId },
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
    link?: CatalogLink,
  ): Promise<string | null> {
    const [plural, list, filterType] =
      kind === 'studio'
        ? ['Studios', 'studios', 'StudioFilterType']
        : ['Tags', 'tags', 'TagFilterType'];
    const extra = link ? ' name stash_ids { endpoint stash_id }' : '';
    const payload = (await this.executeQuery(
      config,
      `query ByAlias($filter: ${filterType}) { find${plural}(${kind}_filter: $filter, filter: { per_page: 1 }) { ${list} { id${extra} } } }`,
      { filter: { aliases: { value: name, modifier: 'EQUALS' } } },
    ).catch(() => null)) as unknown as {
      data?: Record<
        string,
        Record<string, Array<Record<string, unknown>>> | undefined
      >;
    } | null;
    const row = payload?.data?.[`find${plural}`]?.[list]?.[0];
    if (row && link && linkedElsewhere(row, link)) {
      throw this.linkedElsewhereError(
        kind,
        this.normalizeOptionalString(row.name) ?? name,
      );
    }
    return this.normalizeOptionalString(row?.id);
  }

  /** Stash has one by this name, but it's a different entry on that catalog. */
  protected linkedElsewhereError(kind: string, name: string): Error {
    return new BadGatewayException(
      `Stash's ${kind} ${name} is linked to a different entry on that catalog, so it wasn't used. Merge or relink it in Stash, then match again.`,
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
    link?: CatalogLink,
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
    const extra =
      (kind === 'performer' ? ' disambiguation' : '') +
      (link && kind !== 'tag' ? ' stash_ids { endpoint stash_id }' : '');
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
    let exact = rows.filter(
      (row) =>
        (this.normalizeOptionalString(row.name) ?? '').toLowerCase() ===
        name.toLowerCase(),
    );
    if (kind === 'performer' && disambiguation) {
      exact = exact.filter(
        (row) =>
          (
            this.normalizeOptionalString(row.disambiguation) ?? ''
          ).toLowerCase() === disambiguation.toLowerCase(),
      );
    }
    // One linked to a different entry on the same catalog is someone else.
    const usable = link
      ? exact.filter((row) => !linkedElsewhere(row, link))
      : exact;
    if (usable.length === 0 && exact.length > 0) {
      throw this.linkedElsewhereError(kind, name);
    }
    return this.normalizeOptionalString(usable[0]?.id);
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
}

/** A StashDB (or other catalog) entry: where it lives and its id there. */
interface CatalogLink {
  endpoint: string;
  stashId: string;
}

/** True when the row already has another id on the link's catalog. */
function linkedElsewhere(
  row: Record<string, unknown>,
  link: CatalogLink,
): boolean {
  const ids = Array.isArray(row.stash_ids) ? row.stash_ids : [];
  return ids.some((entry: unknown) => {
    const value = entry as { endpoint?: unknown; stash_id?: unknown } | null;
    return (
      value?.endpoint === link.endpoint &&
      typeof value.stash_id === 'string' &&
      value.stash_id !== link.stashId
    );
  });
}
