import type { ColonReplacement } from '../../organizer/whisparr-naming.util';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { RuntimeHealthServiceKey } from '@prisma/client';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { fetchWithTimeout } from '../fetch-with-timeout';
import {
  describeErrorResponse,
  ProviderResponseError,
  readJsonResponse,
} from '../provider-response';

export interface WhisparrAdapterBaseConfig {
  baseUrl: string;
  apiKey?: string | null;
}

export interface WhisparrMovieLookupResult {
  movieId: number;
  stashId: string;
  hasFile: boolean;
}

export interface WhisparrQueueSnapshotItem {
  movieId: number;
  status: string | null;
  trackedDownloadState: string | null;
  trackedDownloadStatus: string | null;
  errorMessage: string | null;
}

export interface WhisparrRootFolderOption {
  id: number;
  path: string;
  accessible: boolean;
}

export interface WhisparrQualityProfileOption {
  id: number;
  name: string;
}

export interface WhisparrTagOption {
  id: number;
  label: string;
}

export interface WhisparrCreateMovieInput {
  title: string;
  studio: string;
  foreignId: string;
  monitored: boolean;
  rootFolderPath: string;
  addOptions: {
    searchForMovie: boolean;
  };
  qualityProfileId: number;
  tags: number[];
}

export interface WhisparrRelease {
  guid: string;
  indexerId: number;
  indexer: string | null;
  title: string;
  size: number | null;
  quality: string | null;
  resolution: number | null;
  protocol: 'torrent' | 'usenet' | null;
  seeders: number | null;
  leechers: number | null;
  ageHours: number | null;
  customFormatScore: number | null;
  rejected: boolean;
  rejections: string[];
  languages: string[];
  infoUrl: string | null;
  downloadAllowed: boolean;
}

export interface WhisparrMovieSummary {
  id: number;
  title: string;
  stashId: string | null;
  /** The scene's folder in Whisparr. */
  path: string | null;
  rootFolderPath: string | null;
  hasFile: boolean;
  filePath: string | null;
  studio?: string | null;
  /** Release date, YYYY-MM-DD. */
  date?: string | null;
}

/** A scene on Whisparr's calendar: one it has, with a release date in the range asked. */
export interface WhisparrCalendarScene {
  movieId: number;
  stashId: string;
  title: string;
  studio: string | null;
  /** Release date, YYYY-MM-DD. */
  date: string;
  hasFile: boolean;
  monitored: boolean;
  imageUrl: string | null;
}

export interface WhisparrManualImportItem {
  path: string;
  /** Passed back to Whisparr unchanged. */
  quality: unknown;
  languages: unknown[];
  releaseGroup: string | null;
  rejections: string[];
}

export interface WhisparrCreateMovieResult {
  movieId: number | null;
}

/** What happened to a scene in Whisparr, from its history. */
export type WhisparrHistoryEventType =
  | 'grabbed'
  | 'downloadFolderImported'
  | 'downloadFailed'
  | 'downloadIgnored'
  | 'movieFileDeleted'
  | 'movieFileRenamed'
  | 'movieFolderImported'
  | 'unknown';

export interface WhisparrHistoryEvent {
  eventType: WhisparrHistoryEventType;
  /** ISO date. */
  date: string;
  /** The release's name (the imported file's, for some imports). */
  sourceTitle: string | null;
  indexer: string | null;
  downloadClient: string | null;
  /** Why it failed or was ignored, when Whisparr says. */
  message: string | null;
  /** Where an import put the file (as Whisparr sees it). */
  importedPath: string | null;
}

/** One download in Whisparr's queue, with how far along it is. */
export interface WhisparrQueueDetail extends WhisparrQueueSnapshotItem {
  title: string | null;
  indexer: string | null;
  /** Bytes in all, and still to download; null when unknown. */
  size: number | null;
  sizeLeft: number | null;
  /** "hh:mm:ss" (or "d.hh:mm:ss") left, when the download client says. */
  timeLeft: string | null;
  estimatedCompletionTime: string | null;
  added: string | null;
  /** Whisparr's warnings for it, e.g. why an import is blocked. */
  messages: string[];
}

/** Whisparr's numeric history event types (some versions send these). */
const HISTORY_EVENT_TYPES: Record<number, WhisparrHistoryEventType> = {
  1: 'grabbed',
  3: 'downloadFolderImported',
  4: 'downloadFailed',
  6: 'movieFileDeleted',
  7: 'movieFolderImported',
  8: 'movieFileRenamed',
  9: 'downloadIgnored',
};

@Injectable()
export class WhisparrAdapter {
  private static readonly DEFAULT_QUEUE_PAGE_SIZE = 50;
  private static readonly MAX_QUEUE_PAGES = 200;
  private readonly logger = new Logger(WhisparrAdapter.name);
  /** This Whisparr has no /indexerstatus (it answered 404). */
  private indexerStatusMissing = false;

  constructor(private readonly runtimeHealthService: RuntimeHealthService) {}

  async testConnection(config: WhisparrAdapterBaseConfig): Promise<void> {
    await this.checkConnection(config, false);
  }

  async probeConnection(config: WhisparrAdapterBaseConfig): Promise<void> {
    await this.checkConnection(config, true);
  }

  private async checkConnection(
    config: WhisparrAdapterBaseConfig,
    trackRuntimeHealth: boolean,
  ): Promise<void> {
    await this.trackRuntimeHealth(
      () =>
        this.fetchJsonPayload(
          this.resolveSystemStatusEndpoint(config.baseUrl),
          config,
        ),
      trackRuntimeHealth,
    );
  }

