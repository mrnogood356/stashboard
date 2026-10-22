import { DiscoverResponseDto } from '../discover/dto/discover-item.dto';
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';
import { isSceneStatusRequestable } from '../scene-status/dto/scene-status.dto';
import { SceneStatusService } from '../scene-status/scene-status.service';
import {
  EMPTY_EXCLUDE_RULES,
  applyExcludeRules,
  exceptRequested,
  needsSceneTags,
} from '../scenes/scene-exclude-terms.util';
import { PerformerDetailsDto } from './dto/performer-details.dto';
import { PerformerFeedResponseDto } from './dto/performer-feed-response.dto';
import {
  PerformerScenesSort,
  SortDirection as PerformerScenesSortDirection,
} from './dto/performer-scenes-query.dto';
import { PerformerStudioOptionDto } from './dto/performer-studio-option.dto';
import {
  PerformerGender,
  PerformerSort,
  SortDirection as PerformerSortDirection,
} from './dto/performers-query.dto';

@Injectable()
export class PerformersService {
  private static readonly DEFAULT_PAGE = 1;
  private static readonly DEFAULT_PER_PAGE = 24;
  private static readonly DEFAULT_SCENES_PER_PAGE = 24;
  private static readonly DEFAULT_PERFORMERS_SORT_DIRECTION: PerformerSortDirection =
    'ASC';
  private static readonly DEFAULT_SCENES_SORT_DIRECTION: PerformerScenesSortDirection =
    'DESC';

  constructor(
    private readonly catalogProviderService: CatalogProviderService,
    private readonly stashdbAdapter: StashdbAdapter,
    private readonly sceneStatusService: SceneStatusService,
    @Optional() private readonly hiddenContent?: HiddenContentService,
  ) {}

  async getPerformersFeed(
    page = PerformersService.DEFAULT_PAGE,
    perPage = PerformersService.DEFAULT_PER_PAGE,
    filters?: {
      name?: string;
      gender?: PerformerGender;
      sort?: PerformerSort;
      direction?: PerformerSortDirection;
      favoritesOnly?: boolean;
    },
  ): Promise<PerformerFeedResponseDto> {
    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();

    const performers = await this.stashdbAdapter.getPerformersFeed({
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
      page,
      perPage,
      name: filters?.name,
      gender: filters?.gender,
      sort: filters?.sort ?? 'NAME',
      direction:
        filters?.direction ??
        PerformersService.DEFAULT_PERFORMERS_SORT_DIRECTION,
      favoritesOnly: filters?.favoritesOnly === true,
    });

    const hasMore = page * perPage < performers.total;

    return {
      total: performers.total,
      page,
      perPage,
      hasMore,
      items: performers.performers.map((performer) => ({
        id: performer.id,
        name: performer.name,
        gender: performer.gender,
        sceneCount: performer.sceneCount,
        isFavorite: performer.isFavorite,
        imageUrl: performer.imageUrl,
        cardImageUrl: withStashImageSize(performer.imageUrl, 300),
      })),
    };
  }

  async getPerformerById(performerId: string): Promise<PerformerDetailsDto> {
    const normalizedPerformerId = performerId.trim();
    if (!normalizedPerformerId) {
      throw new BadRequestException('Performer id is required.');
    }

    const { value: performer } =
      await this.catalogProviderService.withDetailFallback((provider) =>
        this.stashdbAdapter.getPerformerById(normalizedPerformerId, {
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
        }),
      );

    return {
      id: performer.id,
      name: performer.name,
      disambiguation: performer.disambiguation,
      aliases: performer.aliases,
      gender: performer.gender,
      birthDate: performer.birthDate,
      deathDate: performer.deathDate,
      age: performer.age,
      ethnicity: performer.ethnicity,
      country: performer.country,
      eyeColor: performer.eyeColor,
      hairColor: performer.hairColor,
      height: performer.height,
      cupSize: performer.cupSize,
      bandSize: performer.bandSize,
      waistSize: performer.waistSize,
      hipSize: performer.hipSize,
      breastType: performer.breastType,
      careerStartYear: performer.careerStartYear,
      careerEndYear: performer.careerEndYear,
      deleted: performer.deleted,
      mergedIds: performer.mergedIds,
      mergedIntoId: performer.mergedIntoId,
      isFavorite: performer.isFavorite,
      createdAt: performer.createdAt,
      updatedAt: performer.updatedAt,
      imageUrl: performer.imageUrl,
      images: performer.images,
    };
  }

