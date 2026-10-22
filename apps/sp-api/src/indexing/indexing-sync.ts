import { MetadataHydrationState, Prisma, SceneIndex } from '@prisma/client';
import { type StashLocalLibrarySceneItem } from '../providers/stash/stash.adapter';
import { StashdbSceneMetadata } from '../providers/stashdb/stashdb.adapter';
import {
  WhisparrAdapterBaseConfig,
  WhisparrMovieLookupResult,
  WhisparrQueueSnapshotItem,
} from '../providers/whisparr/whisparr.adapter';
import {
  STUCK_DOWNLOAD_STATES,
  WhisparrQueueSnapshotItem as ResolverQueueItem,
} from '../scene-status/scene-status.resolver';
import {
  INDEXING_JOB_NAMES,
  INDEXING_LIMITS,
  joinPerformerNames,
  type SceneIndexPatch,
  type SyncRunSummary,
} from './indexing.model';
import { IndexingCore } from './indexing-core';

/**
 * The sync jobs themselves: Whisparr's movies and queue, Stash availability,
 * the library projection, and StashDB metadata.
 */
export abstract class IndexingSync extends IndexingCore {
  protected async refreshWhisparrMoviesForStashIds(
    stashIds: string[],
    reason: string,
  ): Promise<SyncRunSummary> {
    const config = await this.getWhisparrConfig();
    if (!config) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const now = new Date();
    const patches: SceneIndexPatch[] = [];

    for (
      let i = 0;
      i < normalizedIds.length;
      i += INDEXING_LIMITS.WHISPARR_LOOKUP_BATCH_SIZE
    ) {
      const batch = normalizedIds.slice(
        i,
        i + INDEXING_LIMITS.WHISPARR_LOOKUP_BATCH_SIZE,
      );
      const results = await Promise.all(
        batch.map(async (stashId) => {
          try {
            const movie = await this.whisparrAdapter.findMovieByStashId(
              stashId,
              config,
            );
            return {
              stashId,
              movie,
            };
          } catch (error) {
            this.logger.warn(
              `Targeted Whisparr lookup failed. reason=${reason} stashId=${stashId} error=${this.safeJson(
                this.serializeError(error),
              )}`,
            );
            return {
              stashId,
              movie: null,
            };
          }
        }),
      );

      for (const result of results) {
        if (!result.movie) {
          continue;
        }

        patches.push({
          stashId: result.stashId,
          whisparrMovieId: result.movie.movieId,
          whisparrHasFile: result.movie.hasFile,
          whisparrQueuePosition: result.movie.hasFile ? null : undefined,
          whisparrQueueStatus: result.movie.hasFile ? null : undefined,
          whisparrQueueState: result.movie.hasFile ? null : undefined,
          whisparrErrorMessage: result.movie.hasFile ? null : undefined,
          whisparrLastSyncedAt: now,
          lastSyncedAt: now,
        });
      }
    }

    await this.applySceneIndexPatches(patches);
    this.logger.debug(
      `Targeted Whisparr refresh completed: ${this.safeJson({
        reason,
        requestedIds: normalizedIds.length,
        updated: patches.length,
      })}`,
    );

    return {
      processedCount: normalizedIds.length,
      updatedCount: patches.length,
    };
  }

