import type { LibraryPerformersDto } from './dto/library-performers.dto';
import { stashMediaUrl } from '../media/media-url.util';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LibraryScenesFeedDto,
  LibrarySceneFeedItemDto,
} from './dto/library-scenes-feed.dto';
import {
  LibrarySceneSort,
  LibrarySortDirection,
  LibraryTagMatchMode,
} from './dto/library-scenes-query.dto';
import { LibraryStudioOptionDto } from './dto/library-studio-option.dto';
import { LibraryTagOptionDto } from './dto/library-tag-option.dto';
import { LibrarySceneQueryService } from './library-scene-query.service';

@Injectable()
export class LibraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly librarySceneQueryService: LibrarySceneQueryService,
  ) {}

  async getScenesFeed(
    page = LibrarySceneQueryService.DEFAULT_PAGE,
    perPage = LibrarySceneQueryService.DEFAULT_PER_PAGE,
    sort: LibrarySceneSort = LibrarySceneQueryService.DEFAULT_SORT,
    direction: LibrarySortDirection = LibrarySceneQueryService.DEFAULT_DIRECTION,
    query?: string,
    tagIds: string[] = [],
    tagMode: LibraryTagMatchMode = LibrarySceneQueryService.DEFAULT_TAG_MODE,
    studioIds: string[] = [],
    favoritePerformersOnly = false,
    favoriteStudiosOnly = false,
    favoriteTagsOnly = false,
  ): Promise<LibraryScenesFeedDto> {
    return this.librarySceneQueryService.getScenesFeed(page, perPage, {
      sort,
      direction,
      query,
      tagIds,
      tagMode,
      studioIds,
      favoritePerformersOnly,
      favoriteStudiosOnly,
      favoriteTagsOnly,
    });
  }

  async getScenesPreview(
    limit: number,
    sort: LibrarySceneSort = LibrarySceneQueryService.DEFAULT_SORT,
    direction: LibrarySortDirection = LibrarySceneQueryService.DEFAULT_DIRECTION,
    query?: string,
    tagIds: string[] = [],
    tagMode: LibraryTagMatchMode = LibrarySceneQueryService.DEFAULT_TAG_MODE,
    studioIds: string[] = [],
    favoritePerformersOnly = false,
    favoriteStudiosOnly = false,
    favoriteTagsOnly = false,
  ): Promise<LibrarySceneFeedItemDto[]> {
    return this.librarySceneQueryService.getScenesPreview(limit, {
      sort,
      direction,
      query,
      tagIds,
      tagMode,
      studioIds,
      favoritePerformersOnly,
      favoriteStudiosOnly,
      favoriteTagsOnly,
    });
  }

  /**
   * Your categories, the most used first, with how many scenes have each:
   * all of them, or one performer's or studio's. Typing narrows by name; with
   * nothing typed it's the most common ones, so the list is never empty.
   */
  async searchTags(
    query?: string,
    scope: LibraryOptionScope = {},
  ): Promise<LibraryTagOptionDto[]> {
    const normalizedQuery = query?.trim() ?? '';
    // The first test narrows by the indexed text before every tag is unnested.
    const nameFilter = normalizedQuery
      ? Prisma.sql`AND library_scene_tag_names_search_text("tagNames") ILIKE ${`%${normalizedQuery}%`}
          AND tag.tag_name ILIKE ${`%${normalizedQuery}%`}`
      : Prisma.empty;
    return this.prisma.$queryRaw<LibraryTagOptionDto[]>(Prisma.sql`
      SELECT tag.tag_id AS id, MIN(tag.tag_name) AS name, COUNT(*)::int AS count
      FROM "LibrarySceneIndex"
      CROSS JOIN LATERAL unnest("tagIds", "tagNames") AS tag(tag_id, tag_name)
      WHERE tag.tag_id IS NOT NULL ${nameFilter} ${this.scopeFilter(scope)}
      GROUP BY tag.tag_id
      ORDER BY count DESC, name ASC, id ASC
      LIMIT ${OPTION_LIMIT}
    `);
  }

  /** Your studios, the most scenes first; or the studios of one performer's scenes. */
  async searchStudios(
    query?: string,
    scope: LibraryOptionScope = {},
  ): Promise<LibraryStudioOptionDto[]> {
    const normalizedQuery = query?.trim() ?? '';
    const nameFilter = normalizedQuery
      ? Prisma.sql`AND "studioName" ILIKE ${`%${normalizedQuery}%`}`
      : Prisma.empty;
    return this.prisma.$queryRaw<LibraryStudioOptionDto[]>(Prisma.sql`
      SELECT "studioId" AS id, MIN("studioName") AS name, COUNT(*)::int AS count
      FROM "LibrarySceneIndex"
      WHERE "studioId" IS NOT NULL
        AND "studioName" IS NOT NULL ${nameFilter} ${this.scopeFilter(scope)}
      GROUP BY "studioId"
      ORDER BY count DESC, name ASC
      LIMIT ${OPTION_LIMIT}
    `);
  }

  /**
   * Everyone who's in a scene of yours (Stash's own performers, as the
   * library index has them), most scenes first, a page at a time.
   */
  async listPerformers(
    query?: string,
    page = 1,
    perPage = 48,
  ): Promise<LibraryPerformersDto> {
    const name = query?.trim() ?? '';
    const nameFilter = name
      ? Prisma.sql`WHERE p.name ILIKE ${`%${name}%`}`
      : Prisma.empty;
    const people = Prisma.sql`
      SELECT p.id, MIN(p.name) AS name, COUNT(*)::int AS count
      FROM "LibrarySceneIndex" s,
        unnest(s."performerIds", s."performerNames") AS p(id, name)
      ${nameFilter}
      GROUP BY p.id`;
    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name: string; count: number }>>(
        Prisma.sql`${people}
          ORDER BY count DESC, name ASC
          LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
      ),
      this.prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`SELECT COUNT(*)::int AS total FROM (${people}) AS people`,
      ),
    ]);
    const total = totals[0]?.total ?? 0;
    return {
      total,
      page,
      perPage,
      hasMore: page * perPage < total,
      items: rows.map((row) => ({
        ...row,
        imageUrl: stashMediaUrl(
          `performers/${encodeURIComponent(row.id)}/image`,
          null,
          480,
        ),
      })),
    };
  }

  private scopeFilter(scope: LibraryOptionScope): Prisma.Sql {
    if (scope.performerId) {
      return Prisma.sql`AND "performerIds" @> ARRAY[${scope.performerId}]::text[]`;
    }
    if (scope.studioId) {
      return Prisma.sql`AND "studioId" = ${scope.studioId}`;
    }
    return Prisma.empty;
  }
}

/** Options from one performer's or one studio's scenes only. */
export interface LibraryOptionScope {
  performerId?: string;
  studioId?: string;
}

/** Enough for a performer's whole list; for the whole library, the most used. */
const OPTION_LIMIT = 200;
