import {
  BadGatewayException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import {
  STASHDB_MATCH_SCENE_FIELDS,
  type StashdbAdapterBaseConfig,
  type StashdbAdapterSceneFeedConfig,
  type StashdbAdapterTrendingConfig,
  type StashdbMatchScene,
  type StashdbPerformerScenesConfig,
  type StashdbScene,
  type StashdbSceneDetails,
  type StashdbSceneFingerprints,
  type StashdbSceneFeedSort,
  type StashdbSceneImage,
  type StashdbSceneMetadata,
  type StashdbSceneMetadataSource,
  type StashdbScenePerformer,
  type StashdbSceneTag,
  type StashdbSceneUrl,
  type StashdbSortDirection,
  type StashdbTagOption,
  type StashdbTagSearchConfig,
  type StashdbTrendingScenesResult,
} from './stashdb.types';
import { StashdbPeopleApi } from './stashdb-people.api';
import { estimatedTotal, isServerSideError } from './stashdb-graphql.client';
export * from './stashdb.types';

@Injectable()
export class StashdbAdapter extends StashdbPeopleApi {
  constructor(runtimeHealthService: RuntimeHealthService) {
    super(runtimeHealthService);
  }

  async testConnection(config: StashdbAdapterBaseConfig): Promise<void> {
    await this.checkConnection(config, false);
  }

  async probeConnection(config: StashdbAdapterBaseConfig): Promise<void> {
    await this.checkConnection(config, true);
  }

  private async checkConnection(
    config: StashdbAdapterBaseConfig,
    trackRuntimeHealth: boolean,
  ): Promise<void> {
    const query = `
      query ConnectivityCheck {
        __typename
      }
    `;

    await this.executeQuery(config, query, undefined, trackRuntimeHealth);
  }

  async getScenesSortedByDate(
    config: StashdbAdapterTrendingConfig,
  ): Promise<StashdbTrendingScenesResult> {
    return this.getSceneFeed(config, 'DATE');
  }

  async getScenesBySort(
    config: StashdbAdapterSceneFeedConfig,
  ): Promise<StashdbTrendingScenesResult> {
    return this.getSceneFeed(config, config.sort, config.direction ?? 'DESC');
  }

  async searchTags(
    config: StashdbTagSearchConfig,
  ): Promise<StashdbTagOption[]> {
    const query = `
      query QueryTags($name: String!) {
        queryTags(input: { direction: ASC, sort: NAME, name: $name }) {
          tags {
            id
            name
            description
            aliases
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, {
      name: config.query,
    });
    const rawTags = payload.data?.queryTags?.tags ?? [];

    return rawTags
      .map((tag): StashdbTagOption | null => {
        if (typeof tag.id !== 'string' || typeof tag.name !== 'string') {
          return null;
        }

        const aliases = Array.isArray(tag.aliases)
          ? tag.aliases.filter(
              (alias): alias is string => typeof alias === 'string',
            )
          : [];

        return {
          id: tag.id,
          name: tag.name,
          description:
            typeof tag.description === 'string' &&
            tag.description.trim().length > 0
              ? tag.description
              : null,
          aliases,
        };
      })
      .filter((tag): tag is StashdbTagOption => tag !== null);
  }

  /**
   * Each name's tag id in this catalog (by exact name or alias, ignoring
   * case), or null when it has none, keyed by the lowercase name. Asked in a
   * few batched requests whatever the number of names: one exact lookup for
   * all of them, then one case-insensitive search for those it missed.
   */
  async findTagIdsByNames(
    config: StashdbAdapterBaseConfig,
    names: readonly string[],
  ): Promise<Map<string, string | null>> {
    const wanted = [
      ...new Set(
        names.map((name) => name.trim()).filter((name) => name.length > 0),
      ),
    ];
    const found = new Map<string, string | null>();
    for (const chunk of chunks(wanted, TAG_BATCH_SIZE)) {
      const exact = await this.exactTagIds(config, chunk);
      const missing = chunk.filter((name) => !exact.get(name.toLowerCase()));
      // Searches return up to 100 tags each, so fewer per request.
      const searched = new Map<string, string | null>();
      for (const part of chunks(missing, TAG_SEARCH_BATCH_SIZE)) {
        for (const [key, id] of await this.searchedTagIds(config, part)) {
          searched.set(key, id);
        }
      }
      for (const name of chunk) {
        const key = name.toLowerCase();
        found.set(key, exact.get(key) ?? searched.get(key) ?? null);
      }
    }
    return found;
  }

  /** Which of these ids are tags in this catalog. */
  async existingTagIds(
    config: StashdbAdapterBaseConfig,
    ids: readonly string[],
  ): Promise<Set<string>> {
    const wanted = [
      ...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
    ];
    const existing = new Set<string>();
    for (const chunk of chunks(wanted, TAG_BATCH_SIZE)) {
      const fields = chunk.map(
        (_id, index) => `t${index}: findTag(id: $id${index}) { id }`,
      );
      const payload = await this.executeQuery(
        config,
        `query FindTagsById(${chunk.map((_id, index) => `$id${index}: ID!`).join(', ')}) {
          ${fields.join('\n')}
        }`,
        Object.fromEntries(chunk.map((id, index) => [`id${index}`, id])),
      );
      const data = (payload.data ?? {}) as Record<string, unknown>;
      chunk.forEach((id, index) => {
        if (tagIdOf(data[`t${index}`])) {
          existing.add(id);
        }
      });
    }
    return existing;
  }

  /** findTagOrAlias for each name at once; empty when the server lacks it. */
  private async exactTagIds(
    config: StashdbAdapterBaseConfig,
    names: string[],
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    try {
      const payload = await this.executeQueryRaw(
        config,
        `query FindTagsOrAlias(${names.map((_name, index) => `$n${index}: String!`).join(', ')}) {
          ${names.map((_name, index) => `t${index}: findTagOrAlias(name: $n${index}) { id }`).join('\n')}
        }`,
        Object.fromEntries(names.map((name, index) => [`n${index}`, name])),
        false,
      );
      if (!payload.data) {
        return result;
      }
      const data = payload.data as Record<string, unknown>;
      names.forEach((name, index) => {
        result.set(name.toLowerCase(), tagIdOf(data[`t${index}`]));
      });
    } catch {
      // Older servers reject the query outright; the search still works.
    }
    return result;
  }

  /** A case-insensitive name search for each name at once. */
  private async searchedTagIds(
    config: StashdbAdapterBaseConfig,
    names: string[],
  ): Promise<Map<string, string | null>> {
    const payload = await this.executeQuery(
      config,
      `query QueryTagsByNames(${names.map((_name, index) => `$n${index}: String!`).join(', ')}) {
        ${names
          .map(
            (_name, index) =>
              `t${index}: queryTags(input: { direction: ASC, sort: NAME, name: $n${index}, per_page: 100 }) { tags { id name aliases } }`,
          )
          .join('\n')}
      }`,
      Object.fromEntries(names.map((name, index) => [`n${index}`, name])),
    );
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const result = new Map<string, string | null>();
    names.forEach((name, index) => {
      const wanted = name.toLowerCase();
      const tags = tagListOf(data[`t${index}`]);
      const match =
        tags.find((tag) => tag.name.toLowerCase() === wanted) ??
        tags.find((tag) =>
          tag.aliases.some((alias) => alias.toLowerCase() === wanted),
        );
      result.set(wanted, match?.id ?? null);
    });
    return result;
  }

  async getScenesForPerformer(
    config: StashdbPerformerScenesConfig,
  ): Promise<StashdbTrendingScenesResult> {
    const normalizedStudioIds = (config.studioIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const normalizedTagIds = (config.tagIds ?? [])
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const studioIds = [...new Set(normalizedStudioIds)];
    const tagIds = [...new Set(normalizedTagIds)];

    const variableDeclarations = [
      '$page: Int!',
      '$perPage: Int!',
      '$performerId: [ID!]!',
    ];
    const inputParts = [
      `sort: ${config.sort}`,
      `direction: ${config.direction ?? 'DESC'}`,
      'page: $page',
      'per_page: $perPage',
      'performers: { value: $performerId, modifier: INCLUDES }',
    ];

    if (studioIds.length > 0) {
      variableDeclarations.push('$studioIds: [ID!]!');
      inputParts.push('studios: { value: $studioIds, modifier: INCLUDES }');
    }

    if (tagIds.length > 0) {
      variableDeclarations.push('$tagIds: [ID!]!');
      inputParts.push('tags: { value: $tagIds, modifier: INCLUDES }');
    }

    if (config.onlyFavoriteStudios) {
      inputParts.push('favorites: STUDIO');
    }
    const tagNamesField = config.includeTagNames
      ? 'tags { id name } performers { performer { id name } }'
      : '';

    const query = `
      query QueryScenesForPerformer(${variableDeclarations.join(', ')}) {
        queryScenes(input: { ${inputParts.join(', ')} }) {
          count
          scenes {
            id
            title
            details
            date
            release_date
            created
            updated
            production_date
            images {
              id
              url
              width
              height
            }
            studio {
              id
              name
              images {
                id
                url
                width
                height
              }
            }
            duration
            ${tagNamesField}
          }
        }
      }
    `;

    const variables: Record<string, unknown> = {
      page: config.page,
      perPage: config.perPage,
      performerId: [config.performerId],
    };
    if (studioIds.length > 0) {
      variables.studioIds = studioIds;
    }
    if (tagIds.length > 0) {
      variables.tagIds = tagIds;
    }

    const payload = await this.executeQuery(config, query, variables);
    const total =
      typeof payload.data?.queryScenes?.count === 'number'
        ? payload.data.queryScenes.count
        : 0;
    const scenes = this.normalizeSceneFeedItems(
      payload.data?.queryScenes?.scenes ?? [],
    );

    return { total, scenes };
  }

  private async getSceneFeed(
    config: StashdbAdapterSceneFeedConfig | StashdbAdapterTrendingConfig,
    sort: StashdbSceneFeedSort,
    direction: StashdbSortDirection = 'DESC',
  ): Promise<StashdbTrendingScenesResult> {
    const favorites =
      'favorites' in config && config.favorites ? config.favorites : null;
    const tagFilter =
      'tagFilter' in config &&
      config.tagFilter?.tagIds.length &&
      config.tagFilter.tagIds.length > 0
        ? config.tagFilter
        : null;
    const studioIds =
      'studioIds' in config && config.studioIds
        ? [...new Set(config.studioIds.map((id) => id.trim()).filter(Boolean))]
        : [];
    const tagModifier = tagFilter?.mode === 'AND' ? 'INCLUDES_ALL' : 'INCLUDES';
    const tagVariableDeclaration = tagFilter ? ', $tagIds: [ID!]!' : '';
    const studioVariableDeclaration =
      studioIds.length > 0 ? ', $studioIds: [ID!]!' : '';
    const favoritesInput = favorites ? `, favorites: ${favorites}` : '';
    const tagInput = tagFilter
      ? `, tags: { value: $tagIds, modifier: ${tagModifier} }`
      : '';
    const studioInput =
      studioIds.length > 0
        ? ', studios: { value: $studioIds, modifier: INCLUDES }'
        : '';
    const text =
      'text' in config && config.text?.trim()
        ? config.text.trim().slice(0, 200)
        : null;
    const textVariableDeclaration = text ? ', $text: String' : '';
    const textInput = text ? ', text: $text' : '';
    const tagNamesField =
      'includeTagNames' in config && config.includeTagNames
        ? 'tags { id name } performers { performer { id name } }'
        : '';
    const sceneFields = `
            id
            title
            details
            date
            release_date
            created
            updated
            production_date
            images {
              id
              url
              width
              height
            }
            studio {
              id
              name
              images {
                id
                url
                width
                height
              }
            }
            duration
            ${tagNamesField}
    `;
    const query = `
      query QueryScenes($page: Int!, $perPage: Int!${tagVariableDeclaration}${studioVariableDeclaration}${textVariableDeclaration}) {
        queryScenes(input: { sort: ${sort}, direction: ${direction}, page: $page, per_page: $perPage${favoritesInput}${tagInput}${studioInput}${textInput} }) {
          count
          scenes {
            ${sceneFields}
          }
        }
      }
    `;
    const variables: Record<string, unknown> = {
      page: config.page,
      perPage: config.perPage,
    };
    if (tagFilter) {
      variables.tagIds = tagFilter.tagIds;
    }
    if (studioIds.length > 0) {
      variables.studioIds = studioIds;
    }
    if (text) {
      variables.text = text;
    }

    let rawScenes: unknown[];
    let count: unknown;
    if (!text) {
      const payload = await this.executeQuery(config, query, variables);
      rawScenes = payload.data?.queryScenes?.scenes ?? [];
      count = payload.data?.queryScenes?.count;
    } else {
      try {
        const payload = await this.executeCountedSearch(
          config,
          query,
          variables,
        );
        rawScenes = payload.data?.queryScenes?.scenes ?? [];
        count = payload.data?.queryScenes?.count;
      } catch (error) {
        // The catalog's text search failing on its side even without the
        // count: its other search, by relevance, one page only. It can't
        // filter, so not while studios, tags or favorites narrow the list.
        const filtered = Boolean(
          favorites || tagFilter || studioIds.length > 0,
        );
        if (!isServerSideError(error) || config.page > 1 || filtered) {
          throw error;
        }
        const payload = await this.executeQuery(
          config,
          `query SearchScenes($term: String!, $limit: Int) {
            searchScene(term: $term, limit: $limit) { ${sceneFields} }
          }`,
          { term: text, limit: config.perPage },
        );
        const found = (payload.data as { searchScene?: unknown } | undefined)
          ?.searchScene;
        rawScenes = Array.isArray(found) ? found : [];
        count = rawScenes.length;
      }
    }
    const scenes = this.normalizeSceneFeedItems(
      rawScenes as Parameters<typeof this.normalizeSceneFeedItems>[0],
    );
    const total =
      typeof count === 'number'
        ? count
        : estimatedTotal(config.page, config.perPage, rawScenes.length);

    return { total, scenes };
  }

  async getSceneById(
    sceneId: string,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbSceneDetails> {
    const query = `
      query FindScene($id: ID!) {
        findScene(id: $id) {
          id
          title
          details
          date
          release_date
          production_date
          duration
          created
          updated
          images {
            id
            url
            width
            height
          }
          tags {
            id
            name
            description
          }
          studio {
            id
            name
            is_favorite
            images {
              id
              url
              width
              height
            }
          }
          urls {
            url
            type
          }
          performers {
            performer {
              id
              name
              gender
              is_favorite
              images {
                id
                url
                width
                height
              }
            }
          }
        }
      }
    `;

    const payload = await this.executeQuery(config, query, { id: sceneId });
    const scene = payload.data?.findScene;

    if (!scene) {
      throw new NotFoundException(`Scene ${sceneId} not found in StashDB.`);
    }

    if (typeof scene.id !== 'string') {
      throw new BadGatewayException(
        'StashDB scene response is missing required fields.',
      );
    }

    const metadata = this.normalizeSceneMetadata(scene);
    if (!metadata) {
      throw new BadGatewayException(
        'StashDB scene response is missing required fields.',
      );
    }

    const images = (scene.images ?? [])
      .map((image): StashdbSceneImage | null => {
        if (typeof image.url !== 'string') {
          return null;
        }

        const id =
          typeof image.id === 'string' && image.id.length > 0
            ? image.id
            : image.url;

        return {
          id,
          url: image.url,
          width: typeof image.width === 'number' ? image.width : null,
          height: typeof image.height === 'number' ? image.height : null,
        };
      })
      .filter((image): image is StashdbSceneImage => image !== null);

    const tags = (scene.tags ?? [])
      .map((tag): StashdbSceneTag | null => {
        if (typeof tag.id !== 'string' || typeof tag.name !== 'string') {
          return null;
        }

        return {
          id: tag.id,
          name: tag.name,
          description:
            typeof tag.description === 'string' &&
            tag.description.trim().length > 0
              ? tag.description
              : null,
        };
      })
      .filter((tag): tag is StashdbSceneTag => tag !== null);

    const performers = (scene.performers ?? [])
      .map((entry): StashdbScenePerformer | null => {
        const performer = entry.performer;
        if (
          !performer ||
          typeof performer.id !== 'string' ||
          typeof performer.name !== 'string'
        ) {
          return null;
        }

        return {
          id: performer.id,
          name: performer.name,
          gender:
            typeof performer.gender === 'string' ? performer.gender : null,
          isFavorite: performer.is_favorite === true,
          imageUrl:
            this.selectPrimaryImage(
              (performer.images ?? [])
                .map((image): StashdbSceneImage | null => {
                  if (
                    typeof image.id !== 'string' ||
                    typeof image.url !== 'string'
                  ) {
                    return null;
                  }

                  return {
                    id: image.id,
                    url: image.url,
                    width: typeof image.width === 'number' ? image.width : null,
                    height:
                      typeof image.height === 'number' ? image.height : null,
                  };
                })
                .filter((image): image is StashdbSceneImage => image !== null),
            )?.url ?? null,
        };
      })
      .filter(
        (performer): performer is StashdbScenePerformer => performer !== null,
      );

    const sourceUrls = (scene.urls ?? [])
      .map((sourceUrl): StashdbSceneUrl | null => {
        if (typeof sourceUrl.url !== 'string') {
          return null;
        }

        return {
          url: sourceUrl.url,
          type: typeof sourceUrl.type === 'string' ? sourceUrl.type : null,
        };
      })
      .filter((sourceUrl): sourceUrl is StashdbSceneUrl => sourceUrl !== null);

    return {
      ...metadata,
      images,
      studioIsFavorite: scene.studio?.is_favorite === true,
      tags,
      performers,
      sourceUrls,
    };
  }

  async getSceneMetadataByIds(
    sceneIds: string[],
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbSceneMetadata[]> {
    const normalizedIds = [
      ...new Set(sceneIds.map((sceneId) => sceneId.trim()).filter(Boolean)),
    ];
    if (normalizedIds.length === 0) {
      return [];
    }

    const variableDeclarations = normalizedIds
      .map((_, index) => `$id${index}: ID!`)
      .join(', ');
    const queryFields = normalizedIds
      .map(
        (_, index) => `
          scene_${index}: findScene(id: $id${index}) {
            id
            title
            details
            date
            release_date
            production_date
            duration
            images {
              id
              url
              width
              height
            }
            studio {
              id
              name
              images {
                id
                url
                width
                height
              }
            }
            performers {
              as
              performer {
                name
              }
            }
          }
        `,
      )
      .join('\n');
    const variables = Object.fromEntries(
      normalizedIds.map((sceneId, index) => [`id${index}`, sceneId]),
    );
    const query = `
      query FindSceneMetadataBatch(${variableDeclarations}) {
        ${queryFields}
      }
    `;

    const payload = await this.executeQueryRaw(config, query, variables);
    if (
      payload.errors &&
      payload.errors.length > 0 &&
      (!payload.data || Object.keys(payload.data).length === 0)
    ) {
      const firstError = payload.errors[0]?.message;
      const message =
        typeof firstError === 'string' && firstError.length > 0
          ? firstError
          : 'StashDB GraphQL request failed.';
      await this.reportRuntimeFailure(message);
      throw new BadGatewayException(message);
    }

    const data = payload.data as Record<string, unknown> | undefined;
    const metadata = normalizedIds
      .map((_, index): StashdbSceneMetadata | null => {
        const source =
          (data?.[`scene_${index}`] as
            StashdbSceneMetadataSource | null | undefined) ?? null;
        const scene = this.normalizeSceneMetadata(source);
        return scene
          ? { ...scene, performerNames: readPerformerNames(source) }
          : null;
      })
      .filter((scene): scene is StashdbSceneMetadata => scene !== null);
    await this.reportRuntimeSuccess();
    return metadata;
  }

  // ---------- matching local files ----------

  /**
   * Scenes that share a fingerprint (phash, oshash or md5) with each local
   * file group. One result list per group, in the same order.
   */
  async findScenesByFingerprints(
    config: StashdbAdapterBaseConfig,
    groups: Array<
      Array<{ hash: string; algorithm: 'PHASH' | 'OSHASH' | 'MD5' }>
    >,
    trackRuntimeHealth = true,
  ): Promise<StashdbMatchScene[][]> {
    if (groups.length === 0) {
      return [];
    }
    const payload = await this.executeQuery(
      config,
      `query MatchFingerprints($fingerprints: [[FingerprintQueryInput!]!]!) {
        findScenesBySceneFingerprints(fingerprints: $fingerprints) { ${STASHDB_MATCH_SCENE_FIELDS} }
      }`,
      { fingerprints: groups },
      trackRuntimeHealth,
    );
    const lists = (
      payload.data as { findScenesBySceneFingerprints?: unknown } | undefined
    )?.findScenesBySceneFingerprints;
    const rows: unknown[] = Array.isArray(lists) ? lists : [];
    return groups.map((_, index) => {
      const list = rows[index];
      return (Array.isArray(list) ? list : []).flatMap((scene) => {
        const parsed = this.toMatchScene(scene);
        return parsed ? [parsed] : [];
      });
    });
  }

  /**
   * A scene's title, studio, date and file fingerprints, for spotting a copy
   * you already have. Most-submitted fingerprints first; null when the
   * catalog doesn't have the scene.
   */
  async getSceneFingerprints(
    sceneId: string,
    config: StashdbAdapterBaseConfig,
  ): Promise<StashdbSceneFingerprints | null> {
    const payload = await this.executeQuery(
      config,
      `query SceneFingerprints($id: ID!) {
        findScene(id: $id) {
          id title date release_date duration
          studio { name }
          fingerprints { hash algorithm submissions }
        }
      }`,
      { id: sceneId },
    );
    const scene = (payload.data as { findScene?: unknown } | undefined)
      ?.findScene as Record<string, unknown> | null | undefined;
    const id = this.normalizeOptionalString(scene?.id);
    if (!scene || !id) {
      return null;
    }
    const studio = scene.studio as Record<string, unknown> | null | undefined;
    const fingerprints = (
      Array.isArray(scene.fingerprints) ? scene.fingerprints : []
    )
      .flatMap((entry) => {
        const print = entry as Record<string, unknown> | null;
        const hash = this.normalizeOptionalString(print?.hash);
        const algorithm = this.normalizeOptionalString(print?.algorithm);
        if (
          !hash ||
          (algorithm !== 'PHASH' &&
            algorithm !== 'OSHASH' &&
            algorithm !== 'MD5')
        ) {
          return [];
        }
        return [
          {
            hash,
            algorithm,
            submissions:
              typeof print?.submissions === 'number' ? print.submissions : 0,
          } as const,
        ];
      })
      .sort((left, right) => right.submissions - left.submissions);
    return {
      id,
      title: this.normalizeOptionalString(scene.title),
      studioName: this.normalizeOptionalString(studio?.name),
      date:
        this.normalizeOptionalString(scene.release_date) ??
        this.normalizeOptionalString(scene.date),
      duration: typeof scene.duration === 'number' ? scene.duration : null,
      fingerprints,
    };
  }

  /** These scenes, by id, in the shape matching uses (missing ones are left out). */
  async getMatchScenesByIds(
    config: StashdbAdapterBaseConfig,
    ids: string[],
  ): Promise<StashdbMatchScene[]> {
    return [...(await this.getMatchScenesById(config, ids)).values()];
  }

  /**
   * Each id asked for, and the scene StashDB answers with. For a scene merged
   * into another, that is the scene it was merged into, under its own id.
   */
  async getMatchScenesById(
    config: StashdbAdapterBaseConfig,
    ids: string[],
  ): Promise<Map<string, StashdbMatchScene>> {
    const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (unique.length === 0) {
      return new Map();
    }
    const variables = Object.fromEntries(
      unique.map((id, index) => [`id${index}`, id]),
    );
    const payload = await this.executeQuery(
      config,
      `query MatchScenesById(${unique.map((_, index) => `$id${index}: ID!`).join(', ')}) {
        ${unique.map((_, index) => `s${index}: findScene(id: $id${index}) { ${STASHDB_MATCH_SCENE_FIELDS} }`).join('\n')}
      }`,
      variables,
    );
    const data = (payload.data ?? {}) as Record<string, unknown>;
    return new Map(
      unique.flatMap((id, index) => {
        const parsed = this.toMatchScene(data[`s${index}`]);
        return parsed ? [[id, parsed] as const] : [];
      }),
    );
  }

  /** StashDB's own text search: a title, studio and performer names work best. */
  async searchScenesByText(
    config: StashdbAdapterBaseConfig,
    term: string,
    limit = 8,
    trackRuntimeHealth = true,
  ): Promise<StashdbMatchScene[]> {
    const cleaned = term.trim();
    if (!cleaned) {
      return [];
    }
    const payload = await this.executeQuery(
      config,
      `query MatchSearch($term: String!, $limit: Int) {
        searchScene(term: $term, limit: $limit) { ${STASHDB_MATCH_SCENE_FIELDS} }
      }`,
      { term: cleaned.slice(0, 200), limit },
      trackRuntimeHealth,
    );
    const list = (payload.data as { searchScene?: unknown } | undefined)
      ?.searchScene;
    return (Array.isArray(list) ? list : []).flatMap((scene) => {
      const parsed = this.toMatchScene(scene);
      return parsed ? [parsed] : [];
    });
  }

  private toMatchScene(value: unknown): StashdbMatchScene | null {
    const scene = value as Record<string, unknown> | null;
    const id = this.normalizeOptionalString(scene?.id);
    if (!scene || !id) {
      return null;
    }
    const studio = scene.studio as Record<string, unknown> | null | undefined;
    const studioId = this.normalizeOptionalString(studio?.id);
    const studioName = this.normalizeOptionalString(studio?.name);
    const images = this.normalizeImages(
      scene.images as Array<{
        id?: unknown;
        url?: unknown;
        width?: unknown;
        height?: unknown;
      }> | null,
    );
    const image = this.selectPrimaryImage(images);
    const performers = (
      Array.isArray(scene.performers) ? scene.performers : []
    ).flatMap((entry) => {
      const appearance = entry as Record<string, unknown> | null;
      const performer = appearance?.performer as
        Record<string, unknown> | null | undefined;
      const performerId = this.normalizeOptionalString(performer?.id);
      const name = this.normalizeOptionalString(performer?.name);
      if (!performerId || !name) {
        return [];
      }
      return [
        {
          id: performerId,
          name,
          as: this.normalizeOptionalString(appearance?.as),
          disambiguation: this.normalizeOptionalString(
            performer?.disambiguation,
          ),
          gender: this.normalizeOptionalString(performer?.gender),
          imageUrl: this.firstImageUrl(performer?.images),
        },
      ];
    });
    const tags = (Array.isArray(scene.tags) ? scene.tags : []).flatMap(
      (entry) => {
        const tag = entry as Record<string, unknown> | null;
        const tagId = this.normalizeOptionalString(tag?.id);
        const name = this.normalizeOptionalString(tag?.name);
        return tagId && name ? [{ id: tagId, name }] : [];
      },
    );
    const urls = (Array.isArray(scene.urls) ? scene.urls : []).flatMap(
      (entry) => {
        const url = this.normalizeOptionalString(
          (entry as Record<string, unknown> | null)?.url,
        );
        return url ? [url] : [];
      },
    );
    return {
      id,
      title: this.normalizeOptionalString(scene.title),
      code: this.normalizeOptionalString(scene.code),
      details: this.normalizeOptionalString(scene.details),
      director: this.normalizeOptionalString(scene.director),
      date:
        this.normalizeOptionalString(scene.release_date) ??
        this.normalizeOptionalString(scene.date),
      duration:
        typeof scene.duration === 'number' && scene.duration > 0
          ? scene.duration
          : null,
      imageUrl: image?.url ?? null,
      studio:
        studioId && studioName
          ? {
              id: studioId,
              name: studioName,
              imageUrl: this.firstImageUrl(studio?.images),
            }
          : null,
      performers,
      tags,
      urls,
    };
  }

  /** The first image's URL from a StashDB images list, for a logo or photo. */
  private firstImageUrl(images: unknown): string | null {
    if (!Array.isArray(images)) {
      return null;
    }
    for (const image of images) {
      const url = this.normalizeOptionalString(
        (image as { url?: unknown } | null)?.url,
      );
      if (url) {
        return url;
      }
    }
    return null;
  }

  private normalizeSceneFeedItems(
    rawScenes: Array<{
      id?: unknown;
      title?: unknown;
      details?: unknown;
      date?: unknown;
      release_date?: unknown;
      production_date?: unknown;
      images?: Array<{
        id?: unknown;
        url?: unknown;
        width?: unknown;
        height?: unknown;
      }>;
      studio?: {
        id?: unknown;
        name?: unknown;
        images?: Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>;
      } | null;
      duration?: unknown;
      tags?: Array<{ id?: unknown; name?: unknown }>;
      performers?: Array<{
        performer?: { id?: unknown; name?: unknown } | null;
      } | null>;
    }>,
  ): StashdbScene[] {
    return rawScenes
      .map((scene): StashdbScene | null => {
        if (typeof scene.id !== 'string') {
          return null;
        }

        const sceneImageUrl = this.selectPrimaryImage(
          this.normalizeImages(scene.images),
        )?.url;
        const studioImageUrl = this.selectPrimaryImage(
          this.normalizeImages(scene.studio?.images),
        )?.url;

        return {
          id: scene.id,
          title: sceneTitle(scene.title),
          details:
            typeof scene.details === 'string' && scene.details.trim().length > 0
              ? scene.details
              : null,
          imageUrl: sceneImageUrl ?? null,
          studioId:
            typeof scene.studio?.id === 'string' && scene.studio.id.length > 0
              ? scene.studio.id
              : null,
          studioName:
            typeof scene.studio?.name === 'string' &&
            scene.studio.name.length > 0
              ? scene.studio.name
              : null,
          studioImageUrl: studioImageUrl ?? null,
          date:
            typeof scene.date === 'string' && scene.date.length > 0
              ? scene.date
              : null,
          releaseDate:
            typeof scene.release_date === 'string' &&
            scene.release_date.length > 0
              ? scene.release_date
              : null,
          productionDate:
            typeof scene.production_date === 'string' &&
            scene.production_date.length > 0
              ? scene.production_date
              : null,
          duration: typeof scene.duration === 'number' ? scene.duration : null,
          ...(Array.isArray(scene.tags)
            ? {
                tagIds: scene.tags.flatMap((tag) =>
                  typeof tag?.id === 'string' && tag.id.length > 0
                    ? [tag.id]
                    : [],
                ),
                tagNames: scene.tags.flatMap((tag) =>
                  typeof tag?.name === 'string' && tag.name.length > 0
                    ? [tag.name]
                    : [],
                ),
              }
            : {}),
          ...(Array.isArray(scene.performers)
            ? {
                performers: scene.performers.flatMap((entry) => {
                  const id = entry?.performer?.id;
                  const name = entry?.performer?.name;
                  return typeof id === 'string' && id.length > 0
                    ? [{ id, name: typeof name === 'string' ? name : '' }]
                    : [];
                }),
              }
            : {}),
        };
      })
      .filter((scene): scene is StashdbScene => scene !== null);
  }

  private normalizeSceneMetadata(
    scene: StashdbSceneMetadataSource | null | undefined,
  ): StashdbSceneMetadata | null {
    if (!scene || typeof scene.id !== 'string') {
      return null;
    }

    const sceneImageUrl = this.selectPrimaryImage(
      this.normalizeImages(scene.images),
    )?.url;
    const studioImageUrl = this.selectPrimaryImage(
      this.normalizeImages(scene.studio?.images),
    )?.url;
    const releaseDate =
      (typeof scene.release_date === 'string' && scene.release_date.length > 0
        ? scene.release_date
        : null) ??
      (typeof scene.production_date === 'string' &&
      scene.production_date.length > 0
        ? scene.production_date
        : null) ??
      (typeof scene.date === 'string' && scene.date.length > 0
        ? scene.date
        : null);

    return {
      id: scene.id,
      title: sceneTitle(scene.title),
      details:
        typeof scene.details === 'string' && scene.details.trim().length > 0
          ? scene.details
          : null,
      imageUrl: sceneImageUrl ?? null,
      studioId:
        typeof scene.studio?.id === 'string' && scene.studio.id.length > 0
          ? scene.studio.id
          : null,
      studioName:
        typeof scene.studio?.name === 'string' && scene.studio.name.length > 0
          ? scene.studio.name
          : null,
      studioImageUrl: studioImageUrl ?? null,
      releaseDate,
      duration: typeof scene.duration === 'number' ? scene.duration : null,
    };
  }
}

/** The names a scene credits its performers under ("as" first). */
export function readPerformerNames(
  source: StashdbSceneMetadataSource | null,
): string[] {
  return (source?.performers ?? []).flatMap((entry) => {
    const credited = typeof entry?.as === 'string' ? entry.as.trim() : '';
    const name =
      typeof entry?.performer?.name === 'string'
        ? entry.performer.name.trim()
        : '';
    return [...new Set([name, credited].filter(Boolean))];
  });
}

/** Titles are optional in stash-box; an untitled scene still gets a card. */
function sceneTitle(title: unknown): string {
  return typeof title === 'string' && title.trim() ? title : 'Untitled scene';
}

/** Names or ids per batched tag request; keeps each query a sane size. */
const TAG_BATCH_SIZE = 25;
const TAG_SEARCH_BATCH_SIZE = 8;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    result.push(items.slice(start, start + size));
  }
  return result;
}

function tagIdOf(value: unknown): string | null {
  const id =
    value && typeof value === 'object'
      ? (value as { id?: unknown }).id
      : undefined;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function tagListOf(
  value: unknown,
): Array<{ id: string; name: string; aliases: string[] }> {
  const tags =
    value && typeof value === 'object'
      ? (value as { tags?: unknown }).tags
      : undefined;
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.flatMap((tag: unknown) => {
    const { id, name, aliases } = (tag ?? {}) as {
      id?: unknown;
      name?: unknown;
      aliases?: unknown;
    };
    if (typeof id !== 'string' || typeof name !== 'string') {
      return [];
    }
    return [
      {
        id,
        name,
        aliases: Array.isArray(aliases)
          ? aliases.filter(
              (alias): alias is string => typeof alias === 'string',
            )
          : [],
      },
    ];
  });
}