  protected async refreshStashAvailabilityForStashIds(
    stashIds: string[],
    reason: string,
  ): Promise<SyncRunSummary> {
    const [config, activeCatalogProviderKey] = await Promise.all([
      this.getStashConfig(),
      this.getActiveCatalogProviderKey(),
    ]);
    if (!config || !activeCatalogProviderKey) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const now = new Date();
    const patches: SceneIndexPatch[] = [];
    const aliases = new Map(
      (
        await this.prisma.sceneStashAlias.findMany({
          where: { stashId: { in: normalizedIds } },
        })
      ).map((row) => [row.stashId, row.aliasOf]),
    );

    for (
      let i = 0;
      i < normalizedIds.length;
      i += INDEXING_LIMITS.STASH_LOOKUP_BATCH_SIZE
    ) {
      const batch = normalizedIds.slice(
        i,
        i + INDEXING_LIMITS.STASH_LOOKUP_BATCH_SIZE,
      );
      const results = await Promise.all(
        batch.map(async (stashId) => {
          try {
            const lookup = (id: string) =>
              this.stashAdapter.findScenesByStashId(id, config, {
                providerKey: activeCatalogProviderKey,
              });
            let matches = await lookup(stashId);
            // Stash has it under the scene this one is the same as.
            const alias = matches.length === 0 ? aliases.get(stashId) : null;
            if (alias) {
              matches = await lookup(alias);
            }
            return {
              stashId,
              stashAvailable: matches.length > 0,
            };
          } catch (error) {
            this.logger.warn(
              `Targeted Stash availability lookup failed. reason=${reason} stashId=${stashId} error=${this.safeJson(
                this.serializeError(error),
              )}`,
            );
            return null;
          }
        }),
      );

      for (const result of results) {
        if (!result) {
          continue;
        }

        patches.push({
          stashId: result.stashId,
          stashAvailable: result.stashAvailable,
          stashLastSyncedAt: now,
          lastSyncedAt: now,
        });
      }
    }

    await this.applySceneIndexPatches(patches);
    this.logger.debug(
      `Targeted Stash refresh completed: ${this.safeJson({
        reason,
        requestedIds: normalizedIds.length,
        updated: patches.length,
      })}`,
    );

    return {
      processedCount: normalizedIds.length,
      updatedCount: patches.length,
    };
  }

  protected async performWhisparrMovieSync(
    reason: string,
    skipRequestSync: boolean,
  ): Promise<SyncRunSummary> {
    if (!skipRequestSync) {
      await this.syncRequestRows();
    }

    const config = await this.getWhisparrConfig();
    if (!config) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const now = new Date();
    const movies = await this.whisparrAdapter.getMovieSnapshot(config);
    const snapshotMovieIds = new Set<number>();
    const patches: SceneIndexPatch[] = [];

    for (const movie of movies) {
      snapshotMovieIds.add(movie.movieId);
      patches.push({
        stashId: movie.stashId,
        whisparrMovieId: movie.movieId,
        whisparrHasFile: movie.hasFile,
        whisparrLastSyncedAt: now,
        lastSyncedAt: now,
      });
    }

    // Find rows linked to a Whisparr movie that is no longer in Whisparr. Filtering
    // in memory avoids sending the whole Whisparr library as one huge NOT IN list,
    // which can exceed Postgres's parameter limit on large libraries.
    const linkedRows = await this.prisma.sceneIndex.findMany({
      where: {
        whisparrMovieId: {
          not: null,
        },
      },
      select: {
        stashId: true,
        whisparrMovieId: true,
      },
    });
    const staleRows = linkedRows.filter(
      (row) =>
        row.whisparrMovieId === null ||
        !snapshotMovieIds.has(row.whisparrMovieId),
    );

    for (const row of staleRows) {
      patches.push({
        stashId: row.stashId,
        whisparrMovieId: null,
        whisparrHasFile: null,
        whisparrQueuePosition: null,
        whisparrQueueStatus: null,
        whisparrQueueState: null,
        whisparrErrorMessage: null,
        whisparrLastSyncedAt: now,
        lastSyncedAt: now,
      });
    }

    await this.applySceneIndexPatches(patches);
    this.logger.debug(
      `Whisparr movie sync completed: ${this.safeJson({
        reason,
        movies: movies.length,
        staleRows: staleRows.length,
      })}`,
    );

    return {
      processedCount: movies.length + staleRows.length,
      updatedCount: patches.length,
      diagnostics: {
        whisparrMovies: movies.length,
        whisparrMovieIds: snapshotMovieIds.size,
        staleMovieRows: staleRows.length,
        patchCount: patches.length,
      },
    };
  }

