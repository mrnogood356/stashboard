import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import {
  IntegrationType,
  MetadataHydrationState,
  RequestStatus,
  SceneIndex,
  SyncJobStatus,
} from '@prisma/client';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { SceneStatusDto } from '../scene-status/dto/scene-status.dto';
import { SyncStateService } from './sync-state.service';
import {
  INDEXING_JOB_NAMES,
  INDEXING_LIMITS,
  joinPerformerNames,
  KNOWN_INDEXING_JOB_ORDER,
  SCENE_INDEX_SUMMARY_KEY,
  type IndexingDiagnosticsSnapshot,
  type SceneIndexSummarySnapshot,
  type SyncRunSummary,
} from './indexing.model';
import { IndexingSync } from './indexing-sync';
export * from './indexing.model';

@Injectable()
export class IndexingService extends IndexingSync {
  /** Where Stash's library was at the last change check; null until the first. */
  private libraryChangeMarker: string | null = null;

  constructor(
    prisma: PrismaService,
    integrationsService: IntegrationsService,
    catalogProviderService: CatalogProviderService,
    whisparrAdapter: WhisparrAdapter,
    stashAdapter: StashAdapter,
    stashdbAdapter: StashdbAdapter,
    syncStateService: SyncStateService,
    @Optional() notificationsService?: NotificationsService,
  ) {
    super(
      prisma,
      integrationsService,
      catalogProviderService,
      whisparrAdapter,
      stashAdapter,
      stashdbAdapter,
      syncStateService,
      notificationsService,
    );
  }

  async bootstrapIndex(reason = 'startup'): Promise<SyncRunSummary | null> {
    return this.syncStateService.runWithLease(
      {
        jobName: INDEXING_JOB_NAMES.BOOTSTRAP,
        leaseMs: INDEXING_LIMITS.BOOTSTRAP_LEASE_MS,
        onSuccess: (result, context) => ({
          processedCount: result.processedCount,
          updatedCount: result.updatedCount,
          durationMs: context.durationMs,
          runReason: reason,
        }),
      },
      async () => {
        await this.ensureSceneIndexSummary();

        if (!(await this.shouldBootstrap())) {
          this.logger.debug(
            `Scene index already exists; skipping the initial build (${reason}).`,
          );
          return {
            processedCount: 0,
            updatedCount: 0,
          };
        }

        this.logger.log(
          `Building the scene index for the first time (${reason}).`,
        );
        const requestRows = await this.syncRequestRows();
        const movieResult = await this.syncWhisparrMovies(
          `${reason}:bootstrap`,
          true,
        );
        const queueResult = await this.syncWhisparrQueue(
          `${reason}:bootstrap`,
          true,
        );
        const libraryResult = await this.syncLibraryProjection(
          `${reason}:bootstrap`,
        );
        const metadataResult = await this.syncMetadataBackfill(
          `${reason}:bootstrap`,
          true,
        );

        return {
          processedCount:
            requestRows.length +
            (movieResult?.processedCount ?? 0) +
            (queueResult?.processedCount ?? 0) +
            (libraryResult?.processedCount ?? 0) +
            (metadataResult?.processedCount ?? 0),
          updatedCount:
            requestRows.length +
            (movieResult?.updatedCount ?? 0) +
            (queueResult?.updatedCount ?? 0) +
            (libraryResult?.updatedCount ?? 0) +
            (metadataResult?.updatedCount ?? 0),
          diagnostics: {
            requestRows: requestRows.length,
            movieProcessed: movieResult?.processedCount ?? 0,
            queueProcessed: queueResult?.processedCount ?? 0,
            libraryProcessed: libraryResult?.processedCount ?? 0,
            metadataProcessed: metadataResult?.processedCount ?? 0,
          },
        };
      },
    );
  }

  async syncWhisparrQueue(
    reason = 'scheduled',
    skipRequestSync = false,
  ): Promise<SyncRunSummary | null> {
    return this.syncStateService.runWithLease(
      {
        jobName: INDEXING_JOB_NAMES.WHISPARR_QUEUE,
        leaseMs: INDEXING_LIMITS.QUEUE_LEASE_MS,
        onSuccess: (result, context) => ({
          processedCount: result.processedCount,
          updatedCount: result.updatedCount,
          durationMs: context.durationMs,
          runReason: reason,
        }),
      },
      async () => this.performWhisparrQueueSync(reason, skipRequestSync),
    );
  }