  async getPerformerScenes(
    performerId: string,
    page = PerformersService.DEFAULT_PAGE,
    perPage = PerformersService.DEFAULT_SCENES_PER_PAGE,
    filters?: {
      studioIds?: string[];
      tagIds?: string[];
      sort?: PerformerScenesSort;
      direction?: PerformerScenesSortDirection;
      onlyFavoriteStudios?: boolean;
      /** Also show scenes Settings → Hidden content leaves out. */
      showHidden?: boolean;
    },
  ): Promise<DiscoverResponseDto> {
    const normalizedPerformerId = performerId.trim();
    if (!normalizedPerformerId) {
      throw new BadRequestException('Performer id is required.');
    }

    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();
    const studioIds = this.normalizeIds(filters?.studioIds ?? []);
    const tagIds = this.normalizeIds(filters?.tagIds ?? []);
    // The performer's own page, and studios or tags you filtered on, are
    // shown even when hidden: you asked for them.
    const hiddenRules = exceptRequested(
      (await this.hiddenContent?.getRules(filters?.showHidden === true)) ??
        EMPTY_EXCLUDE_RULES,
      { performerIds: [normalizedPerformerId], studioIds, tagIds },
    );
    const scenes = await this.stashdbAdapter.getScenesForPerformer({
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
      performerId: normalizedPerformerId,
      page,
      perPage,
      sort: filters?.sort ?? 'DATE',
      direction:
        filters?.direction ?? PerformersService.DEFAULT_SCENES_SORT_DIRECTION,
      studioIds,
      tagIds,
      onlyFavoriteStudios: filters?.onlyFavoriteStudios === true,
      ...(needsSceneTags(hiddenRules) ? { includeTagNames: true } : {}),
    });
    // Like the Scenes page: drop hidden scenes from each page, so a page can
    // come back short while paging still follows the catalog.
    const { scenes: shown, hidden } = applyExcludeRules(
      scenes.scenes,
      EMPTY_EXCLUDE_RULES,
      hiddenRules,
    );

    const hasMore = page * perPage < scenes.total;
    const [statuses, browseOnly] = await Promise.all([
      this.sceneStatusService.resolveForScenes(shown.map((scene) => scene.id)),
      this.catalogProviderService.isBrowseOnlyRequest(),
    ]);

    return {
      total: scenes.total,
      page,
      perPage,
      hasMore,
      hidden,
      items: shown.map((scene) => {
        const status = statuses.get(scene.id) ?? {
          state: 'NOT_REQUESTED' as const,
        };
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
          type: 'SCENE',
          source: catalogProvider.integrationType,
          status,
          // Scenes from a browse-only provider can't be sent to Whisparr.
          requestable: !browseOnly && isSceneStatusRequestable(status),
        };
      }),
    };
  }

  async searchStudios(query?: string): Promise<PerformerStudioOptionDto[]> {
    const normalizedQuery = query?.trim() ?? '';
    if (!normalizedQuery) {
      return [];
    }

    const config = await this.getActiveCatalogConfig();
    return this.stashdbAdapter.searchStudios(normalizedQuery, config);
  }

  async favoritePerformer(
    performerId: string,
    favorite: boolean,
  ): Promise<{ favorited: boolean; alreadyFavorited: boolean }> {
    const normalizedPerformerId = performerId.trim();
    if (!normalizedPerformerId) {
      throw new BadRequestException('Performer id is required.');
    }

    const config = await this.getActiveCatalogConfig();
    return this.stashdbAdapter.favoritePerformer(
      normalizedPerformerId,
      favorite,
      config,
    );
  }

  private async getActiveCatalogConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  }> {
    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();

    return {
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
    };
  }

  private normalizeIds(ids: string[]): string[] {
    return [
      ...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)),
    ];
  }
}