  protected async performWhisparrQueueSync(
    reason: string,
    skipRequestSync: boolean,
  ): Promise<SyncRunSummary> {
    if (!skipRequestSync) {
      await this.syncRequestRows();
    }

    const config = await this.getWhisparrConfig();
    if (!config) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const now = new Date();
    const queueItems = await this.whisparrAdapter.getQueueSnapshot(config);
    const groupedByMovieId = this.groupQueueItemsByMovieId(queueItems);
    const movieIds = Array.from(groupedByMovieId.keys());
    const existingRows = movieIds.length
      ? await this.prisma.sceneIndex.findMany({
          where: {
            whisparrMovieId: {
              in: movieIds,
            },
          },
        })
      : [];
    const existingByMovieId = new Map<number, SceneIndex>();

    for (const row of existingRows) {
      if (
        row.whisparrMovieId !== null &&
        !existingByMovieId.has(row.whisparrMovieId)
      ) {
        existingByMovieId.set(row.whisparrMovieId, row);
      }
    }

    const missingMovieIds = movieIds.filter(
      (movieId) => !existingByMovieId.has(movieId),
    );
    const lookedUpMovies = await this.lookupWhisparrMoviesById(
      missingMovieIds,
      config,
    );

    const patches: SceneIndexPatch[] = [];
    const queueItemsByStashId = new Map<string, ResolverQueueItem[]>();
    const seenQueueStashIds = new Set<string>();

    for (const movieId of movieIds) {
      const row = existingByMovieId.get(movieId) ?? null;
      const movie =
        (row
          ? {
              movieId,
              stashId: row.stashId,
              hasFile: row.whisparrHasFile === true,
            }
          : null) ??
        lookedUpMovies.get(movieId) ??
        null;

      if (!movie) {
        this.logger.debug(
          `Skipping Whisparr queue item for movie ${movieId}: no scene id for it.`,
        );
        continue;
      }

      const stashId = movie.stashId;
      const groupedItems = groupedByMovieId.get(movieId) ?? [];
      queueItemsByStashId.set(stashId, groupedItems);
      const queueSummary = this.summarizeQueueItems(groupedItems);
      const queuePosition = seenQueueStashIds.size;

      if (!seenQueueStashIds.has(stashId)) {
        seenQueueStashIds.add(stashId);
      }

      patches.push({
        stashId,
        whisparrMovieId: movie.movieId,
        whisparrHasFile: movie.hasFile,
        whisparrQueuePosition: queuePosition,
        whisparrQueueStatus: queueSummary.status,
        whisparrQueueState: queueSummary.state,
        whisparrErrorMessage: queueSummary.errorMessage,
        whisparrLastSyncedAt: now,
        lastSyncedAt: now,
      });
    }

    const clearedQueueRows = await this.prisma.sceneIndex.findMany({
      where: movieIds.length
        ? {
            OR: [
              {
                whisparrQueueStatus: {
                  not: null,
                },
              },
              {
                whisparrQueuePosition: {
                  not: null,
                },
              },
            ],
            whisparrMovieId: {
              notIn: movieIds,
            },
          }
        : {
            OR: [
              {
                whisparrQueueStatus: {
                  not: null,
                },
              },
              {
                whisparrQueuePosition: {
                  not: null,
                },
              },
            ],
          },
      select: {
        stashId: true,
      },
    });

    for (const row of clearedQueueRows) {
      patches.push({
        stashId: row.stashId,
        whisparrQueuePosition: null,
        whisparrQueueStatus: null,
        whisparrQueueState: null,
        whisparrErrorMessage: null,
        whisparrLastSyncedAt: now,
        lastSyncedAt: now,
      });
    }

    await this.applySceneIndexPatches(patches, queueItemsByStashId);
    this.logger.debug(
      `Whisparr queue sync completed: ${this.safeJson({
        reason,
        queueItems: queueItems.length,
        mappedScenes: queueItemsByStashId.size,
        clearedQueueRows: clearedQueueRows.length,
      })}`,
    );

    return {
      processedCount: queueItems.length + clearedQueueRows.length,
      updatedCount: patches.length,
      diagnostics: {
        queueItems: queueItems.length,
        queueMovieIds: movieIds.length,
        mappedQueueScenes: queueItemsByStashId.size,
        missingQueueMovieLookups: missingMovieIds.length,
        lookedUpQueueMovies: lookedUpMovies.size,
        clearedQueueRows: clearedQueueRows.length,
        patchCount: patches.length,
      },
    };
  }

