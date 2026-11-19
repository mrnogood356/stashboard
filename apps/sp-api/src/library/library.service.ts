import type { LibraryPerformersDto } from './dto/library-performers.dto';
import { stashMediaUrl } from '../media/media-url.util';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LibraryScenesFeedDto,
  LibrarySceneFeedItemDto,
} from './dto/library-scenes-feed.dto';
import {
  LibraryResolution,
  LibrarySceneSort,
  LibrarySortDirection,
  LibraryTagMatchMode,
} from './dto/library-scenes-query.dto';
import { LibraryStudioOptionDto } from './dto/library-studio-option.dto';
import { LibraryTagOptionDto } from './dto/library-tag-option.dto';
import { LibrarySceneQueryService } from './library-scene-query.service';

@Injectable()
export class LibraryService {
  /** Rankings being paged through, by snapshot id, oldest first. */
  private readonly rankings = new Map<string, KeptRanking>();

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
    resolution?: LibraryResolution,
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
      resolution,
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
    snapshot?: string,
  ): Promise<LibraryPerformersDto> {
    const name = query?.trim() ?? '';
    return this.pageOfRanking(
      `performers\u0000${name}`,
      page,
      perPage,
      snapshot,
      () => {
        // The name is plain text: % and _ in it mean themselves.
        const nameFilter = name
          ? Prisma.sql`WHERE p.name ILIKE ${`%${likeLiteral(name)}%`} ESCAPE '\\'`
          : Prisma.empty;
        return this.prisma.$queryRaw<RankedRow[]>(Prisma.sql`
          SELECT p.id, MIN(p.name) AS name, COUNT(*)::int AS count
          FROM "LibrarySceneIndex" s,
            unnest(s."performerIds", s."performerNames") AS p(id, name)
          ${nameFilter}
          GROUP BY p.id
          ORDER BY count DESC, name ASC, id ASC`);
      },
      (id) =>
        stashMediaUrl(`performers/${encodeURIComponent(id)}/image`, null, 480),
    );
  }

  /** Every studio with a scene of yours, most scenes first, a page at a time. */
  async listStudios(
    query?: string,
    page = 1,
    perPage = 48,
    snapshot?: string,
  ): Promise<LibraryPerformersDto> {
    const name = query?.trim() ?? '';
    return this.pageOfRanking(
      `studios\u0000${name}`,
      page,
      perPage,
      snapshot,
      () => {
        // The name is plain text: % and _ in it mean themselves.
        const nameFilter = name
          ? Prisma.sql`AND "studioName" ILIKE ${`%${likeLiteral(name)}%`} ESCAPE '\\'`
          : Prisma.empty;
        return this.prisma.$queryRaw<RankedRow[]>(Prisma.sql`
          SELECT "studioId" AS id, MIN("studioName") AS name, COUNT(*)::int AS count
          FROM "LibrarySceneIndex"
          WHERE "studioId" IS NOT NULL AND "studioName" IS NOT NULL ${nameFilter}
          GROUP BY "studioId"
          ORDER BY count DESC, name ASC, id ASC`);
      },
      (id) =>
        stashMediaUrl(`studios/${encodeURIComponent(id)}/logo`, null, 480),
    );
  }

  /**
   * One page of a ranking. The first page ranks everyone and keeps that
   * order under a snapshot id; later pages with that id are cut from the
   * same order, so someone moving up while you page (a download landing)
   * can't fall into a page you've already seen and be missed.
   */
  private async pageOfRanking(
    key: string,
    page: number,
    perPage: number,
    snapshot: string | undefined,
    rank: () => Promise<RankedRow[]>,
    imageUrl: (id: string) => string,
  ): Promise<LibraryPerformersDto> {
    const now = Date.now();
    for (const [id, kept] of this.rankings) {
      if (now - kept.at > RANKING_TTL_MS) {
        this.rankings.delete(id);
      }
    }
    let id = snapshot;
    let kept = id ? this.rankings.get(id) : undefined;
    if (!kept || kept.key !== key) {
      // A new search, or one kept too long: rank again.
      id = randomUUID();
      kept = { key, rows: await rank(), at: now };
      this.rankings.set(id, kept);
      while (this.rankings.size > RANKINGS_KEPT) {
        this.rankings.delete(this.rankings.keys().next().value as string);
      }
    }
    const total = kept.rows.length;
    const rows = kept.rows.slice((page - 1) * perPage, page * perPage);
    return {
      total,
      page,
      perPage,
      hasMore: page * perPage < total,
      snapshot: id!,
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        count: row.count,
        imageUrl: imageUrl(row.id),
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

interface RankedRow {
  id: string;
  name: string;
  count: number;
}

interface KeptRanking {
  /** What was ranked: the list and the name searched for. */
  key: string;
  rows: RankedRow[];
  at: number;
}

/** How long a ranking is kept for paging through it. */
const RANKING_TTL_MS = 15 * 60_000;
/** Rankings kept at once; the oldest goes first. */
const RANKINGS_KEPT = 50;

/** Enough for a performer's whole list; for the whole library, the most used. */
const OPTION_LIMIT = 200;

/** Text for ILIKE that matches itself: %, _ and \\ escaped. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