  async findMovieByStashId(
    stashId: string,
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrMovieLookupResult | null> {
    const normalizedStashId = stashId.trim();
    if (!normalizedStashId) {
      this.logger.debug(
        'findMovieByStashId called with empty stashId after normalization.',
      );
      return null;
    }

    return this.trackRuntimeHealth(async () => {
      this.logger.debug(
        `Looking up Whisparr movie by stashId: ${this.safeJson({
          stashId: normalizedStashId,
          baseUrl: config.baseUrl,
          hasApiKey: Boolean(config.apiKey?.trim()),
        })}`,
      );

      const payload = await this.fetchArrayPayload(
        this.resolveMovieLookupEndpoint(config.baseUrl, normalizedStashId),
        config,
      );

      this.logger.verbose(
        `Whisparr movie lookup raw payload: ${this.summarizeArrayPayload(payload)}`,
      );

      const matches = payload
        .map((entry) => this.parseMovieLookupEntry(entry))
        .filter(
          (entry): entry is WhisparrMovieLookupResult =>
            entry !== null && entry.stashId === normalizedStashId,
        );

      this.logger.verbose(
        `Whisparr movie lookup normalized matches: ${this.safeJson({
          stashId: normalizedStashId,
          matches,
        })}`,
      );

      if (matches.length === 0) {
        return null;
      }

      if (matches.length > 1) {
        this.logger.warn(
          `Whisparr returned multiple movie matches for stashId="${normalizedStashId}"; refusing ambiguous result.`,
        );
        throw new BadGatewayException(
          'Whisparr provider returned multiple movie matches for a stashId lookup.',
        );
      }

      return matches[0];
    });
  }

  async findMovieById(
    movieId: number,
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrMovieLookupResult | null> {
    if (!Number.isInteger(movieId) || movieId <= 0) {
      this.logger.debug(
        `findMovieById called with invalid movieId: ${this.safeJson({
          movieId,
        })}`,
      );
      return null;
    }

    return this.trackRuntimeHealth(async () => {
      this.logger.debug(
        `Looking up Whisparr movie by movieId: ${this.safeJson({
          movieId,
          baseUrl: config.baseUrl,
          hasApiKey: Boolean(config.apiKey?.trim()),
        })}`,
      );

      const payload = await this.fetchJsonPayload(
        this.resolveMovieByIdEndpoint(config.baseUrl, movieId),
        config,
      );

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        this.logger.error(
          `Whisparr movie-by-id payload has unexpected shape: ${this.safeJson({
            movieId,
            payloadShape: this.describePayloadShape(payload),
            payloadPreview: this.previewPayload(payload),
          })}`,
        );
        throw new BadGatewayException(
          'Whisparr provider returned an unexpected movie-by-id response shape.',
        );
      }

      this.logger.verbose(
        `Whisparr movie-by-id raw payload: ${this.safeJson(payload)}`,
      );

      const movie = this.parseMovieLookupEntry(payload);
      if (!movie) {
        this.logger.warn(
          `Whisparr movie-by-id payload could not be normalized: ${this.safeJson(
            {
              movieId,
              payloadPreview: this.previewPayload(payload),
            },
          )}`,
        );
        return null;
      }

      if (movie.movieId !== movieId) {
        this.logger.warn(
          `Whisparr movie-by-id response mismatch: ${this.safeJson({
            requestedMovieId: movieId,
            responseMovieId: movie.movieId,
          })}`,
        );
        return null;
      }

      this.logger.debug(
        `Whisparr movie-by-id normalized result: ${this.safeJson(movie)}`,
      );

      return movie;
    });
  }

  async getQueueSnapshot(
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrQueueSnapshotItem[]> {
    return this.trackRuntimeHealth(async () => {
      this.logger.debug(
        `Fetching Whisparr queue snapshot: ${this.safeJson({
          baseUrl: config.baseUrl,
          hasApiKey: Boolean(config.apiKey?.trim()),
        })}`,
      );

      const queueRecords = await this.fetchAllQueueRecords(config);

      const normalized = queueRecords
        .map((entry) => this.parseQueueEntry(entry))
        .filter((entry): entry is WhisparrQueueSnapshotItem => entry !== null);

      this.logger.verbose(
        `Whisparr queue normalized snapshot: ${this.safeJson({
          count: normalized.length,
          sample: normalized.slice(0, 5),
        })}`,
      );

      return normalized;
    });
  }

  async getMovieSnapshot(
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrMovieLookupResult[]> {
    return this.trackRuntimeHealth(async () => {
      this.logger.debug(
        `Fetching Whisparr movie snapshot: ${this.safeJson({
          baseUrl: config.baseUrl,
          hasApiKey: Boolean(config.apiKey?.trim()),
        })}`,
      );

      // The whole library in one reply: as slow as listMovies.
      const payload = await this.fetchJsonPayload(
        this.resolveMovieCollectionEndpoint(config.baseUrl),
        config,
        { timeoutMs: 180_000 },
      );
      const records = this.extractCollectionRecords(payload, 'movie');
      const normalized = records
        .map((entry) => this.parseMovieLookupEntry(entry))
        .filter((entry): entry is WhisparrMovieLookupResult => entry !== null);

      this.logger.verbose(
        `Whisparr movie normalized snapshot: ${this.safeJson({
          count: normalized.length,
          sample: normalized.slice(0, 5),
        })}`,
      );

      return normalized;
    });
  }

  async getRootFolders(
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrRootFolderOption[]> {
    return this.trackRuntimeHealth(async () => {
      const payload = await this.fetchArrayPayload(
        this.resolveRootFoldersEndpoint(config.baseUrl),
        config,
      );

      return payload
        .map((entry) => this.parseRootFolderEntry(entry))
        .filter((entry): entry is WhisparrRootFolderOption => entry !== null);
    });
  }

  async getQualityProfiles(
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrQualityProfileOption[]> {
    return this.trackRuntimeHealth(async () => {
      const payload = await this.fetchArrayPayload(
        this.resolveQualityProfilesEndpoint(config.baseUrl),
        config,
      );

      return payload
        .map((entry) => this.parseQualityProfileEntry(entry))
        .filter(
          (entry): entry is WhisparrQualityProfileOption => entry !== null,
        );
    });
  }

  async getTags(
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrTagOption[]> {
    return this.trackRuntimeHealth(async () => {
      const payload = await this.fetchArrayPayload(
        this.resolveTagsEndpoint(config.baseUrl),
        config,
      );

      return payload
        .map((entry) => this.parseTagEntry(entry))
        .filter((entry): entry is WhisparrTagOption => entry !== null);
    });
  }

  async createMovie(
    input: WhisparrCreateMovieInput,
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrCreateMovieResult> {
    return this.trackRuntimeHealth(async () => {
      const payload = await this.fetchJsonPayload(
        this.resolveMovieCollectionEndpoint(config.baseUrl),
        config,
        {
          method: 'POST',
          body: input,
        },
      );

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        this.logger.error(
          `Whisparr create movie payload has unexpected shape: ${this.safeJson({
            payloadShape: this.describePayloadShape(payload),
            payloadPreview: this.previewPayload(payload),
          })}`,
        );
        throw new BadGatewayException(
          'Whisparr provider returned an unexpected create-movie response shape.',
        );
      }

      const movieId = this.readNumber((payload as Record<string, unknown>).id);
      return { movieId };
    });
  }

  /**
   * What happened to one scene in Whisparr (grabs, imports, failures),
   * newest first.
   */
  async getMovieHistory(
    config: WhisparrAdapterBaseConfig,
    movieId: number,
  ): Promise<WhisparrHistoryEvent[]> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/history/movie`;
      parsed.search = '';
      parsed.searchParams.set('movieId', String(movieId));
      const payload = await this.fetchJsonPayload(parsed.toString(), config);
      return this.extractCollectionRecords(payload, 'history')
        .flatMap((entry) => {
          const event = this.parseHistoryEntry(entry);
          return event ? [event] : [];
        })
        .sort((left, right) => right.date.localeCompare(left.date));
    });
  }

  /**
   * Whisparr's queue with how far along each download is, for one scene or
   * (no movieId) all of them, in one reply.
   */
  async getQueueDetails(
    config: WhisparrAdapterBaseConfig,
    movieId?: number,
  ): Promise<WhisparrQueueDetail[]> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/queue/details`;
      parsed.search = '';
      if (movieId !== undefined) {
        parsed.searchParams.set('movieId', String(movieId));
      }
      const payload = await this.fetchJsonPayload(parsed.toString(), config);
      return this.extractCollectionRecords(payload, 'queue').flatMap(
        (entry) => {
          const item = this.parseQueueDetail(entry);
          return item && (movieId === undefined || item.movieId === movieId)
            ? [item]
            : [];
        },
      );
    });
  }

  /**
   * Searches every indexer for this scene, like Whisparr's "Interactive
   * search". Indexers can be slow, so this waits up to two minutes.
   */
  async searchReleases(
    config: WhisparrAdapterBaseConfig,
    movieId: number,
  ): Promise<WhisparrRelease[]> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/release`;
      parsed.search = '';
      parsed.searchParams.set('movieId', String(movieId));
      const payload = await this.fetchJsonPayload(parsed.toString(), config, {
        timeoutMs: 120_000,
      });
      if (!Array.isArray(payload)) {
        throw new BadGatewayException(
          'Whisparr returned an unexpected release search response.',
        );
      }
      const releases = payload
        .map((entry) => this.parseReleaseEntry(entry))
        .filter((entry): entry is WhisparrRelease => entry !== null);
      if (releases.length < payload.length) {
        this.logger.warn(
          `Whisparr release search: skipped ${payload.length - releases.length} of ${payload.length} results without a guid, indexer or title.`,
        );
      }
      return releases;
    });
  }

  /**
   * Why a search could come back empty: indexers Whisparr has paused after
   * errors (and until when), and how many can do an interactive search.
   */
  async getIndexerHealth(config: WhisparrAdapterBaseConfig): Promise<{
    searchable: number;
    paused: Array<{ name: string; until: string }>;
  }> {
    const url = (path: string) => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/${path}`;
      parsed.search = '';
      return parsed.toString();
    };
    const [indexers, statuses] = await Promise.all([
      this.fetchJsonPayload(url('indexer'), config),
      this.indexerStatusMissing
        ? Promise.resolve([])
        : this.fetchQuietly(url('indexerstatus'), config),
    ]);
    const rows = (Array.isArray(indexers) ? indexers : []) as Array<
      Record<string, unknown>
    >;
    const names = new Map(
      rows.map((row) => [
        this.readNumber(row.id),
        this.readString(row.name) ?? 'An indexer',
      ]),
    );
    const now = Date.now();
    const paused = (Array.isArray(statuses) ? statuses : []).flatMap(
      (status: Record<string, unknown>) => {
        const until = this.readString(status.disabledTill);
        if (!until || Date.parse(until) <= now) {
          return [];
        }
        const name =
          names.get(this.readNumber(status.indexerId)) ?? 'An indexer';
        return [{ name, until }];
      },
    );
    const searchable = rows.filter(
      (row) => row.enable !== false && row.enableInteractiveSearch !== false,
    ).length;
    return { searchable, paused };
  }

  /**
   * Some Whisparr versions have no indexer status endpoint. Ask it without
   * logging an error, and after a 404 stop asking.
   */
  private async fetchQuietly(
    endpoint: string,
    config: WhisparrAdapterBaseConfig,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.apiKey?.trim()) {
      headers['X-Api-Key'] = config.apiKey.trim();
    }
    const response = await fetchWithTimeout(endpoint, { headers }).catch(
      () => null,
    );
    if (!response?.ok) {
      if (response?.status === 404) {
        this.indexerStatusMissing = true;
      }
      return [];
    }
    return readJsonResponse(response, 'Whisparr').catch(() => []);
  }