  protected async performLibraryProjectionSync(
    reason: string,
  ): Promise<SyncRunSummary> {
    const [config, activeCatalogProviderKey] = await Promise.all([
      this.getStashConfig(),
      this.getActiveCatalogProviderKey(),
    ]);
    if (!config) {
      return {
        processedCount: 0,
        updatedCount: 0,
      };
    }

    const syncStartedAt = new Date();
    const availableActiveCatalogSceneIds = new Set<string>();
    let page = 1;
    let pages = 0;
    let localSceneCount = 0;
    let projectionWrites = 0;

    while (true) {
      const snapshotPage = await this.stashAdapter.getLocalLibraryScenePage(
        config,
        {
          page,
          perPage: INDEXING_LIMITS.LIBRARY_SYNC_PAGE_SIZE,
        },
        activeCatalogProviderKey,
      );
      pages += 1;
      localSceneCount += snapshotPage.items.length;
      projectionWrites += await this.upsertLibrarySceneProjectionPage(
        snapshotPage.items,
        syncStartedAt,
      );

      for (const item of snapshotPage.items) {
        // Only scenes with a file count as in the library.
        if (item.activeCatalogSceneId && item.hasFile) {
          availableActiveCatalogSceneIds.add(item.activeCatalogSceneId);
        }
      }

      if (!snapshotPage.hasMore || snapshotPage.items.length === 0) {
        break;
      }

      page += 1;
    }

    const [deletedRows, availabilityWrites] = await Promise.all([
      this.prisma.librarySceneIndex.deleteMany({
        where: {
          lastSyncedAt: {
            lt: syncStartedAt,
          },
        },
      }),
      this.applyLibraryAvailabilitySnapshot(
        availableActiveCatalogSceneIds,
        syncStartedAt,
      ),
    ]);

    this.logger.debug(
      `Library projection sync completed: ${this.safeJson({
        reason,
        activeCatalogProviderKey,
        localSceneCount,
        indexedAvailableIds: availableActiveCatalogSceneIds.size,
        projectionWrites,
        deletedRows: deletedRows.count,
        availabilityWrites,
      })}`,
    );

    return {
      processedCount: localSceneCount,
      updatedCount: projectionWrites + deletedRows.count + availabilityWrites,
      diagnostics: {
        libraryPages: pages,
        localSceneCount,
        indexedAvailableIds: availableActiveCatalogSceneIds.size,
        projectionWrites,
        deletedLibraryRows: deletedRows.count,
        availabilityWrites,
      },
    };
  }

  /**
   * The same lookup as a targeted refresh, so a scene Stash has under the
   * scene it's the same as stays available here too.
   */
  protected async performStashAvailabilitySync(
    reason: string,
    stashIds: string[],
  ): Promise<SyncRunSummary> {
    return this.refreshStashAvailabilityForStashIds(stashIds, reason);
  }

  protected async performMetadataBackfill(
    reason: string,
    forceBootstrapPass: boolean,
  ): Promise<SyncRunSummary> {
    const cursorState = await this.prisma.syncState.findUnique({
      where: {
        jobName: INDEXING_JOB_NAMES.METADATA_BACKFILL,
      },
      select: {
        cursor: true,
      },
    });

    const targetRows = await this.getMetadataBackfillTargets(
      cursorState?.cursor ?? null,
      forceBootstrapPass,
    );
    if (targetRows.length === 0) {
      return {
        processedCount: 0,
        updatedCount: 0,
        cursor: null,
        diagnostics: {
          metadataTargets: 0,
          forceBootstrapPass,
          cursorPresent: cursorState?.cursor ? true : false,
        },
      };
    }

    await this.performMetadataHydration(
      reason,
      targetRows.map((row) => row.stashId),
    );

    return {
      processedCount: targetRows.length,
      updatedCount: targetRows.length,
      cursor: targetRows[targetRows.length - 1]?.stashId ?? null,
      diagnostics: {
        metadataTargets: targetRows.length,
        forceBootstrapPass,
        cursorPresent: cursorState?.cursor ? true : false,
      },
    };
  }

