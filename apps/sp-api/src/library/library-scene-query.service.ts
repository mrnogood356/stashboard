import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { stashMediaUrl } from '../media/media-url.util';
import { stashImageVersion } from '../providers/stash/stash-image-version.util';
import {
  LibrarySceneFeedItemDto,
  LibraryScenesFeedDto,
} from './dto/library-scenes-feed.dto';
import {
  LibraryResolution,
  LibrarySceneSort,
  LibrarySortDirection,
  LibraryTagMatchMode,
} from './dto/library-scenes-query.dto';

const librarySceneListSelect =
  Prisma.validator<Prisma.LibrarySceneIndexSelect>()({
    stashSceneId: true,
    linkedStashId: true,
    title: true,
    description: true,
    imageUrl: true,
    studioId: true,
    studioName: true,
    studioImageUrl: true,
    performerNames: true,
    releaseDate: true,
    productionDate: true,
    duration: true,
    width: true,
    height: true,
    viewUrl: true,
    localCreatedAt: true,
  });

type LibrarySceneListRow = Prisma.LibrarySceneIndexGetPayload<{
  select: typeof librarySceneListSelect;
}>;

interface LibrarySceneQueryFilters {
  sort?: LibrarySceneSort;
  direction?: LibrarySortDirection;
  query?: string;
  tagIds?: string[];
  tagMode?: LibraryTagMatchMode;
  studioIds?: string[];
  favoritePerformersOnly?: boolean;
  favoriteStudiosOnly?: boolean;
  favoriteTagsOnly?: boolean;
  resolution?: LibraryResolution;
}

type NormalizedFilters = Required<
  Omit<LibrarySceneQueryFilters, 'resolution'>
> & {
  query: string;
  resolution: LibraryResolution | null;
};

/**
 * Scenes of one quality, grouped as the Stats page does (resolutionOf): by
 * the main file's short side, so a portrait 1080×1920 video is 1080p.
 */
export function resolutionWhere(
  resolution: LibraryResolution,
): Prisma.LibrarySceneIndexWhereInput {
  // Both sides at least this, and (for all but the top) one side below the next.
  const band = (min: number, below: number | null) => ({
    width: { gte: min },
    height: { gte: min },
    ...(below === null
      ? {}
      : { OR: [{ width: { lt: below } }, { height: { lt: below } }] }),
  });
  switch (resolution) {
    case '4k':
      return band(2000, null);
    case '1080p':
      return band(1000, 2000);
    case '720p':
      return band(700, 1000);
    case 'sd':
      return band(1, 700);
    case 'unknown':
      return {
        OR: [
          { width: null },
          { height: null },
          { width: { lte: 0 } },
          { height: { lte: 0 } },
        ],
      };
  }
}

@Injectable()
export class LibrarySceneQueryService {
  static readonly DEFAULT_PAGE = 1;
  static readonly DEFAULT_PER_PAGE = 24;
  static readonly DEFAULT_SORT: LibrarySceneSort = 'RELEASE_DATE';
  static readonly DEFAULT_DIRECTION: LibrarySortDirection = 'DESC';
  static readonly DEFAULT_TAG_MODE: LibraryTagMatchMode = 'OR';

  constructor(private readonly prisma: PrismaService) {}

  async getScenesFeed(
    page = LibrarySceneQueryService.DEFAULT_PAGE,
    perPage = LibrarySceneQueryService.DEFAULT_PER_PAGE,
    filters: LibrarySceneQueryFilters = {},
  ): Promise<LibraryScenesFeedDto> {
    const normalizedFilters = this.normalizeFilters(filters);
    const where = this.buildWhere(normalizedFilters);
    const orderBy = this.buildOrderBy(
      normalizedFilters.sort,
      normalizedFilters.direction,
    );
    const [rows, aggregate] = await Promise.all([
      this.prisma.librarySceneIndex.findMany({
        where,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
        select: librarySceneListSelect,
      }),
      this.prisma.librarySceneIndex.aggregate({
        where,
        _count: {
          _all: true,
        },
        _max: {
          lastSyncedAt: true,
        },
      }),
    ]);
    const total = aggregate._count._all;

    return {
      total,
      page,
      perPage,
      hasMore: page * perPage < total,
      latestSyncAt: aggregate._max.lastSyncedAt,
      items: rows.map((row) => this.toSceneFeedItem(row)),
    };
  }

  async getScenesPreview(
    limit: number,
    filters: LibrarySceneQueryFilters = {},
  ): Promise<LibrarySceneFeedItemDto[]> {
    const normalizedFilters = this.normalizeFilters(filters);
    const rows = await this.prisma.librarySceneIndex.findMany({
      where: this.buildWhere(normalizedFilters),
      orderBy: this.buildOrderBy(
        normalizedFilters.sort,
        normalizedFilters.direction,
      ),
      take: limit,
      select: librarySceneListSelect,
    });

    return rows.map((row) => this.toSceneFeedItem(row));
  }