  async syncWhisparrMovies(
    reason = 'scheduled',
    skipRequestSync = false,
  ): Promise<SyncRunSummary | null> {
    return this.syncStateService.runWithLease(
      {
        jobName: INDEXING_JOB_NAMES.WHISPARR_MOVIES,
        leaseMs: INDEXING_LIMITS.MOVIES_LEASE_MS,
        onSuccess: (result, context) => ({
          processedCount: result.processedCount,
          updatedCount: result.updatedCount,
          durationMs: context.durationMs,
          runReason: reason,
        }),
      },
      async () => this.performWhisparrMovieSync(reason, skipRequestSync),
    );
  }

  async syncStashAvailability(
    reason = 'scheduled',
    stashIds?: string[],
    forceFullPass = false,
  ): Promise<SyncRunSummary | null> {
    const normalizedIds =
      stashIds && stashIds.length > 0 ? this.normalizeStashIds(stashIds) : [];
    if (normalizedIds.length === 0 || forceFullPass) {
      return this.syncLibraryProjection(reason);
    }

    return this.syncStateService.runWithLease(
      {
        jobName: INDEXING_JOB_NAMES.STASH_AVAILABILITY,
        leaseMs: INDEXING_LIMITS.STASH_LEASE_MS,
        onSuccess: (result, context) => ({
          processedCount: result.processedCount,
          updatedCount: result.updatedCount,
          durationMs: context.durationMs,
          runReason: reason,
        }),
      },
      async () => this.performStashAvailabilitySync(reason, normalizedIds),
    );
  }

  async syncLibraryProjection(
    reason = 'scheduled',
  ): Promise<SyncRunSummary | null> {
    return this.syncStateService.runWithLease(
      {
        jobName: INDEXING_JOB_NAMES.LIBRARY_PROJECTION,
        leaseMs: INDEXING_LIMITS.LIBRARY_LEASE_MS,
        onSuccess: (result, context) => ({
          processedCount: result.processedCount,
          updatedCount: result.updatedCount,
          durationMs: context.durationMs,
          runReason: reason,
        }),
      },
      async () => this.performLibraryProjectionSync(reason),
    );
  }