  protected async performMetadataHydration(
    reason: string,
    stashIds: string[],
  ): Promise<void> {
    const config = await this.getActiveCatalogConfig();
    if (!config) {
      return;
    }

    const normalizedIds = this.normalizeStashIds(stashIds);
    if (normalizedIds.length === 0) {
      return;
    }

    const claimedIds = normalizedIds.filter((stashId) => {
      if (this.metadataHydrationInFlight.has(stashId)) {
        return false;
      }

      this.metadataHydrationInFlight.add(stashId);
      return true;
    });
    if (claimedIds.length === 0) {
      return;
    }

    try {
      const patches: SceneIndexPatch[] = [];

      for (
        let i = 0;
        i < claimedIds.length;
        i += INDEXING_LIMITS.METADATA_QUERY_BATCH_SIZE
      ) {
        const batch = claimedIds.slice(
          i,
          i + INDEXING_LIMITS.METADATA_QUERY_BATCH_SIZE,
        );
        const now = new Date();
        let batchMetadata: StashdbSceneMetadata[];
        try {
          batchMetadata = await this.stashdbAdapter.getSceneMetadataByIds(
            batch,
            config,
          );
        } catch (error) {
          this.logger.warn(
            `Metadata hydration batch failed. reason=${reason} stashIds=${this.safeJson(
              batch,
            )} error=${this.safeJson(this.serializeError(error))}`,
          );
          const retryAfterAt = new Date(
            now.getTime() + INDEXING_LIMITS.METADATA_RETRY_BACKOFF_MS,
          );
          for (const stashId of batch) {
            patches.push({
              stashId,
              metadataHydrationState: MetadataHydrationState.FAILED_RETRYABLE,
              metadataRetryAfterAt: retryAfterAt,
            });
          }
          continue;
        }

        for (const scene of batchMetadata) {
          patches.push(this.buildMetadataPatchFromScene(scene, now));
        }

        const hydratedIds = new Set(batchMetadata.map((scene) => scene.id));
        for (const stashId of batch) {
          if (!hydratedIds.has(stashId)) {
            patches.push({
              stashId,
              metadataHydrationState: MetadataHydrationState.HYDRATED,
              metadataLastSyncedAt: now,
              metadataRetryAfterAt: null,
              lastSyncedAt: now,
            });
          }
        }
      }

      await this.applySceneIndexPatches(patches);
    } finally {
      for (const stashId of claimedIds) {
        this.metadataHydrationInFlight.delete(stashId);
      }
    }
  }

  protected async syncRequestRows(stashIds?: string[]): Promise<string[]> {
    const normalizedIds =
      stashIds && stashIds.length > 0 ? this.normalizeStashIds(stashIds) : null;
    const isFullSync = normalizedIds === null;
    const requestRows = await this.prisma.request.findMany({
      where: normalizedIds
        ? {
            stashId: {
              in: normalizedIds,
            },
          }
        : undefined,
      select: {
        stashId: true,
        status: true,
        updatedAt: true,
      },
    });

    const now = new Date();
    if (requestRows.length > 0) {
      await this.applySceneIndexPatches(
        requestRows.map((requestRow) => ({
          stashId: requestRow.stashId,
          requestStatus: requestRow.status,
          requestUpdatedAt: requestRow.updatedAt,
          lastSyncedAt: now,
        })),
      );
    }

    if (isFullSync) {
      await this.syncStateService.recordSuccess(
        INDEXING_JOB_NAMES.REQUEST_ROWS,
        {
          processedCount: requestRows.length,
          updatedCount: requestRows.length,
          runReason: 'request-sync',
        },
      );
    }

    return requestRows.map((requestRow) => requestRow.stashId);
  }

