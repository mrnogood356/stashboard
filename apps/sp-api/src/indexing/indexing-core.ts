import { Logger } from '@nestjs/common';
import {
  NotificationsService,
  type SceneNotification,
} from '../notifications/notifications.service';
import {
  IntegrationStatus,
  IntegrationType,
  MetadataHydrationState,
  Prisma,
  SceneIndex,
  SceneLifecycle,
  SyncJobStatus,
} from '@prisma/client';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { type CatalogProviderKey } from '../providers/catalog/catalog-provider.util';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  resolveSceneStatus,
  WhisparrQueueSnapshotItem as ResolverQueueItem,
} from '../scene-status/scene-status.resolver';
import { SyncStateService } from './sync-state.service';
import {
  ACQUISITION_LIFECYCLES,
  INDEXING_LIMITS,
  SCENE_INDEX_SUMMARY_KEY,
  type MetadataHydrationCandidate,
  type SceneIndexPatch,
  type SceneIndexSummaryDelta,
  type SceneIndexUpsertData,
} from './indexing.model';

/**
 * The scene index's storage: writing patches in safe batches, keeping the
 * summary counts and lifecycle notifications right, and finding each
 * integration's settings.
 */
export abstract class IndexingCore {
  protected readonly logger = new Logger('IndexingService');

  protected sceneIndexWriteBarrier: Promise<void> = Promise.resolve();

  protected readonly metadataHydrationInFlight = new Set<string>();

