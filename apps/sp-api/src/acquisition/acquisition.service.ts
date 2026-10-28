import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  IntegrationStatus,
  IntegrationType,
  MetadataHydrationState,
  Prisma,
  SceneIndex,
  SceneLifecycle,
} from '@prisma/client';
import { IndexingService } from '../indexing/indexing.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  ACQUISITION_BULK_LIMIT,
  AcquisitionBulkAction,
  AcquisitionBulkFailureDto,
  AcquisitionBulkResultDto,
} from './dto/acquisition-bulk.dto';
import {
  AcquisitionCountsByLifecycleDto,
  AcquisitionDownloadDto,
  AcquisitionSceneItemDto,
  AcquisitionScenesFeedDto,
} from './dto/acquisition-scene-feed.dto';
import {
  AcquisitionFeedOptions,
  AcquisitionLifecycle,
  AcquisitionLifecycleFilter,
  AcquisitionSort,
} from './dto/acquisition-scenes-query.dto';

@Injectable()
export class AcquisitionService {
  private static readonly DEFAULT_PAGE = 1;
  private static readonly DEFAULT_PER_PAGE = 24;
  private static readonly ACQUISITION_LIFECYCLES: SceneLifecycle[] = [
    SceneLifecycle.REQUESTED,
    SceneLifecycle.DOWNLOADING,
    SceneLifecycle.IMPORT_PENDING,
    SceneLifecycle.FAILED,
  ];
  /**
   * Pipeline order: failed, downloading, awaiting import, requested. The Home
   * "Still Waiting" rail is the first page of this same list.
   */
  private static readonly STATUS_ORDER: Prisma.SceneIndexOrderByWithRelationInput[] =
    [
      { lifecycleSortOrder: 'asc' },
      { whisparrQueuePosition: 'asc' },
      { requestUpdatedAt: 'desc' },
      { whisparrMovieId: 'asc' },
      { stashId: 'asc' },
    ];
  /** "Recently added": requests Stash got in this many days. */
  private static readonly RECENTLY_ADDED_DAYS = 14;
  private static readonly RECENTLY_ADDED_LIMIT = 200;
  /** A slow Whisparr leaves the bars off rather than holding up the list. */
  private static readonly PROGRESS_TIMEOUT_MS = 4_000;
  private readonly logger = new Logger(AcquisitionService.name);

  constructor(
    private readonly indexingService: IndexingService,
    private readonly integrationsService: IntegrationsService,
    private readonly catalogProviderService: CatalogProviderService,
    private readonly whisparrAdapter: WhisparrAdapter,
    private readonly prisma: PrismaService,
  ) {}