  private normalizeFilters(
    filters: LibrarySceneQueryFilters,
  ): NormalizedFilters {
    return {
      sort: filters.sort ?? LibrarySceneQueryService.DEFAULT_SORT,
      direction:
        filters.direction ?? LibrarySceneQueryService.DEFAULT_DIRECTION,
      query: filters.query?.trim() ?? '',
      tagIds: this.normalizeIds(filters.tagIds ?? []),
      tagMode: filters.tagMode ?? LibrarySceneQueryService.DEFAULT_TAG_MODE,
      studioIds: this.normalizeIds(filters.studioIds ?? []),
      favoritePerformersOnly: filters.favoritePerformersOnly ?? false,
      favoriteStudiosOnly: filters.favoriteStudiosOnly ?? false,
      favoriteTagsOnly: filters.favoriteTagsOnly ?? false,
      resolution: filters.resolution ?? null,
    };
  }

  private buildWhere(
    filters: NormalizedFilters,
  ): Prisma.LibrarySceneIndexWhereInput {
    const andClauses: Prisma.LibrarySceneIndexWhereInput[] = [];

    if (filters.query) {
      andClauses.push({
        OR: [
          {
            title: {
              contains: filters.query,
              mode: 'insensitive',
            },
          },
          {
            description: {
              contains: filters.query,
              mode: 'insensitive',
            },
          },
          {
            studioName: {
              contains: filters.query,
              mode: 'insensitive',
            },
          },
          // Exact performer name, as used by the performer links on scene pages.
          {
            performerNames: {
              has: filters.query,
            },
          },
        ],
      });
    }

    if (filters.tagIds.length > 0) {
      andClauses.push({
        tagIds:
          filters.tagMode === 'AND'
            ? {
                hasEvery: filters.tagIds,
              }
            : {
                hasSome: filters.tagIds,
              },
      });
    }

    if (filters.studioIds.length > 0) {
      andClauses.push({
        studioId: {
          in: filters.studioIds,
        },
      });
    }

    if (filters.favoritePerformersOnly) {
      andClauses.push({ hasFavoritePerformer: true });
    }

    if (filters.favoriteStudiosOnly) {
      andClauses.push({ favoriteStudio: true });
    }

    if (filters.favoriteTagsOnly) {
      andClauses.push({ hasFavoriteTag: true });
    }

    if (filters.resolution) {
      andClauses.push(resolutionWhere(filters.resolution));
    }

    return andClauses.length > 0 ? { AND: andClauses } : {};
  }

  private buildOrderBy(
    sort: LibrarySceneSort,
    direction: LibrarySortDirection,
  ): Prisma.LibrarySceneIndexOrderByWithRelationInput[] {
    const order: Prisma.SortOrder = direction === 'ASC' ? 'asc' : 'desc';
    // Dates are optional; scenes without one go last either way (Postgres
    // would otherwise put them first when sorting newest first).

    switch (sort) {
      case 'TITLE':
        return [{ title: order }, { stashSceneId: 'asc' }];
      case 'PRODUCTION_DATE':
        // Scenes without one (or from a Stash before 0.32) go last.
        return [
          { productionDate: { sort: order, nulls: 'last' } },
          { releaseDate: { sort: order, nulls: 'last' } },
          { title: 'asc' },
          { stashSceneId: 'asc' },
        ];
      case 'RELEASE_DATE':
        return [
          { releaseDate: { sort: order, nulls: 'last' } },
          { title: 'asc' },
          { stashSceneId: 'asc' },
        ];
      case 'CREATED_AT':
        return [
          { localCreatedAt: { sort: order, nulls: 'last' } },
          { title: 'asc' },
          { stashSceneId: 'asc' },
        ];
      case 'UPDATED_AT':
      default:
        return [
          { localUpdatedAt: { sort: order, nulls: 'last' } },
          { title: 'asc' },
          { stashSceneId: 'asc' },
        ];
    }
  }

  private toSceneFeedItem(row: LibrarySceneListRow): LibrarySceneFeedItemDto {
    const screenshotPath = `scenes/${encodeURIComponent(row.stashSceneId)}/screenshot`;
    const screenshotVersion = stashImageVersion(row.imageUrl);
    const studioLogoUrl =
      row.studioId && row.studioImageUrl
        ? stashMediaUrl(
            `studios/${encodeURIComponent(row.studioId)}/logo`,
            stashImageVersion(row.studioImageUrl),
          )
        : null;

    return {
      id: row.stashSceneId,
      activeCatalogSceneId: row.linkedStashId,
      title: row.title,
      description: row.description,
      imageUrl: screenshotVersion
        ? stashMediaUrl(screenshotPath, screenshotVersion)
        : null,
      // Cards are small; ask for a 480px-wide thumbnail instead of the full screenshot.
      cardImageUrl: screenshotVersion
        ? stashMediaUrl(screenshotPath, screenshotVersion, 480)
        : null,
      studioId: row.studioId,
      studio: row.studioName,
      studioImageUrl: studioLogoUrl,
      performerNames: row.performerNames,
      releaseDate: row.releaseDate,
      productionDate: row.productionDate,
      duration: row.duration,
      width: row.width,
      height: row.height,
      localCreatedAt: row.localCreatedAt,
      type: 'SCENE',
      source: 'STASH',
      viewUrl: row.viewUrl,
    };
  }

  private normalizeIds(values: string[]): string[] {
    return Array.from(
      new Set(
        values.map((value) => value.trim()).filter((value) => value.length > 0),
      ),
    );
  }
}
