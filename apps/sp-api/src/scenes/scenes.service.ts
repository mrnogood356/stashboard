import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { IntegrationsService } from '../integrations/integrations.service';
import {
  CatalogProviderService,
  type ConfiguredCatalogProvider,
} from '../providers/catalog/catalog-provider.service';
import { type CatalogProviderKey } from '../providers/catalog/catalog-provider.util';
import { StashAdapter } from '../providers/stash/stash.adapter';
import {
  StashdbAdapter,
  type StashdbAdapterSceneFeedConfig,
  type StashdbTrendingScenesResult as StashdbSceneList,
} from '../providers/stashdb/stashdb.adapter';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  SceneStatusDto,
  isSceneStatusRequestable,
} from '../scene-status/dto/scene-status.dto';
import { SceneStatusService } from '../scene-status/scene-status.service';
import {
  EMPTY_EXCLUDE_RULES,
  applyExcludeRules,
  buildExcludeMatchers,
  exceptRequested,
  needsSceneTags,
  parseExcludeTerms,
  splitNegatedTerms,
} from './scene-exclude-terms.util';
import { SceneTagOptionDto } from './dto/scene-tag-option.dto';
import {
  SceneDetailsDto,
  SceneStashAvailabilityDto,
  SceneWhisparrAvailabilityDto,
} from './dto/scene-details.dto';
import {
  ScenesFeedItemDto,
  ScenesFeedResponseDto,
} from './dto/scenes-feed.dto';
import { ScenesCalendarResponseDto } from './dto/scenes-calendar.dto';
import {
  SceneFavoritesFilter,
  SceneFeedSort,
  SortDirection,
  SceneTagMatchMode,
} from './dto/scenes-query.dto';

/** How long a tag's id in a catalog is remembered. */
/** Tag ids and names rarely change; a rail's lookups are reused for this long. */
const TAG_LOOKUP_TTL_MS = 12 * 60 * 60_000;

@Injectable()
export class ScenesService {
  private readonly logger = new Logger(ScenesService.name);
  private static readonly DEFAULT_PAGE = 1;
  private static readonly DEFAULT_PER_PAGE = 24;
  /** The catalog's largest page, and how many a calendar view reads at most. */
  private static readonly CALENDAR_PAGE_SIZE = 100;
  private static readonly CALENDAR_PAGES = 10;
  /**
   * Catalog lists barely change minute to minute, and Home asks for several at
   * once on every visit, so keep each page for a short while.
   */
  private static readonly CATALOG_CACHE_TTL_MS = 60_000;
  private static readonly CATALOG_CACHE_MAX_ENTRIES = 50;

  /** Tag lookups per catalog address: "name:<lowercase>" or "id:<id>" to an id or null. */
  private readonly tagIdsByName = new Map<
    string,
    { expiresAt: number; id: string | null }
  >();