  /**
   * Runs the library sync early when Stash's library has changed since the
   * last check, so new scenes reach Home within a check rather than waiting
   * for the next full sync. The first check only records where Stash is.
   */
  async syncLibraryProjectionIfChanged(): Promise<SyncRunSummary | null> {
    const config = await this.getStashConfig();
    if (!config) {
      return null;
    }
    let marker: string;
    try {
      marker = await this.stashAdapter.getLibraryChangeMarker(config);
    } catch (error) {
      // The full sync reports Stash being down; this check stays quiet.
      this.logger.debug(
        `Library change check skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    const previous = this.libraryChangeMarker;
    this.libraryChangeMarker = marker;
    if (previous === null || previous === marker) {
      return null;
    }
    try {
      const result = await this.syncLibraryProjection('library-changed');
      if (result === null) {
        // Another sync held the lease; check again next time.
        this.libraryChangeMarker = previous;
      }
      return result;
    } catch (error) {
      // Try again on the next check rather than waiting for the full sync.
      this.libraryChangeMarker = previous;
      throw error;
    }
  }

  async syncMetadataBackfill(
    reason = 'scheduled',
    forceBootstrapPass = false,
  ): Promise<SyncRunSummary | null> {
    if (
      !forceBootstrapPass &&
      reason === 'interval' &&
      !(await this.shouldRunScheduledMetadataBackfill())
    ) {
      return null;
    }

    return this.syncStateService.runWithLease(
      {
        jobName: INDEXING_JOB_NAMES.METADATA_BACKFILL,
        leaseMs: INDEXING_LIMITS.METADATA_LEASE_MS,
        onSuccess: (result, context) => ({
          cursor: result.cursor,
          processedCount: result.processedCount,
          updatedCount: result.updatedCount,
          durationMs: context.durationMs,
          runReason: reason,
        }),
      },
      async () => this.performMetadataBackfill(reason, forceBootstrapPass),
    );
  }

  async hydrateMetadataForStashIds(
    stashIds: string[],
    reason = 'on-demand',
  ): Promise<Map<string, SceneIndex>> {
    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return new Map();
    }

    await this.performMetadataHydration(reason, normalizedIds);
    return this.getSceneIndexRows(normalizedIds);
  }

  requestMetadataHydrationForStashIds(
    stashIds: string[],
    reason = 'on-demand',
  ): void {
    const normalizedIds = this.normalizeStashIds(stashIds).filter(
      (stashId) => !this.metadataHydrationInFlight.has(stashId),
    );
    if (normalizedIds.length === 0) {
      return;
    }

    void this.performMetadataHydration(reason, normalizedIds).catch((error) => {
      this.logger.warn(
        `Background metadata hydration failed. reason=${reason} error=${this.safeJson(
          this.serializeError(error),
        )}`,
      );
    });
  }

  async seedRequestedScene(input: {
    stashId: string;
    requestStatus: RequestStatus;
    requestUpdatedAt: Date;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    studioId: string | null;
    studioName: string | null;
    studioImageUrl: string | null;
    performerNames?: string[];
    releaseDate: string | null;
    duration: number | null;
    whisparrMovieId?: number | null;
    whisparrHasFile?: boolean | null;
  }): Promise<void> {
    const stashId = input.stashId.trim();
    if (!stashId) {
      return;
    }

    const now = new Date();
    await this.applySceneIndexPatches([
      {
        stashId,
        requestStatus: input.requestStatus,
        requestUpdatedAt: input.requestUpdatedAt,
        title: input.title,
        description: input.description,
        imageUrl: input.imageUrl,
        studioId: input.studioId,
        studioName: input.studioName,
        studioImageUrl: input.studioImageUrl,
        performerNames: joinPerformerNames(input.performerNames),
        releaseDate: input.releaseDate,
        duration: input.duration,
        metadataHydrationState: MetadataHydrationState.HYDRATED,
        metadataLastSyncedAt: now,
        metadataRetryAfterAt: null,
        whisparrMovieId: input.whisparrMovieId,
        whisparrHasFile: input.whisparrHasFile,
        whisparrLastSyncedAt:
          input.whisparrMovieId !== undefined ? now : undefined,
        lastSyncedAt: now,
      },
    ]);
  }

  /**
   * Forgets requests removed from Whisparr: drops the local request rows and
   * clears the Whisparr fields, so the scenes leave Acquisition right away.
   */
  async forgetRequests(stashIds: string[]): Promise<void> {
    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return;
    }

    await this.prisma.request.deleteMany({
      where: { stashId: { in: normalizedIds } },
    });
    const now = new Date();
    await this.applySceneIndexPatches(
      normalizedIds.map((stashId) => ({
        stashId,
        requestStatus: null,
        requestUpdatedAt: null,
        whisparrMovieId: null,
        whisparrHasFile: null,
        whisparrQueuePosition: null,
        whisparrQueueStatus: null,
        whisparrQueueState: null,
        whisparrErrorMessage: null,
        whisparrLastSyncedAt: now,
        lastSyncedAt: now,
      })),
    );
  }

  async requestImmediateRefresh(
    stashIds: string[],
    reason = 'manual',
  ): Promise<void> {
    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return;
    }

    await this.syncRequestRows(normalizedIds);

    const results = await Promise.allSettled([
      this.refreshWhisparrMoviesForStashIds(
        normalizedIds,
        `${reason}:whisparr-targeted`,
      ),
      this.refreshStashAvailabilityForStashIds(
        normalizedIds,
        `${reason}:stash-targeted`,
      ),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Priority scene refresh failed. reason=${reason} error=${this.safeJson(
            this.serializeError(result.reason),
          )}`,
        );
      }
    }

    const rows = await this.getSceneIndexRows(normalizedIds);
    const pendingMetadataIds = normalizedIds.filter((stashId) =>
      this.shouldHydrateMetadataNow(rows.get(stashId) ?? null),
    );

