import {
  MetadataHydrationState,
  Prisma,
  RequestStatus,
  SceneLifecycle,
} from '@prisma/client';

// What the indexing jobs share: job names, timings, and their data shapes.

export const INDEXING_JOB_NAMES = {
  BOOTSTRAP: 'scene-index-bootstrap',
  REQUEST_ROWS: 'scene-index-request-rows',
  WHISPARR_QUEUE: 'scene-index-whisparr-queue',
  WHISPARR_MOVIES: 'scene-index-whisparr-movies',
  LIBRARY_PROJECTION: 'scene-index-library-projection',
  STASH_AVAILABILITY: 'scene-index-stash-availability',
  METADATA_BACKFILL: 'scene-index-metadata-backfill',
} as const;

export const KNOWN_INDEXING_JOB_ORDER = [
  INDEXING_JOB_NAMES.BOOTSTRAP,
  INDEXING_JOB_NAMES.REQUEST_ROWS,
  INDEXING_JOB_NAMES.WHISPARR_QUEUE,
  INDEXING_JOB_NAMES.WHISPARR_MOVIES,
  INDEXING_JOB_NAMES.LIBRARY_PROJECTION,
  INDEXING_JOB_NAMES.STASH_AVAILABILITY,
  INDEXING_JOB_NAMES.METADATA_BACKFILL,
] as const;

export const ACQUISITION_LIFECYCLES: SceneLifecycle[] = [
  SceneLifecycle.REQUESTED,
  SceneLifecycle.DOWNLOADING,
  SceneLifecycle.IMPORT_PENDING,
  SceneLifecycle.FAILED,
];

export const SCENE_INDEX_SUMMARY_KEY = 'GLOBAL';

export interface SceneIndexSummarySnapshot {
  indexedScenes: number;
  acquisitionTrackedScenes: number;
  requestedCount: number;
  downloadingCount: number;
  importPendingCount: number;
  failedCount: number;
  metadataPendingCount: number;
  metadataRetryableCount: number;
  lastIndexWriteAt: Date | null;
}

export interface IndexingDiagnosticsSnapshot extends SceneIndexSummarySnapshot {
  metadataHydratedCount: number;
  metadataBacklogCount: number;
  metadataHydrationInFlightCount: number;
}

export interface SceneIndexPatch {
  stashId: string;
  requestStatus?: RequestStatus | null;
  requestUpdatedAt?: Date | null;
  title?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  studioId?: string | null;
  studioName?: string | null;
  studioImageUrl?: string | null;
  /** Comma-separated performer names. */
  performerNames?: string | null;
  releaseDate?: string | null;
  duration?: number | null;
  whisparrMovieId?: number | null;
  whisparrHasFile?: boolean | null;
  whisparrQueuePosition?: number | null;
  whisparrQueueStatus?: string | null;
  whisparrQueueState?: string | null;
  whisparrErrorMessage?: string | null;
  stashAvailable?: boolean | null;
  metadataHydrationState?: MetadataHydrationState;
  metadataLastSyncedAt?: Date | null;
  metadataRetryAfterAt?: Date | null;
  whisparrLastSyncedAt?: Date | null;
  stashLastSyncedAt?: Date | null;
  lastSyncedAt?: Date | null;
}

export type SyncRunDiagnosticValue = number | string | boolean | null;

export interface SyncRunSummary {
  processedCount: number;
  updatedCount: number;
  cursor?: string | null;
  diagnostics?: Record<string, SyncRunDiagnosticValue>;
}

export interface SceneIndexSummaryDelta {
  indexedScenes: number;
  acquisitionTrackedScenes: number;
  requestedCount: number;
  downloadingCount: number;
  importPendingCount: number;
  failedCount: number;
  metadataPendingCount: number;
  metadataRetryableCount: number;
  lastIndexWriteAt: Date | null;
}

export type SceneIndexUpsertData = Prisma.SceneIndexUncheckedCreateInput & {
  stashId: string;
  computedLifecycle: SceneLifecycle;
  lifecycleSortOrder: number;
  metadataHydrationState: MetadataHydrationState;
};

export type MetadataHydrationCandidate = {
  metadataHydrationState: MetadataHydrationState;
  metadataRetryAfterAt?: Date | string | null;
};

/** Timings, batch sizes and leases for the indexing jobs. */
export const INDEXING_LIMITS = {
  INDEX_STATUS_MAX_AGE_MS: 30 * 60_000,
  REQUEST_ROWS_FRESHNESS_MAX_AGE_MS: 2 * 60_000,
  SNAPSHOT_FRESHNESS_MAX_AGE_MS: 20 * 60_000,
  METADATA_REFRESH_MAX_AGE_MS: 7 * 24 * 60 * 60_000,
  APPLY_PATCH_CHUNK_SIZE: 100,
  WHISPARR_LOOKUP_BATCH_SIZE: 8,
  STASH_LOOKUP_BATCH_SIZE: 6,
  STASH_IDENTITY_PAGE_SIZE: 250,
  LIBRARY_SYNC_PAGE_SIZE: 100,
  METADATA_BATCH_SIZE: 24,
  METADATA_QUERY_BATCH_SIZE: 8,
  METADATA_ACCELERATED_INTERVAL_MS: 10_000,
  METADATA_STEADY_INTERVAL_MS: 30 * 60_000,
  METADATA_SCHEDULED_CHECK_CACHE_MS: 60_000,
  METADATA_RETRY_BACKOFF_MS: 5 * 60_000,
  UPSERT_DEADLOCK_RETRY_ATTEMPTS: 3,
  INDEX_WRITE_TRANSACTION_MAX_WAIT_MS: 10_000,
  INDEX_WRITE_TRANSACTION_TIMEOUT_MS: 60_000,
  BOOTSTRAP_LEASE_MS: 20 * 60_000,
  QUEUE_LEASE_MS: 25_000,
  MOVIES_LEASE_MS: 4 * 60_000,
  LIBRARY_LEASE_MS: 20 * 60_000,
  STASH_LEASE_MS: 4 * 60_000,
  METADATA_LEASE_MS: 20 * 60_000,
} as const;

/**
 * Performer names as one comma-separated string, so the acquisition search
 * can match them like a title. Undefined keeps what the index already has.
 */
export function joinPerformerNames(
  names: string[] | undefined,
): string | null | undefined {
  if (names === undefined) {
    return undefined;
  }
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  return unique.length > 0 ? unique.join(', ') : null;
}