  /**
   * Whisparr's Media Management naming: its Scene Folder Format and Standard
   * Scene Format, as written there. Null for any it doesn't report.
   */
  async getNamingConfig(config: WhisparrAdapterBaseConfig): Promise<{
    folderFormat: string | null;
    fileFormat: string | null;
    replaceIllegalCharacters: boolean;
    colonReplacement: ColonReplacement;
  }> {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/config/naming`;
    parsed.search = '';
    const payload = await this.fetchJsonPayload(parsed.toString(), config);
    const naming = (
      payload && typeof payload === 'object' ? payload : {}
    ) as Record<string, unknown>;
    const pick = (key: string) => this.readString(naming[key])?.trim() || null;
    const colonNames: ColonReplacement[] = [
      'delete',
      'dash',
      'spaceDash',
      'spaceDashSpace',
      'smart',
    ];
    const colon = naming.colonReplacementFormat;
    return {
      folderFormat: pick('sceneFolderFormat'),
      fileFormat: pick('standardSceneFormat'),
      replaceIllegalCharacters: naming.replaceIllegalCharacters !== false,
      // Sent as a name ("smart") or as its number (4).
      colonReplacement:
        typeof colon === 'number'
          ? (colonNames[colon] ?? 'smart')
          : (colonNames.find(
              (name) => name.toLowerCase() === String(colon).toLowerCase(),
            ) ?? 'smart'),
    };
  }

  /**
   * How Whisparr imports finished downloads: whether it hardlinks instead of
   * copying (Media Management), and how many of its download clients are
   * torrent clients (their downloads are copied or hardlinked, never moved,
   * so the original stays behind). Null for anything it doesn't report.
   */
  async getImportSettings(config: WhisparrAdapterBaseConfig): Promise<{
    copyUsingHardlinks: boolean | null;
    torrentClients: number | null;
  }> {
    const url = (path: string) => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/${path}`;
      parsed.search = '';
      return parsed.toString();
    };
    const [media, clients] = await Promise.all([
      this.fetchJsonPayload(url('config/mediamanagement'), config).catch(
        () => null,
      ),
      this.fetchJsonPayload(url('downloadclient'), config).catch(() => null),
    ]);
    const hardlinks =
      media && typeof media === 'object'
        ? (media as Record<string, unknown>).copyUsingHardlinks
        : undefined;
    return {
      copyUsingHardlinks: typeof hardlinks === 'boolean' ? hardlinks : null,
      torrentClients: Array.isArray(clients)
        ? clients.filter(
            (client: unknown) =>
              !!client &&
              typeof client === 'object' &&
              (client as Record<string, unknown>).enable !== false &&
              (client as Record<string, unknown>).protocol === 'torrent',
          ).length
        : null,
    };
  }

  /** Sends one release from the last search to the download client. */
  async grabRelease(
    config: WhisparrAdapterBaseConfig,
    release: { guid: string; indexerId: number },
    /** The scene it's for. Whisparr needs it when the release's name doesn't say. */
    movieId?: number,
  ): Promise<void> {
    await this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/release`;
      parsed.search = '';
      await this.fetchJsonPayload(parsed.toString(), config, {
        method: 'POST',
        body: {
          guid: release.guid,
          indexerId: release.indexerId,
          ...(movieId ? { movieId } : {}),
        },
        timeoutMs: 60_000,
      });
    });
  }

  /**
   * What Whisparr's Manual Import sees for a file or folder, already tied to
   * this scene. Whisparr must be able to reach the path itself.
   */
  async getManualImportItems(
    config: WhisparrAdapterBaseConfig,
    path: string,
    movieId: number,
    timeoutMs = 120_000,
  ): Promise<WhisparrManualImportItem[]> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/manualimport`;
      parsed.search = '';
      parsed.searchParams.set('folder', path);
      if (movieId > 0) {
        parsed.searchParams.set('movieId', String(movieId));
      }
      parsed.searchParams.set('filterExistingFiles', 'false');
      const payload = await this.fetchJsonPayload(parsed.toString(), config, {
        timeoutMs,
      });
      if (!Array.isArray(payload)) {
        return [];
      }
      return payload.flatMap((entry) => {
        const row = entry as Record<string, unknown> | null;
        const itemPath = this.readString(row?.path);
        if (!row || !itemPath) {
          return [];
        }
        const rejections = Array.isArray(row.rejections)
          ? row.rejections.flatMap((reason) => {
              const text = this.readString(
                (reason as { reason?: unknown } | null)?.reason,
              );
              return text ? [text] : [];
            })
          : [];
        return [
          {
            path: itemPath,
            quality: row.quality ?? null,
            languages: Array.isArray(row.languages) ? row.languages : [],
            releaseGroup: this.readString(row.releaseGroup),
            rejections,
          },
        ];
      });
    });
  }

  /**
   * Whether Whisparr can see a path, using the same file browser its folder
   * picker uses. Null when this Whisparr doesn't have that endpoint.
   */
  async pathType(
    config: WhisparrAdapterBaseConfig,
    path: string,
  ): Promise<'file' | 'folder' | 'missing' | null> {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/filesystem/type`;
    parsed.search = '';
    parsed.searchParams.set('path', path);
    try {
      const payload = (await this.fetchJsonPayload(parsed.toString(), config, {
        timeoutMs: 15_000,
      })) as Record<string, unknown> | null;
      const type = this.readString(payload?.type)?.toLowerCase();
      return type === 'file'
        ? 'file'
        : type === 'folder'
          ? 'folder'
          : 'missing';
    } catch (error) {
      return /\b404\b/.test(this.errorMessage(error)) ? null : 'missing';
    }
  }

  /** Whisparr's qualities (WEBDL-1080p…), as Manual Import expects them. */
  async getQualityDefinitions(config: WhisparrAdapterBaseConfig): Promise<
    Array<{
      id: number;
      name: string;
      source: string | null;
      resolution: number | null;
      raw: unknown;
    }>
  > {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/qualitydefinition`;
    parsed.search = '';
    const payload = await this.fetchJsonPayload(parsed.toString(), config);
    return (Array.isArray(payload) ? payload : []).flatMap((entry) => {
      const quality = (entry as { quality?: Record<string, unknown> } | null)
        ?.quality;
      const id = this.readNumber(quality?.id);
      if (!quality || id === null) {
        return [];
      }
      return [
        {
          id,
          name: this.readString(quality.name) ?? String(id),
          source: this.readString(quality.source)?.toLowerCase() ?? null,
          resolution: this.readNumber(quality.resolution),
          raw: quality,
        },
      ];
    });
  }

  /** Every scene Whisparr tracks, with where its folder is. */
  async listMovies(
    config: WhisparrAdapterBaseConfig,
  ): Promise<WhisparrMovieSummary[]> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/movie`;
      parsed.search = '';
      const payload = await this.fetchJsonPayload(parsed.toString(), config, {
        timeoutMs: 180_000,
      });
      return (Array.isArray(payload) ? payload : []).flatMap((entry) => {
        const row = entry as Record<string, unknown> | null;
        const id = this.readNumber(row?.id);
        if (!row || id === null) {
          return [];
        }
        const movieFile = row.movieFile as
          Record<string, unknown> | null | undefined;
        return [
          {
            id,
            title: this.readString(row.title) ?? `Scene ${id}`,
            stashId:
              this.readString(row.stashId) ?? this.readString(row.foreignId),
            path: this.readString(row.path),
            rootFolderPath: this.readString(row.rootFolderPath),
            hasFile: row.hasFile === true,
            filePath: this.readString(movieFile?.path),
            studio:
              this.readString(row.studioTitle) ?? this.readString(row.studio),
            date:
              (
                this.readString(row.releaseDate) ??
                this.readString(row.digitalRelease) ??
                ''
              ).slice(0, 10) || null,
          },
        ];
      });
    });
  }

  /**
   * Whisparr's calendar: the monitored scenes it has with a release date from
   * `start` to `end` (YYYY-MM-DD), whether or not they're downloaded yet.
   */
  async getCalendar(
    config: WhisparrAdapterBaseConfig,
    start: string,
    end: string,
  ): Promise<WhisparrCalendarScene[]> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/calendar`;
      parsed.search = new URLSearchParams({
        start: `${start}T00:00:00Z`,
        end: `${end}T23:59:59Z`,
      }).toString();
      const payload = await this.fetchJsonPayload(parsed.toString(), config, {
        timeoutMs: 30_000,
      });
      return (Array.isArray(payload) ? payload : []).flatMap((entry) => {
        const row = entry as Record<string, unknown> | null;
        const movieId = this.readNumber(row?.id);
        const stashId =
          this.readString(row?.stashId) ?? this.readString(row?.foreignId);
        const date = (
          this.readString(row?.releaseDate) ??
          this.readString(row?.digitalRelease) ??
          ''
        ).slice(0, 10);
        if (!row || movieId === null || !stashId || !date) {
          return [];
        }
        return [
          {
            movieId,
            stashId,
            title: this.readString(row.title) ?? `Scene ${movieId}`,
            studio:
              this.readString(row.studioTitle) ?? this.readString(row.studio),
            date,
            hasFile: row.hasFile === true,
            monitored: row.monitored !== false,
            imageUrl: calendarImage(row.images),
          },
        ];
      });
    });
  }

  /** Adds a root folder to Whisparr (it must exist and be reachable from Whisparr). */
  async addRootFolder(
    config: WhisparrAdapterBaseConfig,
    path: string,
  ): Promise<void> {
    await this.trackRuntimeHealth(async () => {
      await this.fetchJsonPayload(
        this.resolveRootFoldersEndpoint(config.baseUrl),
        config,
        {
          method: 'POST',
          body: { path },
        },
      );
    });
  }

  /**
   * Whisparr's "Edit movies → Root folder → move files": Whisparr moves the
   * scenes' folders into the new root folder itself and keeps tracking them.
   */
  async moveMoviesToRootFolder(
    config: WhisparrAdapterBaseConfig,
    movieIds: number[],
    rootFolderPath: string,
    moveFiles = true,
  ): Promise<void> {
    await this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/movie/editor`;
      parsed.search = '';
      await this.fetchJsonPayload(parsed.toString(), config, {
        method: 'PUT',
        body: { movieIds, rootFolderPath, moveFiles },
        timeoutMs: 120_000,
      });
    });
  }

  /**
   * Sets one scene's exact folder in Whisparr. With moveFiles, Whisparr moves
   * the folder's contents there itself (like editing the path in Whisparr and
   * choosing "move files"); without, it only records the new path.
   */
  async setMoviePath(
    config: WhisparrAdapterBaseConfig,
    movieId: number,
    path: string,
    rootFolderPath: string,
    moveFiles: boolean,
  ): Promise<void> {
    await this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/movie/${movieId}`;
      parsed.search = '';
      const movie = (await this.fetchJsonPayload(
        parsed.toString(),
        config,
      )) as Record<string, unknown> | null;
      if (!movie || typeof movie !== 'object') {
        throw new BadGatewayException(`Whisparr has no scene ${movieId}.`);
      }
      parsed.searchParams.set('moveFiles', moveFiles ? 'true' : 'false');
      await this.fetchJsonPayload(parsed.toString(), config, {
        method: 'PUT',
        body: { ...movie, path, rootFolderPath },
        timeoutMs: 60_000,
      });
    });
  }

  /** Has Whisparr look at these scenes' folders again for their files. */
  async refreshMovies(
    config: WhisparrAdapterBaseConfig,
    movieIds: number[],
  ): Promise<void> {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/command`;
    parsed.search = '';
    await this.fetchJsonPayload(parsed.toString(), config, {
      method: 'POST',
      body: { name: 'RefreshMovie', movieIds },
    });
  }

  /** Has Whisparr search its indexers for these scenes again. */
  async searchMovies(
    config: WhisparrAdapterBaseConfig,
    movieIds: number[],
  ): Promise<void> {
    if (movieIds.length === 0) {
      return;
    }
    await this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/command`;
      parsed.search = '';
      await this.fetchJsonPayload(parsed.toString(), config, {
        method: 'POST',
        body: { name: 'MoviesSearch', movieIds },
      });
    });
  }

  /**
   * Removes a scene from Whisparr so it stops looking for it. Files on disk
   * stay where they are.
   */
  async deleteMovie(
    config: WhisparrAdapterBaseConfig,
    movieId: number,
  ): Promise<void> {
    await this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/movie/${movieId}`;
      parsed.search = '';
      parsed.searchParams.set('deleteFiles', 'false');
      parsed.searchParams.set('addImportExclusion', 'false');
      await this.fetchJsonPayload(parsed.toString(), config, {
        method: 'DELETE',
      });
    });
  }

  /** Whisparr's queued and running commands (moves, imports…). */
  async listCommands(
    config: WhisparrAdapterBaseConfig,
  ): Promise<Array<{ id: number; name: string; status: string }>> {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/command`;
    parsed.search = '';
    const payload = await this.fetchJsonPayload(parsed.toString(), config);
    return (Array.isArray(payload) ? payload : []).flatMap((entry) => {
      const row = entry as Record<string, unknown> | null;
      const id = this.readNumber(row?.id);
      return row && id !== null
        ? [
            {
              id,
              name: this.readString(row.name) ?? '',
              status: this.readString(row.status)?.toLowerCase() ?? '',
            },
          ]
        : [];
    });
  }

  /** Imports files into scenes (Whisparr's Manual Import). Returns the command id. */
  async startManualImport(
    config: WhisparrAdapterBaseConfig,
    files: Array<{ item: WhisparrManualImportItem; movieId: number }>,
    importMode: 'move' | 'copy',
  ): Promise<number | null> {
    return this.trackRuntimeHealth(async () => {
      const parsed = new URL(config.baseUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/command`;
      parsed.search = '';
      const payload = await this.fetchJsonPayload(parsed.toString(), config, {
        method: 'POST',
        body: {
          name: 'ManualImport',
          importMode,
          files: files.map(({ item, movieId }) => ({
            path: item.path,
            movieId,
            quality: item.quality,
            languages: item.languages,
            releaseGroup: item.releaseGroup ?? undefined,
            indexerFlags: 0,
          })),
        },
      });
      return this.readNumber((payload as Record<string, unknown> | null)?.id);
    });
  }

  /** A Whisparr command's state: queued, started, completed, failed… */
  async getCommandStatus(
    config: WhisparrAdapterBaseConfig,
    commandId: number,
  ): Promise<{ status: string; message: string | null }> {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/command/${commandId}`;
    parsed.search = '';
    const payload = (await this.fetchJsonPayload(
      parsed.toString(),
      config,
    )) as Record<string, unknown> | null;
    return {
      status: this.readString(payload?.status)?.toLowerCase() ?? 'unknown',
      message: this.readString(payload?.message),
    };
  }

  private parseReleaseEntry(entry: unknown): WhisparrRelease | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const row = entry as Record<string, unknown>;
    const guid = this.readString(row.guid);
    const indexerId = this.readNumber(row.indexerId);
    const title = this.readString(row.title);
    if (!guid || indexerId === null || !title) {
      return null;
    }
    const quality = (
      row.quality as
        { quality?: { name?: unknown; resolution?: unknown } } | undefined
    )?.quality;
    const rejections = Array.isArray(row.rejections)
      ? row.rejections.flatMap((reason) => {
          if (typeof reason === 'string') {
            return reason.trim() ? [reason.trim()] : [];
          }
          const text = this.readString(
            (reason as { reason?: unknown } | null)?.reason,
          );
          return text ? [text] : [];
        })
      : [];
    const languages = Array.isArray(row.languages)
      ? row.languages.flatMap((language) => {
          const name = this.readString(
            (language as { name?: unknown } | null)?.name,
          );
          return name ? [name] : [];
        })
      : [];
    const protocol = this.readString(row.protocol)?.toLowerCase() ?? null;
    return {
      guid,
      indexerId,
      indexer: this.readString(row.indexer),
      title,
      size: this.readNumber(row.size),
      quality: this.readString(quality?.name),
      resolution: this.readNumber(quality?.resolution),
      protocol:
        protocol === 'torrent' || protocol === 'usenet' ? protocol : null,
      seeders: this.readNumber(row.seeders),
      leechers: this.readNumber(row.leechers),
      ageHours: this.readNumber(row.ageHours),
      customFormatScore: this.readNumber(row.customFormatScore),
      rejected: row.rejected === true || rejections.length > 0,
      rejections,
      languages,
      infoUrl: this.readString(row.infoUrl),
      downloadAllowed: row.downloadAllowed !== false,
    };
  }

  private async trackRuntimeHealth<T>(
    operation: () => Promise<T>,
    trackRuntimeHealth = true,
  ): Promise<T> {
    try {
      const result = await operation();
      if (trackRuntimeHealth) {
        await this.reportRuntimeSuccess();
      }
      return result;
    } catch (error) {
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(error);
      }
      throw error;
    }
  }

  private async reportRuntimeSuccess(): Promise<void> {
    try {
      await this.runtimeHealthService.recordSuccess(
        RuntimeHealthServiceKey.WHISPARR,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record Whisparr runtime recovery: ${this.errorMessage(error)}`,
      );
    }
  }

  private async reportRuntimeFailure(error: unknown): Promise<void> {
    try {
      await this.runtimeHealthService.recordFailure(
        RuntimeHealthServiceKey.WHISPARR,
        error,
      );
    } catch (reportingError) {
      this.logger.warn(
        `Failed to record Whisparr runtime failure: ${this.errorMessage(reportingError)}`,
      );
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return 'unknown error';
  }

  private async fetchAllQueueRecords(
    config: WhisparrAdapterBaseConfig,
  ): Promise<unknown[]> {
    const allRecords: unknown[] = [];
    let page = 1;
    let totalRecords: number | null = null;

    while (page <= WhisparrAdapter.MAX_QUEUE_PAGES) {
      const payload = await this.fetchJsonPayload(
        this.resolveQueueEndpoint(
          config.baseUrl,
          page,
          WhisparrAdapter.DEFAULT_QUEUE_PAGE_SIZE,
        ),
        config,
      );

      const queuePage = this.extractQueuePage(payload);
      allRecords.push(...queuePage.records);
      totalRecords = queuePage.totalRecords;

      this.logger.verbose(
        `Whisparr queue page loaded: ${this.safeJson({
          page,
          pageSize: WhisparrAdapter.DEFAULT_QUEUE_PAGE_SIZE,
          fetchedRecords: queuePage.records.length,
          accumulatedRecords: allRecords.length,
          totalRecords,
          sample: queuePage.records.slice(0, 2),
        })}`,
      );

      if (queuePage.records.length === 0) {
        break;
      }

      if (totalRecords !== null && allRecords.length >= totalRecords) {
        break;
      }

      if (
        totalRecords === null &&
        queuePage.records.length < WhisparrAdapter.DEFAULT_QUEUE_PAGE_SIZE
      ) {
        break;
      }

      page += 1;
    }

    if (page > WhisparrAdapter.MAX_QUEUE_PAGES) {
      this.logger.warn(
        `Reached max queue page limit while fetching Whisparr queue: ${this.safeJson(
          {
            maxPages: WhisparrAdapter.MAX_QUEUE_PAGES,
            accumulatedRecords: allRecords.length,
            totalRecords,
          },
        )}`,
      );
    }

    this.logger.verbose(
      `Whisparr queue raw payload: ${this.summarizeArrayPayload(allRecords)}`,
    );

    return allRecords;
  }

  buildSceneViewUrl(baseUrl: string, movieId: number): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/movie/${encodeURIComponent(String(movieId))}`;
    parsed.search = '';
    return parsed.toString();
  }

  private async fetchArrayPayload(
    endpoint: string,
    config: WhisparrAdapterBaseConfig,
  ): Promise<unknown[]> {
    const payload = await this.fetchJsonPayload(endpoint, config);

    if (!Array.isArray(payload)) {
      this.logger.error(
        `Whisparr unexpected non-array payload: ${this.safeJson({
          endpoint,
          payloadShape: this.describePayloadShape(payload),
          payloadPreview: this.previewPayload(payload),
        })}`,
      );
      throw new BadGatewayException(
        'Whisparr provider returned an unexpected response shape.',
      );
    }

    return payload as unknown[];
  }

  private async fetchJsonPayload(
    endpoint: string,
    config: WhisparrAdapterBaseConfig,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      timeoutMs?: number;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const method = options?.method ?? 'GET';
    const body = options?.body;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (config.apiKey?.trim()) {
      headers['X-Api-Key'] = config.apiKey.trim();
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        options?.timeoutMs,
      );
    } catch (error) {
      this.logger.warn(
        `Couldn't reach Whisparr (${method} ${endpointPath(endpoint)}): ${this.errorMessage(error)}`,
      );
      throw new BadGatewayException(
        'Failed to reach Whisparr provider endpoint.',
      );
    }

    if (!response.ok) {
      const message = await describeErrorResponse(
        response,
        'Whisparr provider',
      );
      this.logger.warn(
        `Whisparr answered ${response.status} to ${method} ${endpointPath(endpoint)}: ${message}`,
      );
      throw new BadGatewayException(message);
    }

    let payload: unknown;
    try {
      // Some Whisparr actions (moves, edits) answer with an empty body.
      payload = await readJsonResponse(response, 'Whisparr');
    } catch (error) {
      this.logger.warn(
        `Whisparr's answer to ${method} ${endpointPath(endpoint)} couldn't be read: ${this.errorMessage(error)}`,
      );
      throw new BadGatewayException(
        error instanceof ProviderResponseError
          ? error.message
          : 'Whisparr provider returned an invalid JSON response.',
      );
    }

    this.logger.verbose(
      `Whisparr JSON payload received: ${this.safeJson({
        endpoint,
        payloadType: Array.isArray(payload) ? 'array' : typeof payload,
        payloadShape: this.describePayloadShape(payload),
      })}`,
    );

    return payload;
  }

  private parseMovieLookupEntry(
    entry: unknown,
  ): WhisparrMovieLookupResult | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const movieId = this.readNumber((entry as Record<string, unknown>).id);
    const stashId = this.readString((entry as Record<string, unknown>).stashId);

    if (movieId === null || !stashId) {
      return null;
    }

    return {
      movieId,
      stashId,
      hasFile: (entry as Record<string, unknown>).hasFile === true,
    };
  }

  private parseHistoryEntry(entry: unknown): WhisparrHistoryEvent | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const row = entry as Record<string, unknown>;
    const date = this.readString(row.date);
    if (!date) {
      return null;
    }
    const data = (row.data ?? {}) as Record<string, unknown>;
    const type = row.eventType;
    const eventType =
      typeof type === 'number'
        ? (HISTORY_EVENT_TYPES[type] ?? 'unknown')
        : (Object.values(HISTORY_EVENT_TYPES).find(
            (known) =>
              typeof type === 'string' &&
              known.toLowerCase() === type.toLowerCase(),
          ) ?? 'unknown');
    return {
      eventType,
      date,
      sourceTitle: this.readString(row.sourceTitle),
      indexer: this.readString(data.indexer),
      downloadClient:
        this.readString(data.downloadClientName) ??
        this.readString(data.downloadClient),
      message: this.readString(data.message) ?? this.readString(data.reason),
      importedPath: this.readString(data.importedPath),
    };
  }

  private parseQueueDetail(entry: unknown): WhisparrQueueDetail | null {
    const base = this.parseQueueEntry(entry);
    if (!base) {
      return null;
    }
    const row = entry as Record<string, unknown>;
    const messages = Array.isArray(row.statusMessages)
      ? row.statusMessages.flatMap((status) => {
          const list = (status as { messages?: unknown } | null)?.messages;
          return Array.isArray(list)
            ? list.flatMap((text) => {
                const value = this.readString(text);
                return value ? [value] : [];
              })
            : [];
        })
      : [];
    return {
      ...base,
      title: this.readString(row.title),
      indexer: this.readString(row.indexer),
      size: this.readNumber(row.size),
      sizeLeft: this.readNumber(row.sizeleft),
      timeLeft: this.readString(row.timeleft),
      estimatedCompletionTime: this.readString(row.estimatedCompletionTime),
      added: this.readString(row.added),
      messages,
    };
  }

  private parseQueueEntry(entry: unknown): WhisparrQueueSnapshotItem | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const movieId =
      this.readNumber((entry as Record<string, unknown>).movieId) ??
      this.readNumber(
        ((entry as Record<string, unknown>).movie as Record<string, unknown>)
          ?.id,
      );
    if (movieId === null) {
      return null;
    }

    return {
      movieId,
      status: this.readString((entry as Record<string, unknown>).status),
      trackedDownloadState: this.readString(
        (entry as Record<string, unknown>).trackedDownloadState,
      ),
      trackedDownloadStatus: this.readString(
        (entry as Record<string, unknown>).trackedDownloadStatus,
      ),
      errorMessage: this.readString(
        (entry as Record<string, unknown>).errorMessage,
      ),
    };
  }

  private parseRootFolderEntry(
    entry: unknown,
  ): WhisparrRootFolderOption | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const id = this.readNumber((entry as Record<string, unknown>).id);
    const path = this.readString((entry as Record<string, unknown>).path);
    if (id === null || !path) {
      return null;
    }

    return {
      id,
      path,
      accessible: (entry as Record<string, unknown>).accessible === true,
    };
  }

  private parseQualityProfileEntry(
    entry: unknown,
  ): WhisparrQualityProfileOption | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const id = this.readNumber((entry as Record<string, unknown>).id);
    const name = this.readString((entry as Record<string, unknown>).name);
    if (id === null || !name) {
      return null;
    }

    return {
      id,
      name,
    };
  }

  private parseTagEntry(entry: unknown): WhisparrTagOption | null {
    if (!entry || typeof entry !== 'object') {
      return null;
    }

    const id = this.readNumber((entry as Record<string, unknown>).id);
    const label = this.readString((entry as Record<string, unknown>).label);
    if (id === null || !label) {
      return null;
    }

    return {
      id,
      label,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readNumber(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    return value;
  }

  private resolveMovieLookupEndpoint(baseUrl: string, stashId: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');

    parsed.pathname = `${cleanPath}/api/v3/movie`;
    parsed.searchParams.set('stashId', stashId);

    return parsed.toString();
  }

  private resolveMovieByIdEndpoint(baseUrl: string, movieId: number): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');

    parsed.pathname = `${cleanPath}/api/v3/movie/${encodeURIComponent(String(movieId))}`;
    parsed.search = '';

    return parsed.toString();
  }

  private resolveQueueEndpoint(
    baseUrl: string,
    page: number,
    pageSize: number,
  ): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');

    parsed.pathname = `${cleanPath}/api/v3/queue`;
    parsed.searchParams.set('page', String(page));
    parsed.searchParams.set('pageSize', String(pageSize));

    return parsed.toString();
  }

  private resolveRootFoldersEndpoint(baseUrl: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/api/v3/rootFolder`;
    parsed.search = '';
    return parsed.toString();
  }

  private resolveQualityProfilesEndpoint(baseUrl: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/api/v3/qualityprofile`;
    parsed.search = '';
    return parsed.toString();
  }

  private resolveTagsEndpoint(baseUrl: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/api/v3/tag`;
    parsed.search = '';
    return parsed.toString();
  }

  private resolveMovieCollectionEndpoint(baseUrl: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/api/v3/movie`;
    parsed.search = '';
    return parsed.toString();
  }

  private resolveSystemStatusEndpoint(baseUrl: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');

    parsed.pathname = `${cleanPath}/api/v3/system/status`;
    parsed.search = '';

    return parsed.toString();
  }

  private summarizeArrayPayload(payload: unknown[]): string {
    return this.safeJson({
      count: payload.length,
      sample: payload.slice(0, 3),
    });
  }

  private extractCollectionRecords(
    payload: unknown,
    collectionName: string,
  ): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === 'object') {
      const payloadRecord = payload as Record<string, unknown>;
      const records = payloadRecord.records;
      if (Array.isArray(records)) {
        this.logger.debug(
          `Whisparr ${collectionName} payload includes records wrapper: ${this.safeJson(
            {
              topLevelKeys: Object.keys(payloadRecord),
              recordsCount: records.length,
              totalRecords: this.readNumber(payloadRecord.totalRecords),
            },
          )}`,
        );
        return records;
      }
    }

    this.logger.error(
      `Whisparr ${collectionName} payload has unexpected shape: ${this.safeJson(
        {
          payloadShape: this.describePayloadShape(payload),
          payloadPreview: this.previewPayload(payload),
        },
      )}`,
    );
    throw new BadGatewayException(
      `Whisparr provider returned an unexpected ${collectionName} response shape.`,
    );
  }

  private extractQueuePage(payload: unknown): {
    records: unknown[];
    totalRecords: number | null;
  } {
    if (Array.isArray(payload)) {
      return {
        records: payload,
        totalRecords: null,
      };
    }

    if (payload && typeof payload === 'object') {
      const payloadRecord = payload as Record<string, unknown>;
      const records = payloadRecord.records;
      if (Array.isArray(records)) {
        const totalRecords = this.readNumber(payloadRecord.totalRecords);
        this.logger.debug(
          `Whisparr queue payload includes records wrapper: ${this.safeJson({
            topLevelKeys: Object.keys(payloadRecord),
            recordsCount: records.length,
            totalRecords,
          })}`,
        );
        return {
          records,
          totalRecords,
        };
      }
    }

    this.logger.error(
      `Whisparr queue payload has unexpected shape: ${this.safeJson({
        payloadShape: this.describePayloadShape(payload),
        payloadPreview: this.previewPayload(payload),
      })}`,
    );
    throw new BadGatewayException(
      'Whisparr provider returned an unexpected queue response shape.',
    );
  }

  private describePayloadShape(payload: unknown): Record<string, unknown> {
    if (Array.isArray(payload)) {
      return {
        kind: 'array',
        length: payload.length,
      };
    }

    if (payload && typeof payload === 'object') {
      const objectPayload = payload as Record<string, unknown>;
      return {
        kind: 'object',
        keys: Object.keys(objectPayload),
      };
    }

    return {
      kind: typeof payload,
    };
  }

  private previewPayload(payload: unknown): unknown {
    if (Array.isArray(payload)) {
      return payload.slice(0, 3);
    }

    if (payload && typeof payload === 'object') {
      const objectPayload = payload as Record<string, unknown>;
      const keyValues = Object.fromEntries(
        Object.entries(objectPayload).slice(0, 8),
      );
      return keyValues;
    }

    return payload;
  }

  private safeJson(value: unknown): string {
    try {
      const serialized = JSON.stringify(value, null, 2);
      if (!serialized) {
        return 'null';
      }
      return serialized.length > 3000
        ? `${serialized.slice(0, 3000)}...(truncated)`
        : serialized;
    } catch {
      return '[unserializable]';
    }
  }

  private serializeError(error: unknown): Record<string, unknown> {
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

  // ---------- setup check ----------

  private v3Url(config: WhisparrAdapterBaseConfig, path: string): string {
    const parsed = new URL(config.baseUrl);
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/api/v3/${path}`;
    parsed.search = '';
    return parsed.toString();
  }

  /** Whisparr's version, from its system status. */
  async getSystemStatus(
    config: WhisparrAdapterBaseConfig,
  ): Promise<{ version: string | null }> {
    const payload = await this.fetchJsonPayload(
      this.v3Url(config, 'system/status'),
      config,
    );
    const record = (
      payload && typeof payload === 'object' ? payload : {}
    ) as Record<string, unknown>;
    return { version: this.readString(record.version) };
  }

  /** One of Whisparr's settings pages as it sends it ("mediamanagement" or "naming"). */
  async getConfigSection(
    config: WhisparrAdapterBaseConfig,
    section: 'mediamanagement' | 'naming',
  ): Promise<Record<string, unknown>> {
    const payload = await this.fetchJsonPayload(
      this.v3Url(config, `config/${section}`),
      config,
    );
    return (payload && typeof payload === 'object' ? payload : {}) as Record<
      string,
      unknown
    >;
  }

  /** Saves a settings page back. Pass the whole page as read, changed. */
  async updateConfigSection(
    config: WhisparrAdapterBaseConfig,
    section: 'mediamanagement' | 'naming',
    body: Record<string, unknown>,
  ): Promise<void> {
    const id = this.readNumber(body.id);
    await this.fetchJsonPayload(
      this.v3Url(config, `config/${section}${id !== null ? `/${id}` : ''}`),
      config,
      { method: 'PUT', body },
    );
  }

  /** Whisparr's connections (Settings → Connect), as it sends them. */
  async listNotifications(
    config: WhisparrAdapterBaseConfig,
  ): Promise<Array<Record<string, unknown>>> {
    return this.objectsOnly(
      await this.fetchArrayPayload(this.v3Url(config, 'notification'), config),
    );
  }

  /** The blank form for each kind of connection. */
  async getNotificationSchema(
    config: WhisparrAdapterBaseConfig,
  ): Promise<Array<Record<string, unknown>>> {
    return this.objectsOnly(
      await this.fetchArrayPayload(
        this.v3Url(config, 'notification/schema'),
        config,
      ),
    );
  }

  /** Adds a connection, or saves an existing one (when it has an id). */
  async saveNotification(
    config: WhisparrAdapterBaseConfig,
    body: Record<string, unknown>,
  ): Promise<void> {
    const id = this.readNumber(body.id);
    await this.fetchJsonPayload(
      this.v3Url(config, id !== null ? `notification/${id}` : 'notification'),
      config,
      { method: id !== null ? 'PUT' : 'POST', body },
    );
  }

  private objectsOnly(entries: unknown[]): Array<Record<string, unknown>> {
    return entries.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object',
    );
  }
}

/** The path and query of a request, without the host or any apikey, for log lines. */
function endpointPath(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.searchParams.delete('apikey');
    return `${url.pathname}${url.search}`;
  } catch {
    return 'request';
  }
}

/** The scene's picture: Whisparr's screenshot (or poster) at its source. */
function calendarImage(images: unknown): string | null {
  if (!Array.isArray(images)) {
    return null;
  }
  const rows = images as Array<Record<string, unknown> | null>;
  const pick = (type: string) =>
    rows.find(
      (image) =>
        typeof image?.coverType === 'string' &&
        image.coverType.toLowerCase() === type,
    );
  const image = pick('screenshot') ?? pick('poster') ?? rows[0];
  const url = image?.remoteUrl ?? image?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}