    if (pendingMetadataIds.length > 0) {
      this.requestMetadataHydrationForStashIds(
        pendingMetadataIds,
        `${reason}:metadata-targeted`,
      );
    }
  }

  async runManualSync(job?: string): Promise<void> {
    if (!job || job === 'all') {
      await this.bootstrapIndex('manual');
      await this.syncWhisparrMovies('manual');
      await this.syncWhisparrQueue('manual');
      await this.syncLibraryProjection('manual');
      await this.syncMetadataBackfill('manual');
      return;
    }

    switch (job) {
      case 'bootstrap':
        await this.bootstrapIndex('manual');
        return;
      case 'queue':
        await this.syncWhisparrQueue('manual');
        return;
      case 'movies':
        await this.syncWhisparrMovies('manual');
        return;
      case 'stash':
      case 'library':
        await this.syncLibraryProjection('manual');
        return;
      case 'metadata':
        await this.syncMetadataBackfill('manual');
        return;
      default:
        throw new BadRequestException(`Unsupported sync job: ${job}`);
    }
  }

  async getSceneIndexSummary(): Promise<SceneIndexSummarySnapshot> {
    let summary = await this.prisma.sceneIndexSummary.findUnique({
      where: {
        key: SCENE_INDEX_SUMMARY_KEY,
      },
    });
    if (!summary) {
      await this.rebuildSceneIndexSummary();
      summary = await this.prisma.sceneIndexSummary.findUnique({
        where: {
          key: SCENE_INDEX_SUMMARY_KEY,
        },
      });
    }

    return {
      indexedScenes: summary?.indexedScenes ?? 0,
      acquisitionTrackedScenes: summary?.acquisitionTrackedScenes ?? 0,
      requestedCount: summary?.requestedCount ?? 0,
      downloadingCount: summary?.downloadingCount ?? 0,
      importPendingCount: summary?.importPendingCount ?? 0,
      failedCount: summary?.failedCount ?? 0,
      metadataPendingCount: summary?.metadataPendingCount ?? 0,
      metadataRetryableCount: summary?.metadataRetryableCount ?? 0,
      lastIndexWriteAt: summary?.lastIndexWriteAt ?? null,
    };
  }

  async getIndexingDiagnosticsSnapshot(): Promise<IndexingDiagnosticsSnapshot> {
    const summary = await this.getSceneIndexSummary();
    const metadataBacklogCount =
      summary.metadataPendingCount + summary.metadataRetryableCount;
    const metadataHydratedCount = Math.max(
      0,
      summary.indexedScenes - metadataBacklogCount,
    );

    return {
      ...summary,
      metadataHydratedCount,
      metadataBacklogCount,
      metadataHydrationInFlightCount: this.metadataHydrationInFlight.size,
    };
  }

  async getSyncStatus() {
    const [jobs, summary] = await Promise.all([
      this.prisma.syncState.findMany({
        orderBy: {
          jobName: 'asc',
        },
      }),
      this.getSceneIndexSummary(),
    ]);
    const jobByName = new Map(jobs.map((job) => [job.jobName, job]));
    const knownJobNameSet = new Set<string>(KNOWN_INDEXING_JOB_ORDER);
    const metadataBacklogScenes =
      summary.metadataPendingCount + summary.metadataRetryableCount;
    const orderedJobs = [
      ...KNOWN_INDEXING_JOB_ORDER.map(
        (jobName) =>
          jobByName.get(jobName) ?? {
            jobName,
            status: SyncJobStatus.IDLE,
            startedAt: null,
            finishedAt: null,
            leaseUntil: null,
            cursor: null,
            lastError: null,
            lastSuccessAt: null,
            lastDurationMs: null,
            lastProcessedCount: null,
            lastUpdatedCount: null,
            lastRunReason: null,
          },
      ),
      ...jobs.filter((job) => !knownJobNameSet.has(job.jobName)),
    ];

    return {
      totals: {
        indexedScenes: summary.indexedScenes,
        acquisitionTrackedScenes: summary.acquisitionTrackedScenes,
        metadataBacklogScenes,
        metadataHydration: {
          pending: summary.metadataPendingCount,
          retryable: summary.metadataRetryableCount,
        },
      },
      freshness: {
        indexStatusMaxAgeMs: INDEXING_LIMITS.INDEX_STATUS_MAX_AGE_MS,
        requestRowsFresh: this.isSuccessfulSyncFresh(
          jobByName.get(INDEXING_JOB_NAMES.REQUEST_ROWS) ?? null,
          INDEXING_LIMITS.REQUEST_ROWS_FRESHNESS_MAX_AGE_MS,
        ),
        whisparrMoviesFresh: this.isSuccessfulSyncFresh(
          jobByName.get(INDEXING_JOB_NAMES.WHISPARR_MOVIES) ?? null,
          INDEXING_LIMITS.SNAPSHOT_FRESHNESS_MAX_AGE_MS,
        ),
        stashAvailabilityFresh: this.isSuccessfulSyncFresh(
          jobByName.get(INDEXING_JOB_NAMES.LIBRARY_PROJECTION) ?? null,
          INDEXING_LIMITS.SNAPSHOT_FRESHNESS_MAX_AGE_MS,
        ),
        canResolveUnknownScenesAsNotRequested:
          await this.canResolveUnknownScenesAsNotRequested(),
        lastIndexWriteAt: summary.lastIndexWriteAt?.toISOString() ?? null,
        acquisitionCountsSource: 'scene-index-summary',
      },
      jobs: orderedJobs.map((job) => ({
        jobName: job.jobName,
        status: job.status,
        startedAt: job.startedAt?.toISOString() ?? null,
        finishedAt: job.finishedAt?.toISOString() ?? null,
        leaseUntil: job.leaseUntil?.toISOString() ?? null,
        cursor: job.cursor,
        lastError: job.lastError,
        lastSuccessAt: job.lastSuccessAt?.toISOString() ?? null,
        lastDurationMs: job.lastDurationMs ?? null,
        processedCount: job.lastProcessedCount ?? null,
        updatedCount: job.lastUpdatedCount ?? null,
        lastRunReason: job.lastRunReason ?? null,
      })),
    };
  }

  async getSceneIndexRows(
    stashIds: string[],
  ): Promise<Map<string, SceneIndex>> {
    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.sceneIndex.findMany({
      where: {
        stashId: {
          in: normalizedIds,
        },
      },
    });

    return new Map(rows.map((row) => [row.stashId, row]));
  }

  async getFreshSceneIndexRows(
    stashIds: string[],
  ): Promise<Map<string, SceneIndex>> {
    const rows = await this.getSceneIndexRows(stashIds);
    const usableRows = new Map<string, SceneIndex>();

    for (const [stashId, row] of rows.entries()) {
      if (this.isIndexedStatusUsable(row)) {
        usableRows.set(stashId, row);
      }
    }

    return usableRows;
  }

  toSceneStatus(row: Pick<SceneIndex, 'computedLifecycle'>): SceneStatusDto {
    return {
      state: row.computedLifecycle,
    };
  }

  isIndexedStatusUsable(row: SceneIndex): boolean {
    if (!row.lastSyncedAt) {
      return false;
    }

    return (
      Date.now() - row.lastSyncedAt.getTime() <=
      INDEXING_LIMITS.INDEX_STATUS_MAX_AGE_MS
    );
  }

  async canResolveUnknownScenesAsNotRequested(): Promise<boolean> {
    const [hasWhisparr, hasStash, states] = await Promise.all([
      this.isIntegrationConfigured(IntegrationType.WHISPARR),
      this.isIntegrationConfigured(IntegrationType.STASH),
      this.prisma.syncState.findMany({
        where: {
          jobName: {
            in: [
              INDEXING_JOB_NAMES.REQUEST_ROWS,
              INDEXING_JOB_NAMES.WHISPARR_MOVIES,
              INDEXING_JOB_NAMES.LIBRARY_PROJECTION,
            ],
          },
        },
      }),
    ]);

    const stateByJobName = new Map(
      states.map((state) => [state.jobName, state]),
    );

    return (
      this.isSuccessfulSyncFresh(
        stateByJobName.get(INDEXING_JOB_NAMES.REQUEST_ROWS) ?? null,
        INDEXING_LIMITS.REQUEST_ROWS_FRESHNESS_MAX_AGE_MS,
      ) &&
      (!hasWhisparr ||
        this.isSuccessfulSyncFresh(
          stateByJobName.get(INDEXING_JOB_NAMES.WHISPARR_MOVIES) ?? null,
          INDEXING_LIMITS.SNAPSHOT_FRESHNESS_MAX_AGE_MS,
        )) &&
      (!hasStash ||
        this.isSuccessfulSyncFresh(
          stateByJobName.get(INDEXING_JOB_NAMES.LIBRARY_PROJECTION) ?? null,
          INDEXING_LIMITS.SNAPSHOT_FRESHNESS_MAX_AGE_MS,
        ))
    );
  }

  private async shouldBootstrap(): Promise<boolean> {
    const [indexedCount, unsyncedCount, requestCount] = await Promise.all([
      this.prisma.sceneIndex.count(),
      this.prisma.sceneIndex.count({
        where: {
          lastSyncedAt: null,
        },
      }),
      this.prisma.request.count(),
    ]);

    if (requestCount > indexedCount) {
      return true;
    }

    if (unsyncedCount > 0) {
      return true;
    }

    if (indexedCount > 0) {
      return false;
    }

    const hasWhisparr = await this.isIntegrationConfigured(
      IntegrationType.WHISPARR,
    );
    const hasStash = await this.isIntegrationConfigured(IntegrationType.STASH);

    return requestCount > 0 || hasWhisparr || hasStash;
  }
}