  protected async lookupWhisparrMoviesById(
    movieIds: number[],
    config: WhisparrAdapterBaseConfig,
  ): Promise<Map<number, WhisparrMovieLookupResult>> {
    const foundMovies = new Map<number, WhisparrMovieLookupResult>();

    for (
      let i = 0;
      i < movieIds.length;
      i += INDEXING_LIMITS.WHISPARR_LOOKUP_BATCH_SIZE
    ) {
      const batch = movieIds.slice(
        i,
        i + INDEXING_LIMITS.WHISPARR_LOOKUP_BATCH_SIZE,
      );
      const results = await Promise.all(
        batch.map(async (movieId) => {
          try {
            const movie = await this.whisparrAdapter.findMovieById(
              movieId,
              config,
            );
            return movie;
          } catch (error) {
            this.logger.warn(
              `Failed Whisparr movie-by-id lookup for movieId=${movieId}. error=${this.safeJson(
                this.serializeError(error),
              )}`,
            );
            return null;
          }
        }),
      );

      for (const movie of results) {
        if (!movie) {
          continue;
        }

        foundMovies.set(movie.movieId, movie);
      }
    }

    return foundMovies;
  }

  protected groupQueueItemsByMovieId(
    queueItems: WhisparrQueueSnapshotItem[],
  ): Map<number, ResolverQueueItem[]> {
    const grouped = new Map<number, ResolverQueueItem[]>();

    for (const item of queueItems) {
      const existing = grouped.get(item.movieId) ?? [];
      existing.push(item);
      grouped.set(item.movieId, existing);
    }

    return grouped;
  }

  protected summarizeQueueItems(items: ResolverQueueItem[]): {
    status: string | null;
    state: string | null;
    errorMessage: string | null;
  } {
    if (items.length === 0) {
      return {
        status: null,
        state: null,
        errorMessage: null,
      };
    }

    const ranked = [...items].sort(
      (left, right) => this.rankQueueItem(left) - this.rankQueueItem(right),
    );
    const selected = ranked[0] ?? null;

    if (!selected) {
      return {
        status: null,
        state: null,
        errorMessage: null,
      };
    }

    return {
      status: selected.status,
      state: selected.trackedDownloadState,
      errorMessage: selected.errorMessage,
    };
  }

  protected rankQueueItem(item: ResolverQueueItem): number {
    const normalizedStatus = item.status?.trim().toLowerCase() ?? '';
    const normalizedState =
      item.trackedDownloadState?.trim().toLowerCase() ?? '';

    if (
      normalizedStatus === 'failed' ||
      normalizedStatus === 'warning' ||
      normalizedStatus === 'paused' ||
      STUCK_DOWNLOAD_STATES.has(normalizedState)
    ) {
      return 0;
    }

    if (
      normalizedStatus === 'completed' ||
      normalizedState === 'importpending' ||
      normalizedState === 'importing'
    ) {
      return 1;
    }

    if (normalizedStatus === 'downloading') {
      return 2;
    }

    if (normalizedStatus === 'queued') {
      return 3;
    }

    return 4;
  }