  private readonly catalogCache = new Map<
    string,
    { expiresAt: number; value: Promise<StashdbSceneList> }
  >();

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly catalogProviderService: CatalogProviderService,
    private readonly stashdbAdapter: StashdbAdapter,
    private readonly sceneStatusService: SceneStatusService,
    private readonly stashAdapter: StashAdapter,
    private readonly whisparrAdapter: WhisparrAdapter,
    @Optional() private readonly hiddenContent?: HiddenContentService,
  ) {}

  async getScenesFeed(
    page = ScenesService.DEFAULT_PAGE,
    perPage = ScenesService.DEFAULT_PER_PAGE,
    sort: SceneFeedSort = 'TRENDING',
    direction: SortDirection = 'DESC',
    tagIds: string[] = [],
    tagMode: SceneTagMatchMode = 'OR',
    favorites?: SceneFavoritesFilter,
    studioIds: string[] = [],
    text?: string,
    exclude: string[] = [],
    tagNames: string[] = [],
    /** Also show scenes Settings → Hidden content leaves out. */
    showHidden = false,
    /** Only scenes released after this day (YYYY-MM-DD). */
    releasedAfter?: string,
  ): Promise<ScenesFeedResponseDto> {
    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();
    const startedAt = Date.now();
    const tags = await this.tagsForCatalog(catalogProvider, tagIds, tagNames);
    const tagsDoneAt = Date.now();
    if (
      tags.unknown.length > 0 &&
      (tags.ids.length === 0 || tagMode === 'AND')
    ) {
      // None of the tags exist here, or all are required and one is missing:
      // either way nothing here can match, and an unfiltered list would mislead.
      return {
        total: 0,
        page,
        perPage,
        hasMore: false,
        hidden: 0,
        items: [],
        unknownTags: tags.unknown,
        ...(tags.unchecked.length > 0 ? { uncheckedTags: tags.unchecked } : {}),
      };
    }
    const normalizedTagIds = tags.ids;
    const normalizedStudioIds = this.normalizeStudioIds(studioIds);
    // "-word" in the text search excludes it, same as the exclude list.
    const search = splitNegatedTerms(text);
    const excludeTerms = parseExcludeTerms([...exclude, ...search.excluded]);
    // Studios and tags you filtered on are shown even when hidden: you asked.
    const hiddenRules = exceptRequested(
      (await this.hiddenContent?.getRules(showHidden)) ?? EMPTY_EXCLUDE_RULES,
      { studioIds: normalizedStudioIds, tagIds: normalizedTagIds },
    );
    const needsTags = excludeTerms.length > 0 || needsSceneTags(hiddenRules);
    const catalogScenes = await this.getCatalogScenes({
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
      page,
      perPage,
      sort,
      direction,
      favorites,
      studioIds: normalizedStudioIds,
      ...(search.text ? { text: search.text } : {}),
      ...(needsTags ? { includeTagNames: true } : {}),
      ...(releasedAfter ? { releasedAfter } : {}),
      tagFilter:
        normalizedTagIds.length > 0
          ? {
              tagIds: normalizedTagIds,
              mode: tagMode,
            }
          : undefined,
    });
    // The catalog can't exclude words itself, so drop matches from each page.
    // Paging still follows the catalog, so a page can come back short.
    if (tagIds.length > 0) {
      this.logger.debug(
        `Scenes page ${page} with ${tagIds.length} tag(s): tag lookup ${tagsDoneAt - startedAt}ms, catalog ${Date.now() - tagsDoneAt}ms.`,
      );
    }
    const { scenes, hidden } = applyExcludeRules(
      catalogScenes.scenes,
      { ...EMPTY_EXCLUDE_RULES, matchers: buildExcludeMatchers(excludeTerms) },
      hiddenRules,
    );
    const statuses = await this.sceneStatusService.resolveForScenes(
      scenes.map((scene) => scene.id),
    );
    // Scenes you already have get their Stash id, so cards can show the preview.
    const localSceneIds = await this.sceneStatusService.resolveLocalSceneIds(
      scenes
        .filter((scene) => statuses.get(scene.id)?.state === 'AVAILABLE')
        .map((scene) => scene.id),
    );
    const browseOnly = await this.catalogProviderService.isBrowseOnlyRequest();

    return {
      ...(tags.unknown.length > 0 ? { unknownTags: tags.unknown } : {}),
      ...(tags.unchecked.length > 0 ? { uncheckedTags: tags.unchecked } : {}),
      total: catalogScenes.total,
      page,
      perPage,
      hasMore: page * perPage < catalogScenes.total,
      hidden,
      items: scenes.map((scene) => {
        const status = statuses.get(scene.id) ?? { state: 'NOT_REQUESTED' };
        return {
          ...this.toScenesFeedItem(
            scene,
            catalogProvider.integrationType,
            status,
            !browseOnly && isSceneStatusRequestable(status),
          ),
          localSceneId: localSceneIds.get(scene.id) ?? null,
        };
      }),
    };
  }

  /**
   * Releases dated from..to (YYYY-MM-DD) by the studios and performers you
   * starred. Asks the catalog for releases after the day before `from`,
   * oldest first, and stops once past `to`: usually one page for a month,
   * at most CALENDAR_PAGES.
   */
  async getCalendar(
    from: string,
    to: string,
    favorites: SceneFavoritesFilter = 'ALL',
  ): Promise<ScenesCalendarResponseDto> {
    const items: ScenesFeedItemDto[] = [];
    let complete = false;
    for (let page = 1; page <= ScenesService.CALENDAR_PAGES; page += 1) {
      const feed = await this.getScenesFeed(
        page,
        ScenesService.CALENDAR_PAGE_SIZE,
        'DATE',
        'ASC',
        [],
        'OR',
        favorites,
        [],
        undefined,
        [],
        [],
        false,
        dayBefore(from),
      );
      for (const item of feed.items) {
        if (
          item.releaseDate &&
          item.releaseDate >= from &&
          item.releaseDate <= to
        ) {
          items.push(item);
        }
      }
      const newest = feed.items.at(-1)?.releaseDate ?? null;
      if (!feed.hasMore || (newest !== null && newest > to)) {
        complete = true;
        break;
      }
    }
    items.sort((a, b) =>
      (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''),
    );
    return { from, to, items, complete };
  }

  async searchSceneTags(query?: string): Promise<SceneTagOptionDto[]> {
    const normalizedQuery = query?.trim() ?? '';
    if (!normalizedQuery) {
      return [];
    }

    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();

    return this.stashdbAdapter.searchTags({
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
      query: normalizedQuery,
    });
  }

  async getSceneById(stashId: string): Promise<SceneDetailsDto> {
    const sceneId = stashId.trim();
    if (!sceneId) {
      throw new BadRequestException('Scene stashId is required.');
    }

    const {
      value: scene,
      provider: catalogProvider,
      browseOnly,
    } = await this.catalogProviderService.withDetailFallback((provider) =>
      this.stashdbAdapter.getSceneById(sceneId, {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    );
    // Three independent lookups (database, Stash, Whisparr): run them together.
    const [status, stash, whisparr] = await Promise.all([
      this.sceneStatusService.resolveForScene(scene.id),
      this.resolveStashAvailability(scene.id, catalogProvider.providerKey),
      this.resolveWhisparrAvailability(scene.id),
    ]);

    return {
      id: scene.id,
      title: scene.title,
      description: scene.details,
      imageUrl: scene.imageUrl,
      images: scene.images,
      studioId: scene.studioId,
      studioIsFavorite: scene.studioIsFavorite,
      studio: scene.studioName,
      studioImageUrl: scene.studioImageUrl,
      studioUrl: this.resolveStudioUrl(scene.sourceUrls),
      releaseDate: scene.releaseDate,
      duration: scene.duration,
      tags: scene.tags,
      performers: scene.performers.map((performer) => ({
        ...performer,
        cardImageUrl: withStashImageSize(performer.imageUrl, 300),
      })),
      sourceUrls: scene.sourceUrls,
      source: catalogProvider.integrationType,
      status,
      // Scenes from a browse-only provider can't be sent to Whisparr.
      requestable: !browseOnly && isSceneStatusRequestable(status),
      stash,
      whisparr: browseOnly ? null : whisparr,
    };
  }

  async favoriteStudio(
    studioId: string,
    favorite: boolean,
  ): Promise<{ favorited: boolean; alreadyFavorited: boolean }> {
    const normalizedStudioId = studioId.trim();
    if (!normalizedStudioId) {
      throw new BadRequestException('Studio id is required.');
    }

    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();
    try {
      return await this.stashdbAdapter.favoriteStudio(
        normalizedStudioId,
        favorite,
        { baseUrl: catalogProvider.baseUrl, apiKey: catalogProvider.apiKey },
      );
    } finally {
      // Favorite-studio lists change with this, so don't serve them from
      // cache. Cleared afterwards (even on failure), so a feed read while the
      // change was in flight can't cache the old list.
      this.catalogCache.clear();
    }
  }

  private async resolveStashAvailability(
    stashId: string,
    activeCatalogProviderKey: CatalogProviderKey | null,
  ): Promise<SceneStashAvailabilityDto | null> {
    try {
      if (!activeCatalogProviderKey) {
        return null;
      }

      const integration = await this.integrationsService.findOne(
        IntegrationType.STASH,
      );

      if (
        !integration.enabled ||
        integration.status !== IntegrationStatus.CONFIGURED
      ) {
        return null;
      }

      const baseUrl = integration.baseUrl?.trim();
      if (!baseUrl) {
        return null;
      }

      const copies = await this.stashAdapter.findScenesByStashId(
        stashId,
        {
          baseUrl,
          apiKey: integration.apiKey,
        },
        {
          providerKey: activeCatalogProviderKey,
        },
      );

      return {
        exists: copies.length > 0,
        hasMultipleCopies: copies.length > 1,
        copies,
      };
    } catch {
      return null;
    }
  }

  private toScenesFeedItem(
    scene: {
      id: string;
      title: string;
      details: string | null;
      imageUrl: string | null;
      studioId: string | null;
      studioName: string | null;
      studioImageUrl: string | null;
      releaseDate: string | null;
      productionDate: string | null;
      date: string | null;
      duration: number | null;
    },
    source: 'STASHDB' | 'FANSDB',
    status: SceneStatusDto,
    requestable: boolean,
  ) {
    return {
      id: scene.id,
      title: scene.title,
      description: scene.details,
      imageUrl: scene.imageUrl,
      cardImageUrl: withStashImageSize(scene.imageUrl, 600),
      studioId: scene.studioId,
      studio: scene.studioName,
      studioImageUrl: scene.studioImageUrl,
      releaseDate: scene.releaseDate ?? scene.productionDate ?? scene.date,
      duration: scene.duration,
      type: 'SCENE' as const,
      source,
      status,
      requestable,
    };
  }

  /** One page of catalog scenes, shared for a minute between identical requests. */
  /**
   * The tag ids to filter on in this catalog. Tag ids belong to one catalog,
   * so a StashDB rail's tags opened while browsing FansDB are looked up by
   * name there; names the catalog doesn't have come back as unknown.
   */
  private async tagsForCatalog(
    provider: ConfiguredCatalogProvider,
    tagIds: string[],
    tagNames: string[],
  ): Promise<{ ids: string[]; unknown: string[]; unchecked: string[] }> {
    const ids = this.normalizeTagIds(tagIds);
    if (ids.length === 0 || tagNames.length !== tagIds.length) {
      return { ids, unknown: [], unchecked: [] };
    }
    const config = { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
    const pairs = tagIds.map((id, index) => ({
      id: id.trim(),
      name: tagNames[index]?.trim() ?? '',
    }));
    const lookable = pairs.filter(({ id, name }) => name && name !== id);
    // Batched: a rail can carry dozens of tags, and one request per tag made
    // a cold FansDB page take ten seconds.
    const byName = await this.cachedTagLookup(
      provider,
      lookable.map(({ name }) => `name:${name.toLowerCase()}`),
      async (keys) => {
        const names = keys.map((key) => key.slice('name:'.length));
        const found = await this.stashdbAdapter.findTagIdsByNames(
          config,
          names,
        );
        return new Map(
          names.map((name) => [`name:${name}`, found.get(name) ?? null]),
        );
      },
    );
    // No tag by that name, but the id may still be this catalog's own (a
    // tag renamed since the rail was saved).
    const missingIds = lookable
      .filter(
        ({ id, name }) =>
          id && byName?.get(`name:${name.toLowerCase()}`) === null,
      )
      .map(({ id }) => `id:${id}`);
    const byId = missingIds.length
      ? await this.cachedTagLookup(provider, missingIds, async (keys) => {
          const ids = keys.map((key) => key.slice('id:'.length));
          const existing = await this.stashdbAdapter.existingTagIds(
            config,
            ids,
          );
          return new Map(
            ids.map((id) => [`id:${id}`, existing.has(id) ? id : null]),
          );
        })
      : new Map<string, string | null>();
    const looked = pairs.map(({ id, name }) => {
      if (!name || name === id || !byName) {
        return { id, name, found: undefined };
      }
      let found = byName.get(`name:${name.toLowerCase()}`);
      if (found === null && id) {
        found = byId ? byId.get(`id:${id}`) : undefined;
      }
      return { id, name, found };
    });
    const resolved: string[] = [];
    const unknown: string[] = [];
    const unchecked: string[] = [];
    for (const { id, name, found } of looked) {
      if (!id) {
        continue;
      }
      if (found === undefined) {
        // No name, or couldn't ask: keep the id, as before.
        resolved.push(id);
        if (name && name !== id) {
          unchecked.push(name);
        }
      } else if (found === null) {
        unknown.push(name);
      } else {
        resolved.push(found);
      }
    }
    return { ids: this.normalizeTagIds(resolved), unknown, unchecked };
  }

  /**
   * Tag lookups through the hour-long cache: keys not cached are asked in one
   * go. Undefined when the catalog couldn't be asked.
   */
  private async cachedTagLookup(
    provider: ConfiguredCatalogProvider,
    keys: string[],
    ask: (keys: string[]) => Promise<Map<string, string | null>>,
  ): Promise<Map<string, string | null> | undefined> {
    const now = Date.now();
    const result = new Map<string, string | null>();
    const uncached: string[] = [];
    for (const key of new Set(keys)) {
      const cached = this.tagIdsByName.get(`${provider.baseUrl}|${key}`);
      if (cached && cached.expiresAt > now) {
        result.set(key, cached.id);
      } else {
        uncached.push(key);
      }
    }
    if (uncached.length === 0) {
      return result;
    }
    try {
      const asked = await ask(uncached);
      for (const key of uncached) {
        const id = asked.get(key) ?? null;
        this.tagIdsByName.set(`${provider.baseUrl}|${key}`, {
          expiresAt: now + TAG_LOOKUP_TTL_MS,
          id,
        });
        result.set(key, id);
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Couldn't look up ${uncached.length} tag(s) in the catalog: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private getCatalogScenes(
    params: StashdbAdapterSceneFeedConfig,
  ): Promise<StashdbSceneList> {
    const now = Date.now();
    for (const [key, entry] of this.catalogCache) {
      if (entry.expiresAt <= now) {
        this.catalogCache.delete(key);
      }
    }

    const key = JSON.stringify(params);
    const cached = this.catalogCache.get(key);
    if (cached) {
      return cached.value;
    }

    const value = this.stashdbAdapter.getScenesBySort(params);
    this.catalogCache.set(key, {
      expiresAt: now + ScenesService.CATALOG_CACHE_TTL_MS,
      value,
    });
    // Failures aren't kept: the next request tries again.
    value.catch(() => {
      if (this.catalogCache.get(key)?.value === value) {
        this.catalogCache.delete(key);
      }
    });
    while (this.catalogCache.size > ScenesService.CATALOG_CACHE_MAX_ENTRIES) {
      const oldest = this.catalogCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.catalogCache.delete(oldest);
    }

    return value;
  }

  private normalizeTagIds(tagIds: string[]): string[] {
    return [...new Set(tagIds.map((tagId) => tagId.trim()).filter(Boolean))];
  }

  private normalizeStudioIds(studioIds: string[]): string[] {
    return [
      ...new Set(studioIds.map((studioId) => studioId.trim()).filter(Boolean)),
    ];
  }

  private resolveStudioUrl(
    sourceUrls: Array<{ url: string; type: string | null }>,
  ): string | null {
    const studioEntry = sourceUrls.find((entry) => {
      const normalizedType = entry.type?.trim().toLowerCase() ?? '';
      return normalizedType.includes('studio');
    });

    return studioEntry?.url ?? null;
  }

  private async resolveWhisparrAvailability(
    stashId: string,
  ): Promise<SceneWhisparrAvailabilityDto | null> {
    try {
      const integration = await this.integrationsService.findOne(
        IntegrationType.WHISPARR,
      );

      if (
        !integration.enabled ||
        integration.status !== IntegrationStatus.CONFIGURED
      ) {
        return null;
      }

      const baseUrl = integration.baseUrl?.trim();
      if (!baseUrl) {
        return null;
      }

      const movie = await this.whisparrAdapter.findMovieByStashId(stashId, {
        baseUrl,
        apiKey: integration.apiKey,
      });

      if (!movie) {
        return null;
      }

      return {
        exists: true,
        viewUrl: this.whisparrAdapter.buildSceneViewUrl(baseUrl, movie.movieId),
      };
    } catch {
      return null;
    }
  }
}

/** The day before a YYYY-MM-DD day. */
function dayBefore(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  return new Date(time).toISOString().slice(0, 10);
}