  async getScenesFeed(
    page = AcquisitionService.DEFAULT_PAGE,
    perPage = AcquisitionService.DEFAULT_PER_PAGE,
    lifecycle: AcquisitionLifecycleFilter = 'ANY',
    options: AcquisitionFeedOptions = {},
  ): Promise<AcquisitionScenesFeedDto> {
    const startedAt = Date.now();
    const query = options.q?.trim() ?? '';
    const sort = options.sort ?? 'status';
    const searchWhere = this.buildSearchClause(query);
    if (lifecycle === 'AVAILABLE') {
      return this.getRecentlyAddedFeed(page, perPage, searchWhere);
    }
    const where: Prisma.SceneIndexWhereInput = searchWhere
      ? { AND: [this.buildWhereClause(lifecycle), searchWhere] }
      : this.buildWhereClause(lifecycle);
    const [rows, counts, whisparrConfig, catalogProviderType] =
      await Promise.all([
        this.prisma.sceneIndex.findMany({
          where,
          orderBy: this.buildOrderBy(sort),
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        this.loadCounts(searchWhere),
        this.getWhisparrConfig(),
        this.catalogProviderService.getConfiguredCatalogProviderType(),
      ]);
    const countsByLifecycle = counts.byLifecycle;
    const downloads = await this.getDownloadProgress(rows, whisparrConfig);
    const total =
      lifecycle === 'ANY'
        ? counts.tracked
        : this.getLifecycleTotal(countsByLifecycle, lifecycle);

    const missingMetadataIds = rows
      .filter((row) => this.needsMetadataHydration(row))
      .map((row) => row.stashId);
    if (missingMetadataIds.length > 0) {
      this.indexingService.requestMetadataHydrationForStashIds(
        missingMetadataIds,
        'acquisition-page',
      );
    }

    this.logger.debug(
      `Acquisition feed served from summary: ${JSON.stringify({
        page,
        perPage,
        lifecycle,
        query,
        sort,
        total,
        rowCount: rows.length,
        durationMs: Date.now() - startedAt,
      })}`,
    );

    return {
      total,
      page,
      perPage,
      hasMore: page * perPage < total,
      countsByLifecycle,
      items: rows.map((row) =>
        this.toAcquisitionItem(
          row,
          whisparrConfig?.baseUrl ?? null,
          catalogProviderType ?? 'STASHDB',
          {
            download:
              row.whisparrMovieId !== null
                ? (downloads.get(row.whisparrMovieId) ?? null)
                : null,
          },
        ),
      ),
    };
  }

  /** Requested scenes Stash got in the last few days, newest first. */
  private async getRecentlyAddedFeed(
    page: number,
    perPage: number,
    searchWhere: Prisma.SceneIndexWhereInput | null,
  ): Promise<AcquisitionScenesFeedDto> {
    const [added, counts, whisparrConfig, catalogProviderType] =
      await Promise.all([
        this.findRecentlyAdded(searchWhere),
        this.loadCounts(searchWhere),
        this.getWhisparrConfig(),
        this.catalogProviderService.getConfiguredCatalogProviderType(),
      ]);
    const pageItems = added.slice((page - 1) * perPage, page * perPage);
    return {
      total: added.length,
      page,
      perPage,
      hasMore: page * perPage < added.length,
      countsByLifecycle: counts.byLifecycle,
      items: pageItems.map((entry) =>
        this.toAcquisitionItem(
          entry.row,
          whisparrConfig?.baseUrl ?? null,
          catalogProviderType ?? 'STASHDB',
          {
            addedAt: entry.addedAt.toISOString(),
            stashViewUrl: entry.stashViewUrl,
          },
        ),
      ),
    };
  }

  /**
   * Library scenes Stash added in the last few days that went through a
   * request (in Whisparr or asked for here), each with Stash's added date.
   */
  private async findRecentlyAdded(
    searchWhere: Prisma.SceneIndexWhereInput | null,
  ): Promise<Array<{ row: SceneIndex; addedAt: Date; stashViewUrl: string }>> {
    const since = new Date(
      Date.now() - AcquisitionService.RECENTLY_ADDED_DAYS * 24 * 60 * 60_000,
    );
    const library = await this.prisma.librarySceneIndex.findMany({
      where: { linkedStashId: { not: null }, localCreatedAt: { gte: since } },
      orderBy: { localCreatedAt: 'desc' },
      take: AcquisitionService.RECENTLY_ADDED_LIMIT,
      select: { linkedStashId: true, localCreatedAt: true, viewUrl: true },
    });
    // Newest copy first, so a scene Stash has twice shows its latest arrival.
    const newest = new Map<string, { addedAt: Date; stashViewUrl: string }>();
    for (const entry of library) {
      if (
        entry.linkedStashId &&
        entry.localCreatedAt &&
        !newest.has(entry.linkedStashId)
      ) {
        newest.set(entry.linkedStashId, {
          addedAt: entry.localCreatedAt,
          stashViewUrl: entry.viewUrl,
        });
      }
    }
    if (newest.size === 0) {
      return [];
    }

    const requested: Prisma.SceneIndexWhereInput = {
      stashId: { in: [...newest.keys()] },
      computedLifecycle: SceneLifecycle.AVAILABLE,
      OR: [
        { requestStatus: { not: null } },
        { whisparrMovieId: { not: null } },
      ],
    };
    const rows = await this.prisma.sceneIndex.findMany({
      where: searchWhere ? { AND: [requested, searchWhere] } : requested,
    });
    return rows
      .flatMap((row) => {
        const found = newest.get(row.stashId);
        return found ? [{ row, ...found }] : [];
      })
      .sort(
        (a, b) =>
          b.addedAt.getTime() - a.addedAt.getTime() ||
          a.row.stashId.localeCompare(b.row.stashId),
      );
  }

  /** The tab counts, for a search or (from the summary) everything. */
  private async loadCounts(
    searchWhere: Prisma.SceneIndexWhereInput | null,
  ): Promise<{
    byLifecycle: AcquisitionCountsByLifecycleDto;
    tracked: number;
  }> {
    const [counts, added] = await Promise.all([
      searchWhere
        ? this.countMatchesByLifecycle(searchWhere)
        : this.indexingService.getSceneIndexSummary().then((summary) => ({
            byLifecycle: this.toCountsByLifecycle(summary),
            tracked: summary.acquisitionTrackedScenes,
          })),
      this.findRecentlyAdded(searchWhere),
    ]);
    return {
      byLifecycle: { ...counts.byLifecycle, AVAILABLE: added.length },
      tracked: counts.tracked,
    };
  }

  /**
   * How far along each downloading scene on the page is, from one call to
   * Whisparr's queue. Without Whisparr (or if it's slow) the cards just
   * leave the bar off.
   */
  private async getDownloadProgress(
    rows: SceneIndex[],
    config: { baseUrl: string; apiKey: string | null } | null,
  ): Promise<Map<number, AcquisitionDownloadDto>> {
    const movieIds = new Set(
      rows.flatMap((row) =>
        row.computedLifecycle === SceneLifecycle.DOWNLOADING &&
        row.whisparrMovieId !== null
          ? [row.whisparrMovieId]
          : [],
      ),
    );
    const progress = new Map<number, AcquisitionDownloadDto>();
    if (!config || movieIds.size === 0) {
      return progress;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const queue = await Promise.race([
        this.whisparrAdapter.getQueueDetails(config),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Whisparr took too long')),
            AcquisitionService.PROGRESS_TIMEOUT_MS,
          );
        }),
      ]);
      for (const entry of queue) {
        if (!movieIds.has(entry.movieId)) {
          continue;
        }
        const percent =
          entry.size !== null && entry.size > 0 && entry.sizeLeft !== null
            ? Math.round(
                Math.min(
                  100,
                  Math.max(
                    0,
                    ((entry.size - entry.sizeLeft) / entry.size) * 100,
                  ),
                ),
              )
            : null;
        const current = progress.get(entry.movieId);
        // Two grabs for one scene: show the one further along.
        if (!current || (percent ?? -1) > (current.progress ?? -1)) {
          progress.set(entry.movieId, {
            progress: percent,
            timeLeft: entry.timeLeft,
          });
        }
      }
    } catch (error) {
      this.logger.debug(
        `Download progress left off: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    return progress;
  }

  /**
   * Runs one action on many waiting scenes: search Whisparr again, or remove
   * them from Whisparr. Scenes Whisparr doesn't have come back as failed.
   */
  async runBulkAction(
    action: AcquisitionBulkAction,
    ids: string[],
  ): Promise<AcquisitionBulkResultDto> {
    const stashIds = [
      ...new Set(ids.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, ACQUISITION_BULK_LIMIT);
    const whisparrConfig = await this.getWhisparrConfig();
    if (!whisparrConfig) {
      this.logger.warn(
        `Bulk ${action} of ${stashIds.length} scene(s) refused: Whisparr is not set up.`,
      );
      throw new ConflictException('Set up Whisparr first.');
    }

    const rows = await this.prisma.sceneIndex.findMany({
      where: { stashId: { in: stashIds } },
      select: { stashId: true, title: true, whisparrMovieId: true },
    });
    const rowsById = new Map(rows.map((row) => [row.stashId, row]));
    const failed: AcquisitionBulkFailureDto[] = [];
    const targets: Array<{ stashId: string; movieId: number }> = [];

    for (const stashId of stashIds) {
      const row = rowsById.get(stashId);
      let movieId = row?.whisparrMovieId ?? null;
      if (movieId === null) {
        const movie = await this.whisparrAdapter
          .findMovieByStashId(stashId, whisparrConfig)
          .catch((error: unknown) => {
            this.logger.debug(
              `Couldn't look up scene ${stashId} in Whisparr: ${this.describeError(error, 'unknown error')}`,
            );
            return null;
          });
        movieId = movie?.movieId ?? null;
      }
      if (movieId === null) {
        failed.push({
          id: stashId,
          title: row?.title ?? null,
          reason: 'Whisparr doesn’t have this scene.',
        });
        continue;
      }
      targets.push({ stashId, movieId });
    }

    const titleOf = (stashId: string) => rowsById.get(stashId)?.title ?? null;
    const doneIds: string[] = [];

    if (action === 'search') {
      if (targets.length > 0) {
        try {
          await this.whisparrAdapter.searchMovies(
            whisparrConfig,
            targets.map((target) => target.movieId),
          );
          doneIds.push(...targets.map((target) => target.stashId));
        } catch (error) {
          const reason = this.describeError(
            error,
            'Whisparr didn’t start the search.',
          );
          this.logger.warn(
            `Whisparr didn't start a search for ${targets.length} scene(s): ${reason}`,
          );
          failed.push(
            ...targets.map((target) => ({
              id: target.stashId,
              title: titleOf(target.stashId),
              reason,
            })),
          );
        }
      }
      if (doneIds.length > 0) {
        void this.indexingService
          .requestImmediateRefresh(doneIds, 'acquisition-bulk-search')
          .catch((error: unknown) =>
            this.logger.debug(
              `Refresh after bulk search failed: ${this.describeError(error, 'unknown error')}`,
            ),
          );
      }
    } else {
      for (const target of targets) {
        try {
          await this.whisparrAdapter.deleteMovie(
            whisparrConfig,
            target.movieId,
          );
          doneIds.push(target.stashId);
        } catch (error) {
          const reason = this.describeError(
            error,
            'Whisparr didn’t remove it.',
          );
          this.logger.warn(
            `Whisparr didn't remove “${titleOf(target.stashId) ?? target.stashId}” (movie ${target.movieId}): ${reason}`,
          );
          failed.push({
            id: target.stashId,
            title: titleOf(target.stashId),
            reason,
          });
        }
      }
      if (doneIds.length > 0) {
        // The Whisparr deletes already happened and can't be undone, so a
        // failure here must not turn the whole answer into an error.
        await this.indexingService.forgetRequests(doneIds).catch((error) => {
          this.logger.warn(
            `Removed ${doneIds.length} scenes from Whisparr but could not forget their requests: ${this.describeError(error, 'unknown error')}`,
          );
        });
      }
    }

    this.logger.log(
      `Bulk ${action === 'search' ? 'search' : 'remove'} in Whisparr: ${doneIds.length} of ${stashIds.length} scene(s) done, ${failed.length} failed.`,
    );
    return { action, done: doneIds.length, failed };
  }

  private describeError(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim()
      ? error.message.trim()
      : fallback;
  }

  /** Counts for a search, so the lifecycle cards match what the list shows. */
  private async countMatchesByLifecycle(
    searchWhere: Prisma.SceneIndexWhereInput,
  ): Promise<{
    byLifecycle: Omit<AcquisitionCountsByLifecycleDto, 'AVAILABLE'>;
    tracked: number;
  }> {
    const groups = await this.prisma.sceneIndex.groupBy({
      by: ['computedLifecycle'],
      where: {
        AND: [this.buildWhereClause('ANY'), searchWhere],
      },
      _count: { _all: true },
    });
    const counts: Omit<AcquisitionCountsByLifecycleDto, 'AVAILABLE'> = {
      REQUESTED: 0,
      DOWNLOADING: 0,
      IMPORT_PENDING: 0,
      FAILED: 0,
    };
    for (const group of groups) {
      const lifecycle = group.computedLifecycle as string;
      if (lifecycle in counts) {
        counts[lifecycle as AcquisitionLifecycle] = group._count._all;
      }
    }
    return {
      byLifecycle: counts,
      tracked:
        counts.REQUESTED +
        counts.DOWNLOADING +
        counts.IMPORT_PENDING +
        counts.FAILED,
    };
  }

  private buildSearchClause(query: string): Prisma.SceneIndexWhereInput | null {
    const words = query.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      return null;
    }

    // Every word has to appear in the title, the studio, a performer's name
    // or the catalog id.
    return {
      AND: words.map((word) => ({
        OR: [
          { title: { contains: word, mode: 'insensitive' as const } },
          { studioName: { contains: word, mode: 'insensitive' as const } },
          {
            performerNames: { contains: word, mode: 'insensitive' as const },
          },
          { stashId: { equals: word } },
        ],
      })),
    };
  }

  private buildOrderBy(
    sort: AcquisitionSort,
  ): Prisma.SceneIndexOrderByWithRelationInput[] {
    const tieBreak: Prisma.SceneIndexOrderByWithRelationInput[] = [
      { stashId: 'asc' },
    ];
    switch (sort) {
      case 'requested-desc':
      case 'requested-asc':
        return [
          {
            requestUpdatedAt: {
              sort: sort === 'requested-desc' ? 'desc' : 'asc',
              nulls: 'last',
            },
          },
          ...tieBreak,
        ];
      case 'released-desc':
      case 'released-asc':
        return [
          {
            releaseDate: {
              sort: sort === 'released-desc' ? 'desc' : 'asc',
              nulls: 'last',
            },
          },
          ...tieBreak,
        ];
      case 'title':
        return [{ title: { sort: 'asc', nulls: 'last' } }, ...tieBreak];
      case 'status':
      default:
        return [...AcquisitionService.STATUS_ORDER];
    }
  }

  private toCountsByLifecycle(summary: {
    requestedCount: number;
    downloadingCount: number;
    importPendingCount: number;
    failedCount: number;
  }): Omit<AcquisitionCountsByLifecycleDto, 'AVAILABLE'> {
    return {
      REQUESTED: summary.requestedCount,
      DOWNLOADING: summary.downloadingCount,
      IMPORT_PENDING: summary.importPendingCount,
      FAILED: summary.failedCount,
    };
  }

  private getLifecycleTotal(
    countsByLifecycle: AcquisitionCountsByLifecycleDto,
    lifecycle: AcquisitionLifecycle,
  ): number {
    return countsByLifecycle[lifecycle];
  }

  private buildWhereClause(
    lifecycle: Exclude<AcquisitionLifecycleFilter, 'AVAILABLE'>,
  ): Prisma.SceneIndexWhereInput {
    if (lifecycle === 'ANY') {
      return {
        computedLifecycle: {
          in: AcquisitionService.ACQUISITION_LIFECYCLES,
        },
      };
    }

    return {
      computedLifecycle: lifecycle,
    };
  }

  private needsMetadataHydration(row: SceneIndex): boolean {
    if (row.metadataHydrationState === MetadataHydrationState.PENDING) {
      return true;
    }

    if (
      row.metadataHydrationState !== MetadataHydrationState.FAILED_RETRYABLE
    ) {
      return false;
    }

    if (!row.metadataRetryAfterAt) {
      return true;
    }

    return row.metadataRetryAfterAt.getTime() <= Date.now();
  }

  private toAcquisitionItem(
    row: SceneIndex,
    whisparrBaseUrl: string | null,
    source: 'STASHDB' | 'FANSDB',
    extras: Partial<
      Pick<AcquisitionSceneItemDto, 'download' | 'addedAt' | 'stashViewUrl'>
    > = {},
  ): AcquisitionSceneItemDto {
    const title = row.title?.trim() || row.stashId;
    const description =
      row.description ??
      (row.title
        ? null
        : 'Scene metadata is unavailable from the catalog provider configured for this instance.');

    return {
      id: row.stashId,
      title,
      description,
      imageUrl: row.imageUrl,
      cardImageUrl: row.imageUrl ? withStashImageSize(row.imageUrl, 600) : null,
      studioId: row.studioId,
      studio: row.studioName,
      studioImageUrl: row.studioImageUrl,
      performers: row.performerNames,
      releaseDate: row.releaseDate,
      duration: row.duration,
      type: 'SCENE',
      source,
      status: this.indexingService.toSceneStatus(row),
      queueStatus: row.whisparrQueueStatus,
      queueState: row.whisparrQueueState,
      errorMessage: row.whisparrErrorMessage,
      whisparrViewUrl:
        whisparrBaseUrl && row.whisparrMovieId !== null
          ? this.whisparrAdapter.buildSceneViewUrl(
              whisparrBaseUrl,
              row.whisparrMovieId,
            )
          : null,
      download: extras.download ?? null,
      addedAt: extras.addedAt ?? null,
      stashViewUrl: extras.stashViewUrl ?? null,
    };
  }

  private async getWhisparrConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  } | null> {
    try {
      const integration = await this.integrationsService.findOne(
        IntegrationType.WHISPARR,
      );

      if (!integration.enabled) {
        return null;
      }

      if (integration.status !== IntegrationStatus.CONFIGURED) {
        return null;
      }

      const baseUrl = integration.baseUrl?.trim();
      if (!baseUrl) {
        throw new BadRequestException(
          'WHISPARR integration is missing a base URL.',
        );
      }

      return {
        baseUrl,
        apiKey: integration.apiKey,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }

      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.logger.warn(
        `Couldn't read the Whisparr setup: ${this.describeError(error, 'unknown error')}`,
      );
      return null;
    }
  }
}