  protected async upsertLibrarySceneProjectionPage(
    items: StashLocalLibrarySceneItem[],
    syncedAt: Date,
  ): Promise<number> {
    if (items.length === 0) {
      return 0;
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        await tx.librarySceneIndex.upsert({
          where: {
            stashSceneId: item.id,
          },
          create: {
            stashSceneId: item.id,
            linkedStashId: item.activeCatalogSceneId,
            linkedCatalogRefs: item.linkedCatalogRefs,
            title: item.title,
            description: item.description,
            imageUrl: item.imageUrl,
            studioId: item.studioId,
            studioName: item.studio,
            studioImageUrl: item.studioImageUrl,
            performerIds: item.performerIds,
            performerNames: item.performerNames,
            tagIds: item.tagIds,
            tagNames: item.tagNames,
            releaseDate: item.releaseDate,
            duration: item.duration,
            viewUrl: item.viewUrl,
            localCreatedAt: item.createdAt,
            localUpdatedAt: item.updatedAt,
            hasFavoritePerformer: item.hasFavoritePerformer,
            favoriteStudio: item.favoriteStudio,
            hasFavoriteTag: item.hasFavoriteTag,
            lastSyncedAt: syncedAt,
          },
          update: {
            linkedStashId: item.activeCatalogSceneId,
            linkedCatalogRefs: item.linkedCatalogRefs,
            title: item.title,
            description: item.description,
            imageUrl: item.imageUrl,
            studioId: item.studioId,
            studioName: item.studio,
            studioImageUrl: item.studioImageUrl,
            performerIds: item.performerIds,
            performerNames: item.performerNames,
            tagIds: item.tagIds,
            tagNames: item.tagNames,
            releaseDate: item.releaseDate,
            duration: item.duration,
            viewUrl: item.viewUrl,
            localCreatedAt: item.createdAt,
            localUpdatedAt: item.updatedAt,
            hasFavoritePerformer: item.hasFavoritePerformer,
            favoriteStudio: item.favoriteStudio,
            hasFavoriteTag: item.hasFavoriteTag,
            lastSyncedAt: syncedAt,
          },
        });
      }
    }, this.indexWriteTransactionOptions());

    return items.length;
  }

  protected async applyLibraryAvailabilitySnapshot(
    linkedStashIds: Set<string>,
    syncedAt: Date,
  ): Promise<number> {
    const availableStashIds = await this.withAliases(linkedStashIds);
    const patches: SceneIndexPatch[] = [];

    for (const stashId of availableStashIds) {
      patches.push({
        stashId,
        stashAvailable: true,
        stashLastSyncedAt: syncedAt,
        lastSyncedAt: syncedAt,
      });
    }

    const previouslyAvailableRows = await this.prisma.sceneIndex.findMany({
      where: {
        stashAvailable: true,
      },
      select: {
        stashId: true,
      },
    });

    for (const row of previouslyAvailableRows) {
      if (availableStashIds.has(row.stashId)) {
        continue;
      }

      patches.push({
        stashId: row.stashId,
        stashAvailable: false,
        stashLastSyncedAt: syncedAt,
        lastSyncedAt: syncedAt,
      });
    }

    await this.applySceneIndexPatches(patches);
    return this.mergePatchesByStashId(patches).length;
  }

  protected async getMetadataBackfillTargets(
    cursor: string | null,
    forceBootstrapPass: boolean,
  ): Promise<Array<{ stashId: string }>> {
    const where = this.buildMetadataBackfillWhere(forceBootstrapPass);

    const directQuery = await this.prisma.sceneIndex.findMany({
      where: cursor
        ? {
            AND: [
              where,
              {
                stashId: {
                  gt: cursor,
                },
              },
            ],
          }
        : where,
      select: {
        stashId: true,
      },
      orderBy: {
        stashId: 'asc',
      },
      take: INDEXING_LIMITS.METADATA_BATCH_SIZE,
    });

    if (directQuery.length > 0 || !cursor) {
      return directQuery;
    }

    return this.prisma.sceneIndex.findMany({
      where,
      select: {
        stashId: true,
      },
      orderBy: {
        stashId: 'asc',
      },
      take: INDEXING_LIMITS.METADATA_BATCH_SIZE,
    });
  }

  protected async shouldRunScheduledMetadataBackfill(): Promise<boolean> {
    const now = Date.now();
    if (
      this.nextMetadataBackfillCheckAt !== null &&
      now < this.nextMetadataBackfillCheckAt
    ) {
      return false;
    }

    const [
      pendingMetadataCount,
      retryableMetadataCount,
      staleMetadataCount,
      syncState,
    ] = await Promise.all([
      this.prisma.sceneIndex.count({
        where: {
          metadataHydrationState: MetadataHydrationState.PENDING,
        },
      }),
      this.prisma.sceneIndex.count({
        where: this.buildMissingMetadataBacklogWhere(),
      }),
      this.prisma.sceneIndex.count({
        where: this.buildStaleHydratedMetadataWhere(),
      }),
      this.prisma.syncState.findUnique({
        where: {
          jobName: INDEXING_JOB_NAMES.METADATA_BACKFILL,
        },
        select: {
          lastSuccessAt: true,
        },
      }),
    ]);

    const targetIntervalMs =
      pendingMetadataCount > 0
        ? INDEXING_LIMITS.METADATA_ACCELERATED_INTERVAL_MS
        : retryableMetadataCount > 0
          ? INDEXING_LIMITS.METADATA_RETRY_BACKOFF_MS
          : staleMetadataCount > 0
            ? INDEXING_LIMITS.METADATA_STEADY_INTERVAL_MS
            : INDEXING_LIMITS.METADATA_STEADY_INTERVAL_MS;
    const lastSuccessAt = syncState?.lastSuccessAt ?? null;

    if (!lastSuccessAt) {
      this.nextMetadataBackfillCheckAt = null;
      return true;
    }

    const nextRunAt = lastSuccessAt.getTime() + targetIntervalMs;
    const shouldRun = now >= nextRunAt;
    this.nextMetadataBackfillCheckAt = shouldRun
      ? null
      : Math.min(
          nextRunAt,
          now + INDEXING_LIMITS.METADATA_SCHEDULED_CHECK_CACHE_MS,
        );

    return shouldRun;
  }

  protected buildMissingMetadataBacklogWhere(): Prisma.SceneIndexWhereInput {
    return {
      metadataHydrationState: MetadataHydrationState.FAILED_RETRYABLE,
    };
  }

  protected buildMetadataBackfillWhere(
    forceBootstrapPass: boolean,
  ): Prisma.SceneIndexWhereInput {
    if (forceBootstrapPass) {
      return {
        metadataHydrationState: {
          in: [
            MetadataHydrationState.PENDING,
            MetadataHydrationState.FAILED_RETRYABLE,
          ],
        },
      };
    }

    return {
      OR: [
        {
          metadataHydrationState: MetadataHydrationState.PENDING,
        },
        this.buildRetryableMetadataWhere(),
        this.buildStaleHydratedMetadataWhere(),
      ],
    };
  }

  protected buildRetryableMetadataWhere(): Prisma.SceneIndexWhereInput {
    return {
      metadataHydrationState: MetadataHydrationState.FAILED_RETRYABLE,
      OR: [
        {
          metadataRetryAfterAt: null,
        },
        {
          metadataRetryAfterAt: {
            lte: new Date(),
          },
        },
      ],
    };
  }

  protected buildStaleHydratedMetadataWhere(): Prisma.SceneIndexWhereInput {
    return {
      metadataHydrationState: MetadataHydrationState.HYDRATED,
      metadataLastSyncedAt: {
        lte: new Date(Date.now() - INDEXING_LIMITS.METADATA_REFRESH_MAX_AGE_MS),
      },
    };
  }

  protected buildMetadataPatchFromScene(
    scene: StashdbSceneMetadata,
    now: Date,
  ): SceneIndexPatch {
    return {
      stashId: scene.id,
      title: scene.title,
      description: scene.details,
      imageUrl: scene.imageUrl,
      studioId: scene.studioId,
      studioName: scene.studioName,
      studioImageUrl: scene.studioImageUrl,
      performerNames: joinPerformerNames(scene.performerNames),
      releaseDate: scene.releaseDate,
      duration: scene.duration,
      metadataHydrationState: MetadataHydrationState.HYDRATED,
      metadataLastSyncedAt: now,
      metadataRetryAfterAt: null,
      lastSyncedAt: now,
    };
  }
}
