import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  HomeRail,
  HomeRailContentType,
  HomeRailKey,
  HomeRailKind,
  HomeRailSource,
  Prisma,
} from '@prisma/client';
import { AcquisitionService } from '../acquisition/acquisition.service';
import { LibrarySceneFeedItemDto } from '../library/dto/library-scenes-feed.dto';
import { LibraryService } from '../library/library.service';
import { PrismaService } from '../prisma/prisma.service';
import { stashMediaUrl } from '../media/media-url.util';
import { stashImageVersion } from '../providers/stash/stash-image-version.util';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import {
  StashAdapter,
  type LibraryScenePick,
  type StashLocalSceneFeedItem,
} from '../providers/stash/stash.adapter';
import { type StashdbScene } from '../providers/stashdb/stashdb.adapter';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';
import { PerformerStudioOptionDto } from '../performers/dto/performer-studio-option.dto';
import { SceneTagOptionDto } from '../scenes/dto/scene-tag-option.dto';
import {
  SceneStatusDto,
  isSceneStatusRequestable,
} from '../scene-status/dto/scene-status.dto';
import { SceneStatusService } from '../scene-status/scene-status.service';
import {
  HOME_RAIL_CONTENT_TYPE_VALUES,
  HOME_RAIL_DIRECTION_VALUES,
  HOME_RAIL_FAVORITES_VALUES,
  HOME_RAIL_SCENE_LIMIT_DEFAULT,
  HOME_RAIL_SCENE_LIMIT_MAX,
  HOME_RAIL_SCENE_LIMIT_MIN,
  HOME_RAIL_SOURCE_VALUES,
  HOME_RAIL_STASH_SCENE_SORT_VALUES,
  HOME_RAIL_STASHDB_SCENE_SORT_VALUES,
  HOME_RAIL_TAG_MODE_VALUES,
  DEFAULT_HOME_ROW_DISPLAY,
  HOME_ROW_DEVICE_VALUES,
  HOME_ROW_SIZE_VALUES,
  HOME_ROW_STYLE_VALUES,
  HomeRailDto,
  type HomeRowDisplayDto,
  type HomeRailSceneConfigDto,
  type HomeRailSource as HomeRailDtoSource,
  type HomeRailStashSceneConfigDto,
  type HomeRailStashdbSceneConfigDto,
} from './dto/home-rail.dto';
import { UpdateHomeRailsDto } from './dto/update-home-rails.dto';
import {
  HOME_ROW_GALLERY_IDS,
  type HomeRowGalleryId,
  HomeRowGalleryItemDto,
  UpdateHomeRowDisplayDto,
} from './dto/home-row-display.dto';
import {
  CreateHomeRailDto,
  UpdateHomeRailDto,
} from './dto/create-home-rail.dto';
import {
  HomeRailContentDto,
  HomeRailItemDto,
} from './dto/home-rail-content.dto';
import { HybridScenesService } from '../hybrid-scenes/hybrid-scenes.service';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { ScenesService } from '../scenes/scenes.service';
import { exceptRequested } from '../scenes/scene-exclude-terms.util';
import {
  LEGACY_HOME_RAIL_LIBRARY_AVAILABILITY_VALUES,
  type LegacyHomeRailHybridSceneConfig,
  type LegacyHomeRailLibraryAvailability,
} from './home-rail-hybrid.internal';

type HomeRailStoredSceneConfig =
  HomeRailSceneConfigDto | LegacyHomeRailHybridSceneConfig;

/** Progress past which a scene counts as finished for Continue Watching. */
const CONTINUE_WATCHING_FINISHED = 0.95;
const CONTINUE_WATCHING_SPARE = 8;

/** A library row's config when its scenes are picked by the row itself. */
const LIBRARY_ROW_CONFIG: HomeRailStashSceneConfigDto = {
  sort: 'CREATED_AT',
  direction: 'DESC',
  titleQuery: null,
  tagIds: [],
  tagNames: [],
  tagMode: null,
  studioIds: [],
  studioNames: [],
  favoritePerformersOnly: false,
  favoriteStudiosOnly: false,
  favoriteTagsOnly: false,
  limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
};

/**
 * Ready-made rows that are only on Home once added from "Add a row" (and can
 * be removed again), unlike the built-in rows every install starts with.
 */
const STOCK_HOME_ROWS: Array<{
  key: HomeRailKey;
  title: string;
  subtitle: string;
  from: HomeRowGalleryItemDto['from'];
}> = [
  {
    key: HomeRailKey.REDISCOVER,
    title: 'Rediscover',
    subtitle: 'Scenes you watched a while ago.',
    from: 'library',
  },
  {
    key: HomeRailKey.TOP_RATED,
    title: 'Top Rated',
    subtitle: 'Your highest-rated scenes in Stash.',
    from: 'library',
  },
  {
    key: HomeRailKey.QUICK_PICKS,
    title: 'Quick Picks',
    subtitle: 'Scenes under 20 minutes.',
    from: 'library',
  },
  {
    key: HomeRailKey.LIBRARY_4K,
    title: 'In 4K',
    subtitle: 'The newest 4K scenes in your library.',
    from: 'library',
  },
  {
    key: HomeRailKey.COMING_SOON,
    title: 'Coming Soon',
    subtitle: 'Scenes Whisparr is waiting for, by release date.',
    from: 'whisparr',
  },
];

/** Not watched again for this long counts as "a while ago". */
const REDISCOVER_AFTER_DAYS = 60;
/** "Quick" scenes are shorter than this. */
const QUICK_PICK_SECONDS = 20 * 60;
/** How far ahead Coming Soon looks. */
const COMING_SOON_DAYS = 60;