  protected nextMetadataBackfillCheckAt: number | null = null;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly integrationsService: IntegrationsService,
    protected readonly catalogProviderService: CatalogProviderService,
    protected readonly whisparrAdapter: WhisparrAdapter,
    protected readonly stashAdapter: StashAdapter,
    protected readonly stashdbAdapter: StashdbAdapter,
    protected readonly syncStateService: SyncStateService,
    protected readonly notificationsService?: NotificationsService,
  ) {}

  protected async applySceneIndexPatches(
    patches: SceneIndexPatch[],
    queueItemsByStashId?: Map<string, ResolverQueueItem[]>,
  ): Promise<void> {
    await this.withSceneIndexWriteBarrier(async () => {
      const mergedPatches = this.mergePatchesByStashId(patches).sort(
        (left, right) => left.stashId.localeCompare(right.stashId),
      );
      if (mergedPatches.length === 0) {
        return;
      }

      await this.ensureSceneIndexSummary();

      const existingRows = await this.prisma.sceneIndex.findMany({
        where: {
          stashId: {
            in: mergedPatches.map((patch) => patch.stashId),
          },
        },
      });
      const existingByStashId = new Map(
        existingRows.map((row) => [row.stashId, row]),
      );

      for (
        let i = 0;
        i < mergedPatches.length;
        i += INDEXING_LIMITS.APPLY_PATCH_CHUNK_SIZE
      ) {
        const chunk = mergedPatches.slice(
          i,
          i + INDEXING_LIMITS.APPLY_PATCH_CHUNK_SIZE,
        );
        await this.executePatchChunk(
          chunk,
          existingByStashId,
          queueItemsByStashId,
        );
      }
    });
  }

  protected async executePatchChunk(
    chunk: SceneIndexPatch[],
    existingByStashId: Map<string, SceneIndex>,
    queueItemsByStashId?: Map<string, ResolverQueueItem[]>,
  ): Promise<void> {
    for (
      let attempt = 1;
      attempt <= INDEXING_LIMITS.UPSERT_DEADLOCK_RETRY_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const nextRows = chunk.map((patch) =>
          this.buildSceneIndexUpsertData(
            existingByStashId.get(patch.stashId) ?? null,
            patch,
            queueItemsByStashId?.get(patch.stashId),
          ),
        );
        const summaryDelta = this.buildSceneIndexSummaryDelta(
          chunk,
          nextRows,
          existingByStashId,
        );

        await this.prisma.$transaction(async (tx) => {
          // New rows go in with one bulk insert (the first sync of a large
          // library is almost all new rows); existing rows are updated one by one.
          const newRows = nextRows.filter(
            (data) => !existingByStashId.has(data.stashId),
          );
          const changedRows = nextRows.filter((data) =>
            existingByStashId.has(data.stashId),
          );
          let rowsToUpsert = changedRows;

          if (newRows.length > 0) {
            const created = await tx.sceneIndex.createMany({
              data: newRows,
              skipDuplicates: true,
            });
            if (created.count !== newRows.length) {
              // Something else wrote some of these rows first; upsert them all to be safe.
              rowsToUpsert = nextRows;
            }
          }

          for (const data of rowsToUpsert) {
            await tx.sceneIndex.upsert({
              where: {
                stashId: data.stashId,
              },
              create: data,
              update: data,
            });
          }

          if (this.hasSummaryDelta(summaryDelta)) {
            await tx.sceneIndexSummary.update({
              where: {
                key: SCENE_INDEX_SUMMARY_KEY,
              },
              data: this.buildSceneIndexSummaryDeltaUpdate(summaryDelta),
            });
          }
        }, this.indexWriteTransactionOptions());

        const notifications = this.collectLifecycleNotifications(
          nextRows,
          existingByStashId,
        );
        for (const row of nextRows) {
          existingByStashId.set(row.stashId, row as SceneIndex);
        }
        this.invalidateScheduledMetadataBackfillCheckIfNeeded(nextRows);
        if (notifications.length > 0 && this.notificationsService) {
          void this.notificationsService.notifySceneChanges(notifications);
        }
        return;
      } catch (error) {
        if (
          !this.isDeadlockError(error) ||
          attempt >= INDEXING_LIMITS.UPSERT_DEADLOCK_RETRY_ATTEMPTS
        ) {
          throw error;
        }

        this.logger.warn(
          `Retrying a deadlocked scene index update of ${chunk.length} scene(s) (attempt ${attempt}).`,
        );
        await this.sleep(50 * attempt);
      }
    }
  }

  /**
   * Requests that moved forward in this batch. Rows seen for the first time are
   * ignored, so the first sync after install doesn't send a flood of messages.
   */
  protected collectLifecycleNotifications(
    nextRows: SceneIndexUpsertData[],
    existingByStashId: Map<string, SceneIndex>,
  ): SceneNotification[] {
    const pending = new Set<string>([
      'REQUESTED',
      'DOWNLOADING',
      'IMPORT_PENDING',
    ]);
    const notifications: SceneNotification[] = [];

    for (const next of nextRows) {
      const previous = existingByStashId.get(next.stashId);
      const before = previous?.computedLifecycle as string | undefined;
      const after = next.computedLifecycle as string | undefined;
      if (!previous || !before || !after || before === after) {
        continue;
      }

      const title =
        next.title?.trim() || previous.title?.trim() || next.stashId;
      if (
        after === 'DOWNLOADING' &&
        (before === 'REQUESTED' || before === 'NOT_REQUESTED')
      ) {
        notifications.push({ event: 'DOWNLOADING', title });
      } else if (after === 'AVAILABLE' && pending.has(before)) {
        notifications.push({ event: 'AVAILABLE', title });
      } else if (after === 'FAILED' && pending.has(before)) {
        notifications.push({ event: 'FAILED', title });
      }
    }

    return notifications;
  }

  protected buildSceneIndexUpsertData(
    existing: SceneIndex | null,
    patch: SceneIndexPatch,
    queueItems?: ResolverQueueItem[],
  ): SceneIndexUpsertData {
    const merged: SceneIndexUpsertData = {
      stashId: patch.stashId,
      requestStatus: this.pickValue(
        patch.requestStatus,
        existing?.requestStatus ?? null,
      ),
      requestUpdatedAt: this.pickValue(
        patch.requestUpdatedAt,
        existing?.requestUpdatedAt ?? null,
      ),
      title: this.pickValue(patch.title, existing?.title ?? null),
      description: this.pickValue(
        patch.description,
        existing?.description ?? null,
      ),
      imageUrl: this.pickValue(patch.imageUrl, existing?.imageUrl ?? null),
      studioId: this.pickValue(patch.studioId, existing?.studioId ?? null),
      studioName: this.pickValue(
        patch.studioName,
        existing?.studioName ?? null,
      ),
      studioImageUrl: this.pickValue(
        patch.studioImageUrl,
        existing?.studioImageUrl ?? null,
      ),
      performerNames: this.pickValue(
        patch.performerNames,
        existing?.performerNames ?? null,
      ),
      releaseDate: this.pickValue(
        patch.releaseDate,
        existing?.releaseDate ?? null,
      ),
      duration: this.pickValue(patch.duration, existing?.duration ?? null),
      whisparrMovieId: this.pickValue(
        patch.whisparrMovieId,
        existing?.whisparrMovieId ?? null,
      ),
      whisparrHasFile: this.pickValue(
        patch.whisparrHasFile,
        existing?.whisparrHasFile ?? null,
      ),
      whisparrQueuePosition: this.pickValue(
        patch.whisparrQueuePosition,
        existing?.whisparrQueuePosition ?? null,
      ),
      whisparrQueueStatus: this.pickValue(
        patch.whisparrQueueStatus,
        existing?.whisparrQueueStatus ?? null,
      ),
      whisparrQueueState: this.pickValue(
        patch.whisparrQueueState,
        existing?.whisparrQueueState ?? null,
      ),
      whisparrErrorMessage: this.pickValue(
        patch.whisparrErrorMessage,
        existing?.whisparrErrorMessage ?? null,
      ),
      stashAvailable: this.pickValue(
        patch.stashAvailable,
        existing?.stashAvailable ?? null,
      ),
      metadataHydrationState: this.pickValue(
        patch.metadataHydrationState,
        existing?.metadataHydrationState ?? MetadataHydrationState.PENDING,
      ),
      metadataLastSyncedAt: this.pickValue(
        patch.metadataLastSyncedAt,
        existing?.metadataLastSyncedAt ?? null,
      ),
      metadataRetryAfterAt: this.pickValue(
        patch.metadataRetryAfterAt,
        existing?.metadataRetryAfterAt ?? null,
      ),
      whisparrLastSyncedAt: this.pickValue(
        patch.whisparrLastSyncedAt,
        existing?.whisparrLastSyncedAt ?? null,
      ),
      stashLastSyncedAt: this.pickValue(
        patch.stashLastSyncedAt,
        existing?.stashLastSyncedAt ?? null,
      ),
      lastSyncedAt: this.pickValue(
        patch.lastSyncedAt,
        existing?.lastSyncedAt ?? null,
      ),
      computedLifecycle: SceneLifecycle.NOT_REQUESTED,
      lifecycleSortOrder: 999,
    };

    const computedLifecycle = this.computeLifecycle(merged, queueItems);
    merged.computedLifecycle = computedLifecycle;
    merged.lifecycleSortOrder = this.lifecycleSortOrder(computedLifecycle);

    return merged;
  }

  protected computeLifecycle(
    row: Pick<
      SceneIndexPatch,
      | 'stashId'
      | 'requestStatus'
      | 'whisparrMovieId'
      | 'whisparrHasFile'
      | 'whisparrQueueStatus'
      | 'whisparrQueueState'
      | 'whisparrErrorMessage'
      | 'stashAvailable'
    >,
    queueItems?: ResolverQueueItem[],
  ): SceneLifecycle {
    const movie =
      row.whisparrMovieId !== null && row.whisparrMovieId !== undefined
        ? {
            movieId: row.whisparrMovieId,
            stashId: row.stashId,
            hasFile: row.whisparrHasFile === true,
          }
        : null;

    const resolved = resolveSceneStatus({
      stashId: row.stashId,
      movie,
      queueItems: queueItems ?? this.synthesizeQueueItems(row),
      stashAvailable: row.stashAvailable === true,
      fallbackRequestStatus: row.requestStatus ?? null,
    });

    return resolved.state;
  }

  protected synthesizeQueueItems(
    row: Pick<
      SceneIndexPatch,
      | 'whisparrMovieId'
      | 'whisparrQueueStatus'
      | 'whisparrQueueState'
      | 'whisparrErrorMessage'
    >,
  ): ResolverQueueItem[] {
    if (
      row.whisparrMovieId === null ||
      row.whisparrMovieId === undefined ||
      !row.whisparrQueueStatus
    ) {
      return [];
    }

    return [
      {
        movieId: row.whisparrMovieId,
        status: row.whisparrQueueStatus,
        trackedDownloadState: row.whisparrQueueState ?? null,
        trackedDownloadStatus: null,
        errorMessage: row.whisparrErrorMessage ?? null,
      },
    ];
  }

  protected lifecycleSortOrder(lifecycle: SceneLifecycle): number {
    switch (lifecycle) {
      case SceneLifecycle.FAILED:
        return 0;
      case SceneLifecycle.DOWNLOADING:
        return 1;
      case SceneLifecycle.IMPORT_PENDING:
        return 2;
      case SceneLifecycle.REQUESTED:
        return 3;
      case SceneLifecycle.AVAILABLE:
        return 90;
      case SceneLifecycle.NOT_REQUESTED:
      default:
        return 100;
    }
  }

  protected mergePatchesByStashId(
    patches: SceneIndexPatch[],
  ): SceneIndexPatch[] {
    const merged = new Map<string, SceneIndexPatch>();

    for (const patch of patches) {
      const stashId = patch.stashId.trim();
      if (!stashId) {
        continue;
      }

      merged.set(stashId, {
        ...(merged.get(stashId) ?? { stashId }),
        ...patch,
        stashId,
      });
    }

    return Array.from(merged.values());
  }

  protected buildSceneIndexSummaryDelta(
    chunk: SceneIndexPatch[],
    nextRows: SceneIndexUpsertData[],
    existingByStashId: Map<string, SceneIndex>,
  ): SceneIndexSummaryDelta {
    const delta: SceneIndexSummaryDelta = {
      indexedScenes: 0,
      acquisitionTrackedScenes: 0,
      requestedCount: 0,
      downloadingCount: 0,
      importPendingCount: 0,
      failedCount: 0,
      metadataPendingCount: 0,
      metadataRetryableCount: 0,
      lastIndexWriteAt: chunk.length > 0 ? new Date() : null,
    };

    nextRows.forEach((nextRow, index) => {
      const patch = chunk[index];
      const existing = existingByStashId.get(patch?.stashId ?? '') ?? null;

      if (!existing) {
        delta.indexedScenes += 1;
      }

      delta.acquisitionTrackedScenes +=
        (this.isAcquisitionLifecycle(nextRow.computedLifecycle) ? 1 : 0) -
        (this.isAcquisitionLifecycle(existing?.computedLifecycle ?? null)
          ? 1
          : 0);

      delta.requestedCount += this.lifecycleCountDelta(
        nextRow.computedLifecycle,
        existing?.computedLifecycle ?? null,
        SceneLifecycle.REQUESTED,
      );
      delta.downloadingCount += this.lifecycleCountDelta(
        nextRow.computedLifecycle,
        existing?.computedLifecycle ?? null,
        SceneLifecycle.DOWNLOADING,
      );
      delta.importPendingCount += this.lifecycleCountDelta(
        nextRow.computedLifecycle,
        existing?.computedLifecycle ?? null,
        SceneLifecycle.IMPORT_PENDING,
      );
      delta.failedCount += this.lifecycleCountDelta(
        nextRow.computedLifecycle,
        existing?.computedLifecycle ?? null,
        SceneLifecycle.FAILED,
      );

      delta.metadataPendingCount += this.metadataStateCountDelta(
        nextRow.metadataHydrationState,
        existing?.metadataHydrationState ?? null,
        MetadataHydrationState.PENDING,
      );
      delta.metadataRetryableCount += this.metadataStateCountDelta(
        nextRow.metadataHydrationState,
        existing?.metadataHydrationState ?? null,
        MetadataHydrationState.FAILED_RETRYABLE,
      );
    });

    return delta;
  }

  protected buildSceneIndexSummaryDeltaUpdate(
    delta: SceneIndexSummaryDelta,
  ): Prisma.SceneIndexSummaryUpdateInput {
    return {
      indexedScenes: {
        increment: delta.indexedScenes,
      },
      acquisitionTrackedScenes: {
        increment: delta.acquisitionTrackedScenes,
      },
      requestedCount: {
        increment: delta.requestedCount,
      },
      downloadingCount: {
        increment: delta.downloadingCount,
      },
      importPendingCount: {
        increment: delta.importPendingCount,
      },
      failedCount: {
        increment: delta.failedCount,
      },
      metadataPendingCount: {
        increment: delta.metadataPendingCount,
      },
      metadataRetryableCount: {
        increment: delta.metadataRetryableCount,
      },
      lastIndexWriteAt: delta.lastIndexWriteAt,
    };
  }

  protected hasSummaryDelta(delta: SceneIndexSummaryDelta): boolean {
    return (
      delta.indexedScenes !== 0 ||
      delta.acquisitionTrackedScenes !== 0 ||
      delta.requestedCount !== 0 ||
      delta.downloadingCount !== 0 ||
      delta.importPendingCount !== 0 ||
      delta.failedCount !== 0 ||
      delta.metadataPendingCount !== 0 ||
      delta.metadataRetryableCount !== 0 ||
      delta.lastIndexWriteAt !== null
    );
  }

  protected lifecycleCountDelta(
    nextLifecycle: SceneLifecycle,
    previousLifecycle: SceneLifecycle | null,
    targetLifecycle: SceneLifecycle,
  ): number {
    return (
      (nextLifecycle === targetLifecycle ? 1 : 0) -
      (previousLifecycle === targetLifecycle ? 1 : 0)
    );
  }

  protected metadataStateCountDelta(
    nextState: MetadataHydrationState,
    previousState: MetadataHydrationState | null,
    targetState: MetadataHydrationState,
  ): number {
    return (
      (nextState === targetState ? 1 : 0) -
      (previousState === targetState ? 1 : 0)
    );
  }

  protected isAcquisitionLifecycle(
    lifecycle: SceneLifecycle | null,
  ): lifecycle is SceneLifecycle {
    return lifecycle !== null && ACQUISITION_LIFECYCLES.includes(lifecycle);
  }

  protected async ensureSceneIndexSummary(): Promise<void> {
    const existingSummary = await this.prisma.sceneIndexSummary.findUnique({
      where: {
        key: SCENE_INDEX_SUMMARY_KEY,
      },
      select: {
        key: true,
      },
    });

    if (existingSummary) {
      return;
    }

    await this.rebuildSceneIndexSummary();
  }

  protected async rebuildSceneIndexSummary(): Promise<void> {
    const [
      indexedScenes,
      requestedCount,
      downloadingCount,
      importPendingCount,
      failedCount,
      metadataPendingCount,
      metadataRetryableCount,
      newestRow,
    ] = await this.prisma.$transaction([
      this.prisma.sceneIndex.count(),
      this.prisma.sceneIndex.count({
        where: {
          computedLifecycle: SceneLifecycle.REQUESTED,
        },
      }),
      this.prisma.sceneIndex.count({
        where: {
          computedLifecycle: SceneLifecycle.DOWNLOADING,
        },
      }),
      this.prisma.sceneIndex.count({
        where: {
          computedLifecycle: SceneLifecycle.IMPORT_PENDING,
        },
      }),
      this.prisma.sceneIndex.count({
        where: {
          computedLifecycle: SceneLifecycle.FAILED,
        },
      }),
      this.prisma.sceneIndex.count({
        where: {
          metadataHydrationState: MetadataHydrationState.PENDING,
        },
      }),
      this.prisma.sceneIndex.count({
        where: {
          metadataHydrationState: MetadataHydrationState.FAILED_RETRYABLE,
        },
      }),
      this.prisma.sceneIndex.findFirst({
        select: {
          lastSyncedAt: true,
          updatedAt: true,
        },
        orderBy: {
          updatedAt: 'desc',
        },
      }),
    ]);

    await this.prisma.sceneIndexSummary.upsert({
      where: {
        key: SCENE_INDEX_SUMMARY_KEY,
      },
      create: {
        key: SCENE_INDEX_SUMMARY_KEY,
        indexedScenes,
        acquisitionTrackedScenes:
          requestedCount + downloadingCount + importPendingCount + failedCount,
        requestedCount,
        downloadingCount,
        importPendingCount,
        failedCount,
        metadataPendingCount,
        metadataRetryableCount,
        lastIndexWriteAt:
          newestRow?.lastSyncedAt ?? newestRow?.updatedAt ?? null,
      },
      update: {
        indexedScenes,
        acquisitionTrackedScenes:
          requestedCount + downloadingCount + importPendingCount + failedCount,
        requestedCount,
        downloadingCount,
        importPendingCount,
        failedCount,
        metadataPendingCount,
        metadataRetryableCount,
        lastIndexWriteAt:
          newestRow?.lastSyncedAt ?? newestRow?.updatedAt ?? null,
      },
    });
  }

  protected indexWriteTransactionOptions(): {
    maxWait: number;
    timeout: number;
  } {
    return {
      maxWait: INDEXING_LIMITS.INDEX_WRITE_TRANSACTION_MAX_WAIT_MS,
      timeout: INDEXING_LIMITS.INDEX_WRITE_TRANSACTION_TIMEOUT_MS,
    };
  }

  protected isDeadlockError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.message.toLowerCase().includes('deadlock detected');
    }

    return false;
  }

  protected normalizeStashIds(stashIds: string[]): string[] {
    return Array.from(
      new Set(
        stashIds
          .map((stashId) => stashId.trim())
          .filter((stashId) => stashId.length > 0),
      ),
    );
  }

  protected async isIntegrationConfigured(
    type: IntegrationType,
  ): Promise<boolean> {
    try {
      const integration = await this.integrationsService.findOne(type);
      return (
        integration.enabled &&
        integration.status === IntegrationStatus.CONFIGURED &&
        Boolean(integration.baseUrl?.trim())
      );
    } catch {
      return false;
    }
  }

  protected async getWhisparrConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  } | null> {
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

      return {
        baseUrl,
        apiKey: integration.apiKey,
      };
    } catch {
      return null;
    }
  }

  protected async getStashConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  } | null> {
    try {
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

      return {
        baseUrl,
        apiKey: integration.apiKey,
      };
    } catch {
      return null;
    }
  }

  protected async getActiveCatalogProviderKey(): Promise<CatalogProviderKey | null> {
    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProviderOrNull();
    return catalogProvider?.providerKey ?? null;
  }

  protected async getActiveCatalogConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  } | null> {
    const catalogProvider =
      await this.catalogProviderService.getConfiguredCatalogProviderOrNull();
    if (!catalogProvider) {
      return null;
    }

    return {
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
    };
  }

  protected safeJson(value: unknown): string {
    try {
      const serialized = JSON.stringify(value, null, 2);
      if (!serialized) {
        return 'null';
      }

      return serialized.length > 4000
        ? `${serialized.slice(0, 4000)}...(truncated)`
        : serialized;
    } catch {
      return '[unserializable]';
    }
  }

  protected serializeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    return {
      type: typeof error,
      value: error,
    };
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * These ids plus every scene that is the same as one of them (StashDB
   * merged the two, or you said so): Stash links only one of them.
   */
  protected async withAliases(stashIds: Set<string>): Promise<Set<string>> {
    const aliases = await this.prisma.sceneStashAlias.findMany();
    const result = new Set(stashIds);
    for (const alias of aliases) {
      if (stashIds.has(alias.aliasOf)) {
        result.add(alias.stashId);
      }
    }
    return result;
  }

  protected isSuccessfulSyncFresh(
    state: {
      status: SyncJobStatus;
      lastSuccessAt: Date | null;
    } | null,
    maxAgeMs: number,
  ): boolean {
    if (
      !state ||
      state.status !== SyncJobStatus.SUCCEEDED ||
      !state.lastSuccessAt
    ) {
      return false;
    }

    return Date.now() - state.lastSuccessAt.getTime() <= maxAgeMs;
  }

  protected pickValue<T>(incoming: T | undefined, existing: T): T {
    return incoming === undefined ? existing : incoming;
  }

  protected async withSceneIndexWriteBarrier<T>(
    task: () => Promise<T>,
  ): Promise<T> {
    const previousBarrier = this.sceneIndexWriteBarrier;
    let releaseBarrier!: () => void;

    this.sceneIndexWriteBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    await previousBarrier;

    try {
      return await task();
    } finally {
      releaseBarrier();
    }
  }

  protected invalidateScheduledMetadataBackfillCheckIfNeeded(
    rows: MetadataHydrationCandidate[],
  ): void {
    if (this.nextMetadataBackfillCheckAt === null) {
      return;
    }

    if (rows.some((row) => this.shouldHydrateMetadataNow(row))) {
      this.nextMetadataBackfillCheckAt = null;
    }
  }

  protected shouldHydrateMetadataNow(
    row: MetadataHydrationCandidate | null,
  ): boolean {
    if (!row) {
      return true;
    }

    if (row.metadataHydrationState === MetadataHydrationState.PENDING) {
      return true;
    }

    if (
      row.metadataHydrationState !== MetadataHydrationState.FAILED_RETRYABLE
    ) {
      return false;
    }

    const retryAfterAt = row.metadataRetryAfterAt;
    if (!retryAfterAt) {
      return true;
    }

    const retryAfterTime =
      retryAfterAt instanceof Date
        ? retryAfterAt.getTime()
        : new Date(retryAfterAt).getTime();

    return Number.isFinite(retryAfterTime) && retryAfterTime <= Date.now();
  }
}