const DEFAULT_HOME_RAILS: Array<{
  key: HomeRailKey;
  title: string;
  subtitle: string;
  enabled: boolean;
  sortOrder: number;
  source: HomeRailSource;
  contentType: HomeRailContentType;
  config: HomeRailSceneConfigDto;
}> = [
  {
    key: HomeRailKey.FAVORITE_STUDIOS,
    title: 'Latest From Favorite Studios',
    subtitle: 'The newest scenes from studios you’ve starred.',
    enabled: true,
    sortOrder: 0,
    source: HomeRailSource.STASHDB,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'DATE',
      direction: 'DESC',
      favorites: 'STUDIO',
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
  {
    key: HomeRailKey.FAVORITE_PERFORMERS,
    title: 'Latest From Favorite Performers',
    subtitle: 'The newest scenes from performers you’ve starred.',
    enabled: true,
    sortOrder: 1,
    source: HomeRailSource.STASHDB,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'DATE',
      direction: 'DESC',
      favorites: 'PERFORMER',
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
  {
    key: HomeRailKey.RECENTLY_ADDED_LIBRARY,
    title: 'Recently Added to Library',
    subtitle: 'The newest scenes in your library.',
    enabled: true,
    sortOrder: 2,
    source: HomeRailSource.STASH,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'CREATED_AT',
      direction: 'DESC',
      titleQuery: null,
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      favoritePerformersOnly: false,
      favoriteStudiosOnly: false,
      favoriteTagsOnly: false,
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
  {
    key: HomeRailKey.STILL_WAITING,
    title: 'Still Waiting',
    subtitle: "Requested scenes that haven't finished downloading yet.",
    enabled: true,
    sortOrder: 3,
    source: HomeRailSource.STASH,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'CREATED_AT',
      direction: 'DESC',
      titleQuery: null,
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      favoritePerformersOnly: false,
      favoriteStudiosOnly: false,
      favoriteTagsOnly: false,
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
  {
    key: HomeRailKey.UNWATCHED_LIBRARY,
    title: 'Unwatched in Your Library',
    subtitle: 'Scenes you haven’t played yet, newest first.',
    enabled: true,
    sortOrder: 4,
    source: HomeRailSource.STASH,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'CREATED_AT',
      direction: 'DESC',
      titleQuery: null,
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      favoritePerformersOnly: false,
      favoriteStudiosOnly: false,
      favoriteTagsOnly: false,
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
  {
    key: HomeRailKey.MOST_PLAYED_LIBRARY,
    title: 'Most Played',
    subtitle: 'Your most-watched scenes in Stash.',
    enabled: true,
    sortOrder: 5,
    source: HomeRailSource.STASH,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'CREATED_AT',
      direction: 'DESC',
      titleQuery: null,
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      favoritePerformersOnly: false,
      favoriteStudiosOnly: false,
      favoriteTagsOnly: false,
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
  {
    key: HomeRailKey.CONTINUE_WATCHING,
    title: 'Continue Watching',
    subtitle: 'Pick up where you left off.',
    enabled: true,
    sortOrder: -1,
    source: HomeRailSource.STASH,
    contentType: HomeRailContentType.SCENES,
    config: {
      sort: 'CREATED_AT',
      direction: 'DESC',
      titleQuery: null,
      tagIds: [],
      tagNames: [],
      tagMode: null,
      studioIds: [],
      studioNames: [],
      favoritePerformersOnly: false,
      favoriteStudiosOnly: false,
      favoriteTagsOnly: false,
      limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
    },
  },
];

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);
  private railsReady: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly libraryService: LibraryService,
    private readonly catalogProviderService: CatalogProviderService,
    private readonly sceneStatusService: SceneStatusService,
    private readonly hybridScenesService: HybridScenesService,
    private readonly acquisitionService: AcquisitionService,
    @Optional() private readonly stashAdapter?: StashAdapter,
    @Optional() private readonly hiddenContent?: HiddenContentService,
    @Optional() private readonly scenes?: ScenesService,
  ) {}

  async getRails(): Promise<HomeRailDto[]> {
    await this.ensureUserFacingRailsReady();
    const rails = await this.listRails();
    return rails.map((rail) => this.toDto(rail));
  }

  async updateRails(payload: UpdateHomeRailsDto): Promise<HomeRailDto[]> {
    await this.ensureUserFacingRailsReady();
    const existingRails = await this.listRails();
    this.validateSubmittedRails(payload, existingRails);

    await this.prisma.$transaction(
      payload.rails.map((rail, index) =>
        this.prisma.homeRail.update({
          where: { id: rail.id },
          data: {
            enabled: rail.enabled,
            sortOrder: index,
          },
        }),
      ),
    );
    this.logger.log(
      `Saved the Home rail order: ${payload.rails.filter((rail) => rail.enabled).length} of ${payload.rails.length} shown.`,
    );

    return this.getRails();
  }

  async createRail(payload: CreateHomeRailDto): Promise<HomeRailDto> {
    await this.ensureUserFacingRailsReady();
    this.ensureSupportedCustomRailSource(payload.source);
    const lastRail = await this.prisma.homeRail.findFirst({
      orderBy: { sortOrder: 'desc' },
    });

    const created = await this.prisma.homeRail.create({
      data: {
        key: null,
        kind: HomeRailKind.CUSTOM,
        source: payload.source,
        contentType: HomeRailContentType.SCENES,
        title: payload.title.trim(),
        subtitle: this.normalizeSubtitle(payload.subtitle),
        enabled: payload.enabled,
        sortOrder: (lastRail?.sortOrder ?? -1) + 1,
        config: this.normalizeSceneRailConfig(
          payload.source,
          payload.config,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Added the Home rail “${created.title}”.`);

    return this.toDto(created);
  }

  async updateRail(
    id: string,
    payload: UpdateHomeRailDto,
  ): Promise<HomeRailDto> {
    await this.ensureUserFacingRailsReady();
    this.ensureSupportedCustomRailSource(payload.source);
    const existingRail = await this.requireCustomRail(id);
    if (existingRail.source === HomeRailSource.HYBRID) {
      throw new BadRequestException(
        'Legacy hybrid Home rails are disabled and cannot be edited.',
      );
    }
    if (payload.source !== existingRail.source) {
      throw new BadRequestException(
        'Custom Home rail source cannot be changed after creation.',
      );
    }

    const updated = await this.prisma.homeRail.update({
      where: { id },
      data: {
        title: payload.title.trim(),
        subtitle: this.normalizeSubtitle(payload.subtitle),
        enabled: payload.enabled,
        config: this.normalizeSceneRailConfig(
          existingRail.source,
          payload.config,
        ) as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Saved the Home rail “${updated.title}”.`);

    return this.toDto(updated);
  }

  async deleteRail(id: string): Promise<void> {
    await this.ensureUserFacingRailsReady();
    const rail = await this.requireRemovableRail(id);
    await this.prisma.homeRail.delete({ where: { id } });
    await this.reindexSortOrders();
    this.logger.log(`Removed the Home rail “${rail.title}”.`);
  }

  /** Changes how one row looks; anything left out keeps its value. */
  async updateRowDisplay(
    id: string,
    change: UpdateHomeRowDisplayDto,
  ): Promise<HomeRailDto> {
    await this.ensureUserFacingRailsReady();
    const rail = await this.prisma.homeRail.findUnique({ where: { id } });
    if (!rail) {
      throw new NotFoundException('Home row not found.');
    }
    const current = readRowDisplay(rail.display);
    const next: HomeRowDisplayDto = { ...current };
    for (const field of Object.keys(DEFAULT_HOME_ROW_DISPLAY) as Array<
      keyof HomeRowDisplayDto
    >) {
      if (change[field] !== undefined) {
        (next as unknown as Record<string, unknown>)[field] = change[field];
      }
    }
    // An empty name, or the row's own name, means "use the row's own name".
    const title = next.title?.trim() ?? '';
    next.title = title && title !== rail.title ? title : null;
    const updated = await this.prisma.homeRail.update({
      where: { id },
      data: { display: next as unknown as Prisma.InputJsonValue },
    });
    this.logger.log(`Changed how the Home row “${rail.title}” looks.`);
    return this.toDto(updated);
  }

  /** Every ready-made row, and whether it's on Home already. */
  async getRowGallery(): Promise<HomeRowGalleryItemDto[]> {
    await this.ensureUserFacingRailsReady();
    const rails = await this.listRails();
    const shownKeys = new Set(
      rails.filter((rail) => rail.enabled && rail.key).map((rail) => rail.key),
    );
    return HOME_ROW_GALLERY_IDS.map((id) => {
      const preset = describeGalleryRow(id);
      return {
        id,
        ...preset,
        added: !preset.repeatable && shownKeys.has(id as HomeRailKey),
      };
    });
  }

  /**
   * Puts a ready-made row on Home, at the end: turns a built-in one back on,
   * adds a stock one, or starts a row of your own from a preset.
   */
  async addGalleryRow(id: HomeRowGalleryId): Promise<HomeRailDto> {
    await this.ensureUserFacingRailsReady();
    const last = await this.prisma.homeRail.findFirst({
      orderBy: { sortOrder: 'desc' },
    });
    const sortOrder = (last?.sortOrder ?? -1) + 1;

    const builtIn = DEFAULT_HOME_RAILS.find((rail) => rail.key === id);
    if (builtIn) {
      const updated = await this.prisma.homeRail.update({
        where: { key: builtIn.key },
        data: { enabled: true, sortOrder },
      });
      this.logger.log(`Turned the Home row “${updated.title}” back on.`);
      return this.toDto(updated);
    }

    const stock = STOCK_HOME_ROWS.find((row) => row.key === id);
    if (stock) {
      const saved = await this.prisma.homeRail.upsert({
        where: { key: stock.key },
        update: { enabled: true, sortOrder },
        create: {
          key: stock.key,
          kind: HomeRailKind.BUILTIN,
          source: HomeRailSource.STASH,
          contentType: HomeRailContentType.SCENES,
          title: stock.title,
          subtitle: stock.subtitle,
          enabled: true,
          sortOrder,
          config: LIBRARY_ROW_CONFIG as unknown as Prisma.InputJsonValue,
        },
      });
      this.logger.log(`Added the Home row “${saved.title}”.`);
      return this.toDto(saved);
    }

    const preset = presetRow(id);
    if (!preset) {
      throw new BadRequestException('There’s no such ready-made row.');
    }
    return this.createRail({ ...preset, enabled: true });
  }

  async getRailContent(id: string): Promise<HomeRailContentDto> {
    await this.ensureUserFacingRailsReady();
    const rail = await this.prisma.homeRail.findUnique({ where: { id } });
    if (!rail) {
      throw new NotFoundException('Home rail not found.');
    }

    if (rail.source === HomeRailSource.HYBRID && !rail.enabled) {
      throw new NotFoundException('Home rail not found.');
    }

    if (rail.contentType !== HomeRailContentType.SCENES) {
      throw new BadRequestException('Unsupported Home rail content type.');
    }

    switch (rail.key) {
      case HomeRailKey.STILL_WAITING:
        return this.getStillWaitingRailContent(rail);
      case HomeRailKey.UNWATCHED_LIBRARY:
        return this.getPlaybackRailContent(rail, 'UNWATCHED');
      case HomeRailKey.MOST_PLAYED_LIBRARY:
        return this.getPlaybackRailContent(rail, 'MOST_PLAYED');
      case HomeRailKey.CONTINUE_WATCHING:
        return this.getContinueWatchingRailContent(rail);
      case HomeRailKey.REDISCOVER:
      case HomeRailKey.TOP_RATED:
      case HomeRailKey.QUICK_PICKS:
      case HomeRailKey.LIBRARY_4K:
        return this.getPickedLibraryRowContent(rail, rail.key);
      case HomeRailKey.COMING_SOON:
        return this.getComingSoonRowContent(rail);
      default:
        break;
    }

    if (rail.source === HomeRailSource.STASH) {
      return this.getStashRailContent(rail);
    }

    if (rail.source === HomeRailSource.HYBRID) {
      return this.getHybridRailContent(rail);
    }

    throw new BadRequestException(
      'This Home rail is loaded through the scenes feed endpoint instead.',
    );
  }

  async searchStashTags(query?: string): Promise<SceneTagOptionDto[]> {
    const normalizedQuery = query?.trim() ?? '';
    if (!normalizedQuery) {
      return [];
    }

    const tags = await this.libraryService.searchTags(normalizedQuery);
    return tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      description: null,
      aliases: [],
    }));
  }

  async searchStashStudios(
    query?: string,
  ): Promise<PerformerStudioOptionDto[]> {
    const normalizedQuery = query?.trim() ?? '';
    if (!normalizedQuery) {
      return [];
    }

    const studios = await this.libraryService.searchStudios(normalizedQuery);
    return studios.map((studio) => ({
      ...studio,
      childStudios: [],
    }));
  }

  /**
   * Built-in rails are set up once per process, not on every Home request
   * (each one is 8 writes, and the page asks for every rail's content).
   */
  private ensureUserFacingRailsReady(): Promise<void> {
    this.railsReady ??= (async () => {
      await this.ensureDefaultRails();
      await this.disableLegacyHybridRails();
      // A built-in rail added in an update can land on a sortOrder a custom
      // rail already uses; renumber so every rail has its own place.
      await this.reindexSortOrders();
    })().catch((error: unknown) => {
      // Try again on the next request.
      this.railsReady = null;
      this.logger.warn(
        `Couldn't set up the built-in Home rails: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    });
    return this.railsReady;
  }

  private async ensureDefaultRails(): Promise<void> {
    for (const rail of DEFAULT_HOME_RAILS) {
      await this.prisma.homeRail.upsert({
        where: { key: rail.key },
        update: {
          kind: HomeRailKind.BUILTIN,
          source: rail.source,
          contentType: rail.contentType,
          title: rail.title,
          subtitle: rail.subtitle,
          config: rail.config as unknown as Prisma.InputJsonValue,
        },
        create: {
          key: rail.key,
          kind: HomeRailKind.BUILTIN,
          source: rail.source,
          contentType: rail.contentType,
          title: rail.title,
          subtitle: rail.subtitle,
          enabled: rail.enabled,
          sortOrder: rail.sortOrder,
          config: rail.config as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  private async disableLegacyHybridRails(): Promise<void> {
    await this.prisma.homeRail.updateMany({
      where: {
        source: HomeRailSource.HYBRID,
        enabled: true,
      },
      data: {
        enabled: false,
      },
    });
  }

  private railLimit(rail: HomeRail): number {
    const display = readRowDisplay(rail.display);
    if (display.limit !== null) {
      return display.limit;
    }
    return this.normalizeSceneRailConfig(
      'STASH',
      rail.config,
      DEFAULT_HOME_RAILS.find((defaultRail) => defaultRail.key === rail.key)
        ?.config ?? null,
    ).limit;
  }

  /** Library scenes a stock row picks: rediscover, top rated, quick, 4K. */
  private async getPickedLibraryRowContent(
    rail: HomeRail,
    key: HomeRailKey,
  ): Promise<HomeRailContentDto> {
    if (!this.stashAdapter) {
      return { items: [], message: 'Stash is not available for this row.' };
    }
    let stashConfig: { baseUrl: string; apiKey?: string | null };
    try {
      stashConfig = await this.getRequiredStashConfig();
    } catch {
      return {
        items: [],
        message: 'Set up Stash in Settings → Integrations to fill this row.',
      };
    }
    try {
      const scenes = await this.stashAdapter.getLocalScenesMatching(
        stashConfig,
        libraryPick(key),
        this.railLimit(rail),
      );
      return {
        items: scenes.map((scene) => this.toPlaybackRailItem(scene)),
        message: scenes.length === 0 ? emptyPickMessage(key) : null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load the Home row “${rail.title}”. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load scenes from Stash right now.',
      };
    }
  }

  /** What Whisparr is waiting for over the next weeks, soonest first. */
  private async getComingSoonRowContent(
    rail: HomeRail,
  ): Promise<HomeRailContentDto> {
    if (!this.scenes) {
      return { items: [], message: 'The calendar is not available.' };
    }
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + COMING_SOON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    try {
      const calendar = await this.scenes.getCalendar(
        from,
        to,
        'ALL',
        'WHISPARR',
      );
      if (calendar.whisparr === 'off') {
        return {
          items: [],
          message:
            'Set up Whisparr in Settings → Integrations to fill this row.',
        };
      }
      const items = calendar.items
        .filter((item) => (item.releaseDate ?? '') >= from)
        .sort((a, b) =>
          (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''),
        )
        .slice(0, this.railLimit(rail))
        .map((item): HomeRailItemDto => ({
          id: item.id,
          title: item.title,
          description: item.description,
          imageUrl: item.imageUrl,
          cardImageUrl: item.cardImageUrl,
          studioId: item.studioId,
          studio: item.studio,
          studioImageUrl: item.studioImageUrl,
          releaseDate: item.releaseDate,
          duration: item.duration,
          type: 'SCENE',
          source: item.source,
          status: item.status,
          requestable: false,
          viewUrl: null,
        }));
      return {
        items,
        message:
          items.length === 0
            ? 'Nothing Whisparr is waiting for comes out soon.'
            : null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load the Home row “${rail.title}”. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load upcoming scenes right now.',
      };
    }
  }

  /**
   * Requested scenes that are not in the library yet. This is the first page
   * of the Acquisition list (same filter and order), which "See all" opens.
   */
  private async getStillWaitingRailContent(
    rail: HomeRail,
  ): Promise<HomeRailContentDto> {
    try {
      const feed = await this.acquisitionService.getScenesFeed(
        1,
        this.railLimit(rail),
        'ANY',
      );

      return {
        items: feed.items.map((item) => ({
          id: item.id,
          title: item.title,
          description: item.description,
          imageUrl: item.imageUrl,
          cardImageUrl: item.cardImageUrl,
          studioId: item.studioId,
          studio: item.studio,
          studioImageUrl: item.studioImageUrl,
          releaseDate: item.releaseDate,
          duration: item.duration,
          type: 'SCENE' as const,
          source: item.source,
          status: item.status,
          requestable: false,
          viewUrl: null,
        })),
        message: null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load Still Waiting rail. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load waiting requests right now.',
      };
    }
  }

  /** Library scenes by Stash play count: never played, or most played. */
  private async getPlaybackRailContent(
    rail: HomeRail,
    mode: 'UNWATCHED' | 'MOST_PLAYED',
  ): Promise<HomeRailContentDto> {
    if (!this.stashAdapter) {
      return { items: [], message: 'Stash is not available for this rail.' };
    }

    let stashConfig: { baseUrl: string; apiKey?: string | null };
    try {
      stashConfig = await this.getRequiredStashConfig();
    } catch {
      this.logger.debug(
        `Home rail “${rail.title}” is empty: Stash is not set up.`,
      );
      return {
        items: [],
        message:
          'Configure and enable your Stash integration to populate this rail.',
      };
    }

    try {
      const scenes = await this.stashAdapter.getLocalScenesByPlayback(
        stashConfig,
        mode,
        this.railLimit(rail),
      );
      return {
        items: scenes.map((scene) => this.toPlaybackRailItem(scene)),
        message: null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load ${mode} Home rail. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load scenes from Stash right now.',
      };
    }
  }

  /** Library scenes started but not finished, most recently watched first. */
  private async getContinueWatchingRailContent(
    rail: HomeRail,
  ): Promise<HomeRailContentDto> {
    if (!this.stashAdapter) {
      return { items: [], message: 'Stash is not available for this rail.' };
    }

    let stashConfig: { baseUrl: string; apiKey?: string | null };
    try {
      stashConfig = await this.getRequiredStashConfig();
    } catch {
      this.logger.debug(
        `Home rail “${rail.title}” is empty: Stash is not set up.`,
      );
      return {
        items: [],
        message:
          'Configure and enable your Stash integration to populate this rail.',
      };
    }

    try {
      const limit = this.railLimit(rail);
      // Ask for a few extra in case some turn out to be finished.
      const scenes = await this.stashAdapter.getScenesInProgress(
        stashConfig,
        limit + CONTINUE_WATCHING_SPARE,
      );
      return {
        items: scenes
          .map((scene) => ({
            ...this.toPlaybackRailItem(scene),
            progress:
              scene.duration && scene.duration > 0
                ? Math.min(1, Math.max(0, scene.resumeTime / scene.duration))
                : null,
          }))
          // A spot in the closing credits counts as watched.
          .filter((item) => (item.progress ?? 0) < CONTINUE_WATCHING_FINISHED)
          .slice(0, limit),
        message: null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load Continue Watching rail. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load scenes from Stash right now.',
      };
    }
  }

  private toPlaybackRailItem(scene: StashLocalSceneFeedItem): HomeRailItemDto {
    // Route images through Stashboard's media proxy so they work without exposing
    // the Stash API key, and get cached and resized like the rest of the library.
    const screenshotPath = `scenes/${encodeURIComponent(scene.id)}/screenshot`;
    const screenshotVersion = stashImageVersion(scene.imageUrl);

    return {
      id: scene.id,
      title: scene.title,
      description: scene.description,
      imageUrl: screenshotVersion
        ? stashMediaUrl(screenshotPath, screenshotVersion)
        : null,
      cardImageUrl: screenshotVersion
        ? stashMediaUrl(screenshotPath, screenshotVersion, 480)
        : null,
      studioId: scene.studioId,
      studio: scene.studio,
      studioImageUrl:
        scene.studioId && scene.studioImageUrl
          ? stashMediaUrl(
              `studios/${encodeURIComponent(scene.studioId)}/logo`,
              stashImageVersion(scene.studioImageUrl),
            )
          : null,
      releaseDate: scene.releaseDate,
      duration: scene.duration,
      type: 'SCENE',
      source: 'STASH',
      status: { state: 'AVAILABLE' },
      requestable: false,
      viewUrl: scene.viewUrl,
    };
  }

  private async getStashRailContent(
    rail: HomeRail,
  ): Promise<HomeRailContentDto> {
    const config = this.normalizeSceneRailConfig(
      'STASH',
      rail.config,
      DEFAULT_HOME_RAILS.find((defaultRail) => defaultRail.key === rail.key)
        ?.config ?? null,
    );

    try {
      const items = await this.libraryService.getScenesPreview(
        config.limit,
        config.sort,
        config.direction,
        config.titleQuery ?? undefined,
        config.tagIds,
        config.tagIds.length > 0 ? (config.tagMode ?? 'OR') : undefined,
        config.studioIds,
        config.favoritePerformersOnly,
        config.favoriteStudiosOnly,
        config.favoriteTagsOnly,
      );

      return {
        items: items.map((item) => this.toLocalLibraryRailItem(item)),
        message: null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load indexed Home library rail ${rail.id}. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load indexed local-library scenes right now.',
      };
    }
  }

  private async getHybridRailContent(
    rail: HomeRail,
  ): Promise<HomeRailContentDto> {
    let stashdbConfig: { baseUrl: string; apiKey?: string | null };
    let stashConfig: { baseUrl: string; apiKey?: string | null };

    try {
      stashdbConfig = await this.getRequiredCatalogConfig();
    } catch {
      this.logger.debug(
        `Home rail “${rail.title}” is empty: the catalog is not set up.`,
      );
      return {
        items: [],
        message:
          'Configure the catalog provider for this Stashboard instance to populate this hybrid rail.',
      };
    }

    try {
      stashConfig = await this.getRequiredStashConfig();
    } catch {
      this.logger.debug(
        `Home rail “${rail.title}” is empty: Stash is not set up.`,
      );
      return {
        items: [],
        message:
          'Configure and enable your Stash integration to apply library matching.',
      };
    }

    const config = this.normalizeSceneRailConfig('HYBRID', rail.config, null);

    try {
      const matchedScenes = await this.hybridScenesService.getHybridSceneFeed(
        stashdbConfig,
        stashConfig,
        {
          page: 1,
          perPage: config.limit,
          sort: config.sort,
          direction: config.direction,
          stashdbFavorites: config.stashdbFavorites ?? undefined,
          tagIds: config.tagIds,
          tagMode: config.tagMode,
          studioIds: config.studioIds,
          libraryAvailability: config.libraryAvailability,
          stashFavoritePerformersOnly: config.stashFavoritePerformersOnly,
          stashFavoriteStudiosOnly: config.stashFavoriteStudiosOnly,
          stashFavoriteTagsOnly: config.stashFavoriteTagsOnly,
          // Catalog scenes you don't have follow Settings → Hidden content,
          // except studios and tags the rail itself asks for.
          ...(this.hiddenContent
            ? {
                hidden: exceptRequested(await this.hiddenContent.getRules(), {
                  studioIds: config.studioIds,
                  tagIds: config.tagIds,
                }),
              }
            : {}),
        },
      );
      const statuses =
        config.libraryAvailability === 'MISSING_FROM_LIBRARY'
          ? await this.sceneStatusService.resolveForScenes(
              matchedScenes.scenes.map((scene) => scene.id),
            )
          : new Map<string, { state: 'AVAILABLE' }>();

      return {
        items: matchedScenes.scenes.map((scene) =>
          this.toHybridRailItem(
            scene,
            config.libraryAvailability,
            statuses.get(scene.id) ?? { state: 'AVAILABLE' },
          ),
        ),
        message: null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to load hybrid Home rail ${rail.id}. ${(error as Error)?.message ?? 'Unknown error.'}`,
      );
      return {
        items: [],
        message: 'Unable to load hybrid library matches right now.',
      };
    }
  }

  private async listRails(): Promise<HomeRail[]> {
    return this.prisma.homeRail.findMany({
      where: {
        source: {
          not: HomeRailSource.HYBRID,
        },
      },
      // Ties broken by age then id, so tied rails keep a stable order.
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private validateSubmittedRails(
    payload: UpdateHomeRailsDto,
    existingRails: HomeRail[],
  ): void {
    const submittedIds = payload.rails.map((rail) => rail.id.trim());
    const uniqueIds = new Set(submittedIds);
    if (uniqueIds.size !== submittedIds.length) {
      throw new BadRequestException(
        'Home rails payload contains duplicate ids.',
      );
    }

    const existingIds = existingRails.map((rail) => rail.id);
    if (
      submittedIds.length !== existingIds.length ||
      existingIds.some((id) => !uniqueIds.has(id))
    ) {
      throw new BadRequestException(
        'Home rails payload must include each persisted rail exactly once.',
      );
    }
  }

  /** A row you made, or a ready-made one added from the gallery. */
  private async requireRemovableRail(id: string): Promise<HomeRail> {
    const rail = await this.prisma.homeRail.findUnique({ where: { id } });
    if (!rail) {
      throw new NotFoundException('Home row not found.');
    }
    if (rail.kind !== HomeRailKind.CUSTOM && !isStockRow(rail.key)) {
      throw new BadRequestException(
        'Built-in Home rows can be turned off, not removed.',
      );
    }
    return rail;
  }

  private async requireCustomRail(id: string): Promise<HomeRail> {
    const rail = await this.prisma.homeRail.findUnique({ where: { id } });
    if (!rail) {
      throw new NotFoundException('Home rail not found.');
    }
    if (rail.kind !== HomeRailKind.CUSTOM) {
      throw new BadRequestException(
        'Built-in Home rails cannot be deleted or edited here.',
      );
    }

    return rail;
  }

  private async reindexSortOrders(): Promise<void> {
    const rails = await this.listRails();
    const updates = rails
      .map((rail, index) => ({ rail, index }))
      .filter(({ rail, index }) => rail.sortOrder !== index)
      .map(({ rail, index }) =>
        this.prisma.homeRail.update({
          where: { id: rail.id },
          data: { sortOrder: index },
        }),
      );

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }
  }

  private toDto(rail: HomeRail): HomeRailDto {
    const defaults = rail.key
      ? DEFAULT_HOME_RAILS.find((defaultRail) => defaultRail.key === rail.key)
      : null;
    const source = this.ensureInSet(rail.source, HOME_RAIL_SOURCE_VALUES);
    const display = readRowDisplay(rail.display);

    return {
      id: rail.id,
      key: rail.key ?? null,
      kind: rail.kind,
      source,
      contentType: this.ensureInSet(
        rail.contentType,
        HOME_RAIL_CONTENT_TYPE_VALUES,
      ),
      title: display.title ?? rail.title,
      subtitle: rail.subtitle,
      enabled: rail.enabled,
      sortOrder: rail.sortOrder,
      editable: rail.kind === HomeRailKind.CUSTOM,
      deletable: rail.kind === HomeRailKind.CUSTOM || isStockRow(rail.key),
      config: this.normalizeSceneRailConfig(
        source,
        rail.config,
        defaults?.config ?? null,
      ),
      display,
    };
  }

  private toLocalLibraryRailItem(
    item: LibrarySceneFeedItemDto,
  ): HomeRailItemDto {
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      imageUrl: item.imageUrl,
      cardImageUrl: item.cardImageUrl,
      studioId: item.studioId,
      studio: item.studio,
      studioImageUrl: item.studioImageUrl,
      releaseDate: item.releaseDate,
      duration: item.duration,
      type: 'SCENE',
      source: 'STASH',
      status: { state: 'AVAILABLE' },
      requestable: false,
      viewUrl: item.viewUrl,
    };
  }

  private toHybridRailItem(
    scene: StashdbScene,
    libraryAvailability: LegacyHomeRailLibraryAvailability,
    status: SceneStatusDto,
  ): HomeRailItemDto {
    const effectiveStatus =
      libraryAvailability === 'IN_LIBRARY'
        ? { state: 'AVAILABLE' as const }
        : status;

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
      source: 'STASHDB',
      status: effectiveStatus,
      requestable:
        libraryAvailability === 'MISSING_FROM_LIBRARY' &&
        isSceneStatusRequestable(effectiveStatus),
      viewUrl: null,
    };
  }

  private normalizeSceneRailConfig(
    source: 'STASH',
    input: unknown,
    fallback?: Partial<HomeRailStoredSceneConfig> | null,
  ): HomeRailStashSceneConfigDto;
  private normalizeSceneRailConfig(
    source: 'STASHDB',
    input: unknown,
    fallback?: Partial<HomeRailStoredSceneConfig> | null,
  ): HomeRailStashdbSceneConfigDto;
  private normalizeSceneRailConfig(
    source: HomeRailDtoSource,
    input: unknown,
    fallback?: Partial<HomeRailStoredSceneConfig> | null,
  ): HomeRailSceneConfigDto;
  private normalizeSceneRailConfig(
    source: 'HYBRID',
    input: unknown,
    fallback?: Partial<HomeRailStoredSceneConfig> | null,
  ): LegacyHomeRailHybridSceneConfig;
  private normalizeSceneRailConfig(
    source: HomeRailSource,
    input: unknown,
    fallback: Partial<HomeRailStoredSceneConfig> | null = null,
  ): HomeRailStoredSceneConfig {
    const record = this.asRecord(input);
    if (source === HomeRailSource.STASH) {
      return this.normalizeStashSceneRailConfig(record, fallback);
    }
    if (source === HomeRailSource.HYBRID) {
      return this.normalizeHybridSceneRailConfig(record, fallback);
    }

    return this.normalizeStashdbSceneRailConfig(record, fallback);
  }

  private normalizeStashdbSceneRailConfig(
    record: Record<string, unknown>,
    fallback: Partial<HomeRailStoredSceneConfig> | null,
  ): HomeRailStashdbSceneConfigDto {
    const fallbackConfig = this.asStashdbSceneConfig(fallback);
    const sort = this.parseInSet(
      record.sort,
      HOME_RAIL_STASHDB_SCENE_SORT_VALUES,
      fallbackConfig?.sort ?? 'DATE',
    );
    const direction = this.parseInSet(
      record.direction,
      HOME_RAIL_DIRECTION_VALUES,
      fallbackConfig?.direction ?? 'DESC',
    );
    const favorites = this.parseOptionalInSet(
      record.favorites,
      HOME_RAIL_FAVORITES_VALUES,
      fallbackConfig?.favorites ?? null,
    );
    const tags = this.normalizeNamedIds(record.tagIds, record.tagNames);
    const studios = this.normalizeNamedIds(
      record.studioIds,
      record.studioNames,
    );
    const fallbackTagMode =
      tags.ids.length > 0 ? (fallbackConfig?.tagMode ?? 'OR') : null;
    const tagMode =
      tags.ids.length > 0
        ? this.parseOptionalInSet(
            record.tagMode,
            HOME_RAIL_TAG_MODE_VALUES,
            fallbackTagMode,
          )
        : null;
    const limit = this.parseLimit(
      record.limit,
      fallbackConfig?.limit ?? HOME_RAIL_SCENE_LIMIT_DEFAULT,
    );

    return {
      sort,
      direction,
      favorites,
      tagIds: tags.ids,
      tagNames: tags.names,
      tagMode,
      studioIds: studios.ids,
      studioNames: studios.names,
      limit,
    };
  }

  private normalizeStashSceneRailConfig(
    record: Record<string, unknown>,
    fallback: Partial<HomeRailStoredSceneConfig> | null,
  ): HomeRailStashSceneConfigDto {
    this.ensureNullishField(record.favorites, 'favorites', 'STASH');
    this.ensureNullishField(
      record.stashdbFavorites,
      'stashdbFavorites',
      'STASH',
    );
    this.ensureNullishField(
      record.libraryAvailability,
      'libraryAvailability',
      'STASH',
    );
    this.ensureFalseField(
      record.stashFavoritePerformersOnly,
      'stashFavoritePerformersOnly',
      'STASH',
    );
    this.ensureFalseField(
      record.stashFavoriteStudiosOnly,
      'stashFavoriteStudiosOnly',
      'STASH',
    );
    this.ensureFalseField(
      record.stashFavoriteTagsOnly,
      'stashFavoriteTagsOnly',
      'STASH',
    );

    const fallbackConfig = this.asStashSceneConfig(fallback);
    const sort = this.parseOptionalStrictInSet(
      record.sort,
      HOME_RAIL_STASH_SCENE_SORT_VALUES,
      fallbackConfig?.sort ?? 'CREATED_AT',
      'sort',
    );
    const direction = this.parseOptionalStrictInSet(
      record.direction,
      HOME_RAIL_DIRECTION_VALUES,
      fallbackConfig?.direction ?? 'DESC',
      'direction',
    );
    const titleQuery = this.normalizeOptionalString(
      record.titleQuery,
      fallbackConfig?.titleQuery ?? null,
    );
    const tags = this.normalizeNamedIds(record.tagIds, record.tagNames);
    const studios = this.normalizeNamedIds(
      record.studioIds,
      record.studioNames,
    );
    const fallbackTagMode =
      tags.ids.length > 0 ? (fallbackConfig?.tagMode ?? 'OR') : null;
    const tagMode =
      tags.ids.length > 0
        ? this.parseOptionalStrictNullableInSet(
            record.tagMode,
            HOME_RAIL_TAG_MODE_VALUES,
            fallbackTagMode,
            'tagMode',
          )
        : null;
    const favoritePerformersOnly = this.parseBoolean(
      record.favoritePerformersOnly,
      fallbackConfig?.favoritePerformersOnly ?? false,
    );
    const favoriteStudiosOnly = this.parseBoolean(
      record.favoriteStudiosOnly,
      fallbackConfig?.favoriteStudiosOnly ?? false,
    );
    const favoriteTagsOnly = this.parseBoolean(
      record.favoriteTagsOnly,
      fallbackConfig?.favoriteTagsOnly ?? false,
    );
    const limit = this.parseLimit(
      record.limit,
      fallbackConfig?.limit ?? HOME_RAIL_SCENE_LIMIT_DEFAULT,
    );

    return {
      sort,
      direction,
      titleQuery,
      tagIds: tags.ids,
      tagNames: tags.names,
      tagMode,
      studioIds: studios.ids,
      studioNames: studios.names,
      favoritePerformersOnly,
      favoriteStudiosOnly,
      favoriteTagsOnly,
      limit,
    };
  }

  private normalizeHybridSceneRailConfig(
    record: Record<string, unknown>,
    fallback: Partial<HomeRailStoredSceneConfig> | null,
  ): LegacyHomeRailHybridSceneConfig {
    this.ensureNullishField(record.favorites, 'favorites', 'HYBRID');
    this.ensureNullishField(record.titleQuery, 'titleQuery', 'HYBRID');
    this.ensureFalseField(
      record.favoritePerformersOnly,
      'favoritePerformersOnly',
      'HYBRID',
    );
    this.ensureFalseField(
      record.favoriteStudiosOnly,
      'favoriteStudiosOnly',
      'HYBRID',
    );
    this.ensureFalseField(
      record.favoriteTagsOnly,
      'favoriteTagsOnly',
      'HYBRID',
    );

    const fallbackConfig = this.asHybridSceneConfig(fallback);
    const sort = this.parseOptionalStrictInSet(
      record.sort,
      HOME_RAIL_STASHDB_SCENE_SORT_VALUES,
      fallbackConfig?.sort ?? 'DATE',
      'sort',
    );
    const direction = this.parseOptionalStrictInSet(
      record.direction,
      HOME_RAIL_DIRECTION_VALUES,
      fallbackConfig?.direction ?? 'DESC',
      'direction',
    );
    const stashdbFavorites = this.parseOptionalStrictNullableInSet(
      record.stashdbFavorites,
      HOME_RAIL_FAVORITES_VALUES,
      fallbackConfig?.stashdbFavorites ?? null,
      'stashdbFavorites',
    );
    const tags = this.normalizeNamedIds(record.tagIds, record.tagNames);
    const studios = this.normalizeNamedIds(
      record.studioIds,
      record.studioNames,
    );
    const fallbackTagMode =
      tags.ids.length > 0 ? (fallbackConfig?.tagMode ?? 'OR') : null;
    const tagMode =
      tags.ids.length > 0
        ? this.parseOptionalStrictNullableInSet(
            record.tagMode,
            HOME_RAIL_TAG_MODE_VALUES,
            fallbackTagMode,
            'tagMode',
          )
        : null;
    const libraryAvailability = this.parseOptionalStrictInSet(
      record.libraryAvailability,
      LEGACY_HOME_RAIL_LIBRARY_AVAILABILITY_VALUES,
      fallbackConfig?.libraryAvailability ?? 'MISSING_FROM_LIBRARY',
      'libraryAvailability',
    );
    const stashFavoritePerformersOnly = this.parseBoolean(
      record.stashFavoritePerformersOnly,
      fallbackConfig?.stashFavoritePerformersOnly ?? false,
    );
    const stashFavoriteStudiosOnly = this.parseBoolean(
      record.stashFavoriteStudiosOnly,
      fallbackConfig?.stashFavoriteStudiosOnly ?? false,
    );
    const stashFavoriteTagsOnly = this.parseBoolean(
      record.stashFavoriteTagsOnly,
      fallbackConfig?.stashFavoriteTagsOnly ?? false,
    );
    const limit = this.parseLimit(
      record.limit,
      fallbackConfig?.limit ?? HOME_RAIL_SCENE_LIMIT_DEFAULT,
    );
    const usesStashLocalFavoriteOverlays = libraryAvailability === 'IN_LIBRARY';

    return {
      sort,
      direction,
      stashdbFavorites,
      tagIds: tags.ids,
      tagNames: tags.names,
      tagMode,
      studioIds: studios.ids,
      studioNames: studios.names,
      stashFavoritePerformersOnly: usesStashLocalFavoriteOverlays
        ? stashFavoritePerformersOnly
        : false,
      stashFavoriteStudiosOnly: usesStashLocalFavoriteOverlays
        ? stashFavoriteStudiosOnly
        : false,
      stashFavoriteTagsOnly: usesStashLocalFavoriteOverlays
        ? stashFavoriteTagsOnly
        : false,
      libraryAvailability,
      limit,
    };
  }

  private normalizeNamedIds(
    idsValue: unknown,
    namesValue: unknown,
  ): { ids: string[]; names: string[] } {
    const ids: unknown[] = Array.isArray(idsValue) ? idsValue : [];
    const names: unknown[] = Array.isArray(namesValue) ? namesValue : [];
    const seen = new Set<string>();
    const normalizedIds: string[] = [];
    const normalizedNames: string[] = [];

    ids.forEach((rawId, index) => {
      const id = String(rawId).trim();
      if (!id || seen.has(id)) {
        return;
      }

      seen.add(id);
      normalizedIds.push(id);
      const rawName = names[index];
      if (typeof rawName === 'string' && rawName.trim().length > 0) {
        normalizedNames.push(rawName.trim());
      } else {
        normalizedNames.push(id);
      }
    });

    return {
      ids: normalizedIds,
      names: normalizedNames,
    };
  }

  private ensureNullishField(
    value: unknown,
    fieldName: string,
    source: 'STASH' | 'HYBRID',
  ): void {
    if (value === null || value === undefined || value === '') {
      return;
    }

    throw new BadRequestException(
      `Field ${fieldName} is not supported for ${source} Home rails.`,
    );
  }

  private ensureFalseField(
    value: unknown,
    fieldName: string,
    source: 'STASH' | 'HYBRID',
  ): void {
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      value === false
    ) {
      return;
    }

    throw new BadRequestException(
      `Field ${fieldName} is not supported for ${source} Home rails.`,
    );
  }

  private parseBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    return fallback;
  }

  private parseLimit(value: unknown, fallback: number): number {
    const next = Number(value);
    if (!Number.isInteger(next)) {
      return fallback;
    }

    return Math.min(
      Math.max(next, HOME_RAIL_SCENE_LIMIT_MIN),
      HOME_RAIL_SCENE_LIMIT_MAX,
    );
  }

  private asStashdbSceneConfig(
    value: Partial<HomeRailStoredSceneConfig> | null,
  ): Partial<HomeRailStashdbSceneConfigDto> | null {
    if (
      !value ||
      'favorites' in value ||
      'tagIds' in value ||
      'studioIds' in value
    ) {
      return value;
    }

    return null;
  }

  private asStashSceneConfig(
    value: Partial<HomeRailStoredSceneConfig> | null,
  ): Partial<HomeRailStashSceneConfigDto> | null {
    if (!value) {
      return null;
    }

    return {
      sort: value.sort as HomeRailStashSceneConfigDto['sort'],
      direction: value.direction,
      titleQuery:
        'titleQuery' in value && typeof value.titleQuery === 'string'
          ? value.titleQuery
          : null,
      tagIds:
        'tagIds' in value && Array.isArray(value.tagIds) ? value.tagIds : [],
      tagNames:
        'tagNames' in value && Array.isArray(value.tagNames)
          ? value.tagNames
          : [],
      tagMode:
        'tagMode' in value && typeof value.tagMode === 'string'
          ? value.tagMode
          : null,
      studioIds:
        'studioIds' in value && Array.isArray(value.studioIds)
          ? value.studioIds
          : [],
      studioNames:
        'studioNames' in value && Array.isArray(value.studioNames)
          ? value.studioNames
          : [],
      favoritePerformersOnly:
        'favoritePerformersOnly' in value &&
        value.favoritePerformersOnly === true,
      favoriteStudiosOnly:
        'favoriteStudiosOnly' in value && value.favoriteStudiosOnly === true,
      favoriteTagsOnly:
        'favoriteTagsOnly' in value && value.favoriteTagsOnly === true,
      limit: value.limit,
    };
  }

  private asHybridSceneConfig(
    value: Partial<HomeRailStoredSceneConfig> | null,
  ): Partial<LegacyHomeRailHybridSceneConfig> | null {
    if (!value) {
      return null;
    }

    if ('stashdbFavorites' in value || 'libraryAvailability' in value) {
      return value;
    }

    return null;
  }

  private parseOptionalInSet<const T extends readonly string[]>(
    value: unknown,
    validValues: T,
    fallback: T[number] | null,
  ): T[number] | null {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }

    return this.parseInSet(value, validValues, fallback ?? validValues[0]);
  }

  private parseOptionalStrictInSet<const T extends readonly string[]>(
    value: unknown,
    validValues: T,
    fallback: T[number],
    fieldName: string,
  ): T[number] {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }

    if (typeof value === 'string' && validValues.includes(value)) {
      return value;
    }

    throw new BadRequestException(
      `Unsupported ${fieldName} value for this Home rail source.`,
    );
  }

  private parseOptionalStrictNullableInSet<const T extends readonly string[]>(
    value: unknown,
    validValues: T,
    fallback: T[number] | null,
    fieldName: string,
  ): T[number] | null {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }

    if (typeof value === 'string' && validValues.includes(value)) {
      return value;
    }

    throw new BadRequestException(
      `Unsupported ${fieldName} value for this Home rail source.`,
    );
  }

  private parseInSet<const T extends readonly string[]>(
    value: unknown,
    validValues: T,
    fallback: T[number],
  ): T[number] {
    return typeof value === 'string' && validValues.includes(value)
      ? value
      : fallback;
  }

  private ensureInSet<const T extends readonly string[]>(
    value: string,
    validValues: T,
  ): T[number] {
    if (!validValues.includes(value)) {
      throw new BadRequestException(`Unsupported Home rail value: ${value}`);
    }

    return value;
  }

  private ensureSupportedCustomRailSource(source: unknown): void {
    if (source === HomeRailSource.HYBRID) {
      throw new BadRequestException(
        'Custom HYBRID Home rails are no longer supported.',
      );
    }

    if (source !== HomeRailSource.STASHDB && source !== HomeRailSource.STASH) {
      throw new BadRequestException('Unsupported Home rail source.');
    }
  }

  private normalizeSubtitle(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeOptionalString(
    value: unknown,
    fallback: string | null,
  ): string | null {
    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private async getRequiredStashConfig(): Promise<{
    baseUrl: string;
    apiKey?: string | null;
  }> {
    const integration = await this.prisma.integrationConfig.findUnique({
      where: { type: 'STASH' },
    });

    if (!integration) {
      throw new ConflictException('STASH integration is not configured.');
    }

    if (!integration.enabled) {
      throw new ConflictException('STASH integration is disabled.');
    }

    if (integration.status !== 'CONFIGURED') {
      throw new ConflictException('STASH integration is not configured.');
    }

    const baseUrl = integration.baseUrl?.trim();
    if (!baseUrl) {
      throw new BadRequestException('STASH integration is missing a base URL.');
    }

    return {
      baseUrl,
      apiKey: integration.apiKey,
    };
  }

  private async getRequiredCatalogConfig(): Promise<{
    baseUrl: string;
    apiKey?: string | null;
  }> {
    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProvider();

    return {
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
    };
  }
}

function isStockRow(key: HomeRailKey | null): boolean {
  return STOCK_HOME_ROWS.some((row) => row.key === key);
}

/** The saved look of a row, with defaults for anything missing or unknown. */
export function readRowDisplay(value: unknown): HomeRowDisplayDto {
  const saved =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const bool = (key: keyof HomeRowDisplayDto): boolean =>
    typeof saved[key] === 'boolean'
      ? saved[key]
      : (DEFAULT_HOME_ROW_DISPLAY[key] as boolean);
  const oneOf = <T extends string>(
    key: keyof HomeRowDisplayDto,
    values: readonly T[],
  ): T =>
    values.includes(saved[key] as T)
      ? (saved[key] as T)
      : (DEFAULT_HOME_ROW_DISPLAY[key] as T);
  const title =
    typeof saved.title === 'string' && saved.title.trim()
      ? saved.title.trim()
      : null;
  const limit =
    typeof saved.limit === 'number' &&
    Number.isInteger(saved.limit) &&
    saved.limit >= HOME_RAIL_SCENE_LIMIT_MIN &&
    saved.limit <= HOME_RAIL_SCENE_LIMIT_MAX
      ? saved.limit
      : null;
  return {
    title,
    size: oneOf('size', HOME_ROW_SIZE_VALUES),
    style: oneOf('style', HOME_ROW_STYLE_VALUES),
    showStudio: bool('showStudio'),
    showDate: bool('showDate'),
    showDuration: bool('showDuration'),
    showActions: bool('showActions'),
    devices: oneOf('devices', HOME_ROW_DEVICE_VALUES),
    seeAll: bool('seeAll'),
    limit,
  };
}

/** What a stock row picks from the library. */
function libraryPick(key: HomeRailKey): LibraryScenePick {
  switch (key) {
    case HomeRailKey.REDISCOVER:
      return {
        sort: 'random',
        filter: {
          play_count: { value: 0, modifier: 'GREATER_THAN' },
          last_played_at: {
            // Stash reads times without milliseconds.
            value: new Date(Date.now() - REDISCOVER_AFTER_DAYS * 86_400_000)
              .toISOString()
              .replace(/\.\d{3}Z$/, 'Z'),
            modifier: 'LESS_THAN',
          },
        },
      };
    case HomeRailKey.TOP_RATED:
      return {
        sort: 'rating',
        filter: { rating100: { value: 0, modifier: 'GREATER_THAN' } },
      };
    case HomeRailKey.QUICK_PICKS:
      return {
        sort: 'random',
        filter: {
          duration: { value: QUICK_PICK_SECONDS, modifier: 'LESS_THAN' },
        },
      };
    default:
      // 4K and up: taller than the 1920-line VR size.
      return {
        sort: 'created_at',
        filter: { resolution: { value: 'VR_HD', modifier: 'GREATER_THAN' } },
      };
  }
}

function emptyPickMessage(key: HomeRailKey): string {
  switch (key) {
    case HomeRailKey.REDISCOVER:
      return `Nothing you watched more than ${REDISCOVER_AFTER_DAYS} days ago yet.`;
    case HomeRailKey.TOP_RATED:
      return 'Rate scenes in Stash and the best show up here.';
    case HomeRailKey.QUICK_PICKS:
      return 'No scenes under 20 minutes in your library.';
    default:
      return 'No 4K scenes in your library yet.';
  }
}

function describeGalleryRow(id: HomeRowGalleryId): {
  title: string;
  description: string;
  from: HomeRowGalleryItemDto['from'];
  repeatable: boolean;
} {
  const builtIn = DEFAULT_HOME_RAILS.find((rail) => rail.key === id);
  if (builtIn) {
    return {
      title: builtIn.title,
      description: builtIn.subtitle,
      from:
        builtIn.key === HomeRailKey.STILL_WAITING
          ? 'requests'
          : builtIn.source === HomeRailSource.STASHDB
            ? 'catalog'
            : 'library',
      repeatable: false,
    };
  }
  const stock = STOCK_HOME_ROWS.find((row) => row.key === id);
  if (stock) {
    return {
      title: stock.title,
      description: stock.subtitle,
      from: stock.from,
      repeatable: false,
    };
  }
  const preset = presetRow(id);
  return {
    title: preset?.title ?? id,
    description: preset?.subtitle ?? '',
    from: preset?.source === 'STASHDB' ? 'catalog' : 'library',
    repeatable: true,
  };
}

/** Starting points for rows of your own, edited like any other. */
function presetRow(
  id: HomeRowGalleryId,
): Omit<CreateHomeRailDto, 'enabled'> | null {
  switch (id) {
    case 'NEW_FROM_FAVORITE_PERFORMERS':
      return {
        source: 'STASH',
        title: 'New From Your Favorites',
        subtitle: 'The newest library scenes with performers you’ve starred.',
        config: { ...LIBRARY_ROW_CONFIG, favoritePerformersOnly: true },
      };
    case 'NEW_RELEASES':
      return {
        source: 'STASHDB',
        title: 'New Releases',
        subtitle: 'The latest scenes in the catalog.',
        config: {
          sort: 'DATE',
          direction: 'DESC',
          tagIds: [],
          tagNames: [],
          studioIds: [],
          studioNames: [],
          limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
        },
      };
    case 'TRENDING':
      return {
        source: 'STASHDB',
        title: 'Trending',
        subtitle: 'What’s popular in the catalog right now.',
        config: {
          sort: 'TRENDING',
          direction: 'DESC',
          tagIds: [],
          tagNames: [],
          studioIds: [],
          studioNames: [],
          limit: HOME_RAIL_SCENE_LIMIT_DEFAULT,
        },
      };
    default:
      return null;
  }
}
