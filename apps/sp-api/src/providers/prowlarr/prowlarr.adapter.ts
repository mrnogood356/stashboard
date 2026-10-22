import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { fetchWithTimeout } from '../fetch-with-timeout';
import {
  describeErrorResponse,
  ProviderResponseError,
  readJsonResponse,
} from '../provider-response';

export interface ProwlarrAdapterBaseConfig {
  baseUrl: string;
  apiKey?: string | null;
}

/** One release an indexer found, as Prowlarr reports it. */
export interface ProwlarrRelease {
  guid: string;
  indexerId: number;
  indexer: string | null;
  title: string;
  size: number | null;
  protocol: 'torrent' | 'usenet' | null;
  seeders: number | null;
  leechers: number | null;
  ageHours: number | null;
  /** ISO date the indexer says it was posted. */
  publishDate: string | null;
  infoUrl: string | null;
  /**
   * Where Prowlarr serves the release's NZB or torrent. It carries
   * Prowlarr's API key, so it stays on the server.
   */
  downloadUrl: string | null;
}

/**
 * Newznab's XXX categories, so a search doesn't come back with movies or TV
 * that happen to share a word. Image sets (6060) are left out.
 */
export const PROWLARR_XXX_CATEGORIES = [
  6000, 6010, 6020, 6030, 6040, 6045, 6050, 6070, 6080, 6090,
] as const;

/** Prowlarr searches every indexer at once; slow ones can take a while. */
const SEARCH_TIMEOUT_MS = 120_000;
const GRAB_TIMEOUT_MS = 60_000;
/** An NZB is a few megabytes at most; anything far bigger isn't one. */
const MAX_NZB_BYTES = 50 * 1024 * 1024;

/**
 * Talks to Prowlarr's v1 API: checks the connection, searches its indexers
 * and sends a release to the download client set up in Prowlarr.
 */
@Injectable()
export class ProwlarrAdapter {
  private readonly logger = new Logger(ProwlarrAdapter.name);

  async testConnection(config: ProwlarrAdapterBaseConfig): Promise<void> {
    await this.getSystemStatus(config);
  }

  async getSystemStatus(
    config: ProwlarrAdapterBaseConfig,
  ): Promise<{ version: string | null }> {
    const payload = await this.fetchJson(config, 'system/status');
    const version = (payload as { version?: unknown } | null)?.version;
    return { version: typeof version === 'string' ? version : null };
  }

  /** How many indexers are turned on, for the setup check. */
  async countEnabledIndexers(
    config: ProwlarrAdapterBaseConfig,
  ): Promise<number> {
    const payload = await this.fetchJson(config, 'indexer');
    return Array.isArray(payload)
      ? payload.filter(
          (entry) => (entry as { enable?: unknown } | null)?.enable === true,
        ).length
      : 0;
  }

  /** Names of the download clients turned on, for the setup check. */
  async listEnabledDownloadClients(
    config: ProwlarrAdapterBaseConfig,
  ): Promise<string[]> {
    const payload = await this.fetchJson(config, 'downloadclient');
    if (!Array.isArray(payload)) {
      return [];
    }
    return payload.flatMap((entry) => {
      const row = entry as { enable?: unknown; name?: unknown } | null;
      return row?.enable === true && typeof row.name === 'string'
        ? [row.name]
        : [];
    });
  }

  /** Searches every indexer in Prowlarr for one query. */
  async search(
    config: ProwlarrAdapterBaseConfig,
    query: string,
    categories: readonly number[] = PROWLARR_XXX_CATEGORIES,
  ): Promise<ProwlarrRelease[]> {
    const params = new URLSearchParams({ query, type: 'search' });
    for (const category of categories) {
      params.append('categories', String(category));
    }
    const payload = await this.fetchJson(config, 'search', {
      params,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    if (!Array.isArray(payload)) {
      throw new BadGatewayException(
        'Prowlarr returned an unexpected search response.',
      );
    }
    return payload
      .map((entry) => parseRelease(entry))
      .filter((entry): entry is ProwlarrRelease => entry !== null);
  }

  /**
   * Sends a release from a recent search to Prowlarr's download client.
   * Prowlarr only remembers search results for about 30 minutes.
   */
  async grab(
    config: ProwlarrAdapterBaseConfig,
    release: { guid: string; indexerId: number },
  ): Promise<void> {
    await this.fetchJson(config, 'search', {
      method: 'POST',
      body: { guid: release.guid, indexerId: release.indexerId },
      timeoutMs: GRAB_TIMEOUT_MS,
    });
  }

  /**
   * Fetches a release's NZB through Prowlarr, from the downloadUrl of a
   * recent search. Prowlarr's API key is only sent to Prowlarr's own address.
   */
  async fetchNzb(
    config: ProwlarrAdapterBaseConfig,
    downloadUrl: string,
  ): Promise<{ content: Uint8Array; fileName: string | null }> {
    let url: URL;
    try {
      url = new URL(downloadUrl);
    } catch {
      throw new BadGatewayException('Prowlarr gave an unusable download link.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadGatewayException('Prowlarr gave an unusable download link.');
    }
    const headers: Record<string, string> = {
      Accept: 'application/x-nzb, */*',
    };
    if (config.apiKey?.trim() && sameOrigin(url, config.baseUrl)) {
      headers['X-Api-Key'] = config.apiKey.trim();
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url.toString(),
        { method: 'GET', headers, redirect: 'follow' },
        GRAB_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(
        `Fetching an NZB from Prowlarr failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(
        isAbort(error)
          ? 'Prowlarr took too long to hand over the NZB.'
          : 'Couldn’t fetch the NZB through Prowlarr.',
      );
    }
    if (!response.ok) {
      const message = await describeErrorResponse(response, 'Prowlarr');
      this.logger.warn(`Prowlarr NZB download: ${message}`);
      throw new BadGatewayException(
        `Prowlarr couldn’t fetch the NZB from the indexer: ${message}`,
      );
    }
    let content: Uint8Array;
    try {
      content = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new BadGatewayException(
        'The connection to Prowlarr dropped while fetching the NZB.',
      );
    }
    if (content.byteLength > MAX_NZB_BYTES || !looksLikeNzb(content)) {
      this.logger.warn(
        `The indexer didn't send an NZB file (${content.byteLength} bytes).`,
      );
      throw new BadGatewayException(
        'The indexer didn’t send an NZB file. Try another release.',
      );
    }
    return {
      content,
      fileName: fileNameFrom(response.headers.get('content-disposition')),
    };
  }

  private async fetchJson(
    config: ProwlarrAdapterBaseConfig,
    path: string,
    options: {
      method?: 'GET' | 'POST';
      params?: URLSearchParams;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const url = new URL(config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v1/${path}`;
    url.search = options.params ? options.params.toString() : '';

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (config.apiKey?.trim()) {
      headers['X-Api-Key'] = config.apiKey.trim();
    }
    this.logger.debug(
      `Prowlarr ${options.method ?? 'GET'} /api/v1/${path}${url.search}`,
    );

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url.toString(),
        {
          method: options.method ?? 'GET',
          headers,
          body:
            options.body !== undefined
              ? JSON.stringify(options.body)
              : undefined,
        },
        options.timeoutMs,
      );
    } catch (error) {
      this.logger.warn(
        `Prowlarr request to /api/v1/${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(
        isAbort(error)
          ? 'Prowlarr took too long to answer.'
          : 'Couldn’t reach Prowlarr. Check that it’s running and its address.',
      );
    }

    if (!response.ok) {
      const message = await describeErrorResponse(response, 'Prowlarr');
      this.logger.warn(`Prowlarr /api/v1/${path}: ${message}`);
      throw new BadGatewayException(
        response.status === 401
          ? 'Prowlarr refused the API key. Check it in Settings → Integrations.'
          : message,
      );
    }

    try {
      return await readJsonResponse(response, 'Prowlarr');
    } catch (error) {
      this.logger.warn(
        `Prowlarr's answer to /api/v1/${path} couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(
        error instanceof ProviderResponseError
          ? error.message
          : 'Prowlarr replied with something unreadable.',
      );
    }
  }
}

function parseRelease(entry: unknown): ProwlarrRelease | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const row = entry as Record<string, unknown>;
  const guid = readString(row.guid);
  const indexerId = readNumber(row.indexerId);
  const title = readString(row.title);
  if (!guid || indexerId === null || !title) {
    return null;
  }
  const protocol = readString(row.protocol)?.toLowerCase() ?? null;
  return {
    guid,
    indexerId,
    indexer: readString(row.indexer),
    title,
    size: readNumber(row.size),
    protocol: protocol === 'torrent' || protocol === 'usenet' ? protocol : null,
    seeders: readNumber(row.seeders),
    leechers: readNumber(row.leechers),
    ageHours: readNumber(row.ageHours),
    publishDate: readString(row.publishDate),
    infoUrl: readString(row.infoUrl),
    downloadUrl: readString(row.downloadUrl),
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sameOrigin(url: URL, baseUrl: string): boolean {
  try {
    return url.origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** An NZB is XML with an <nzb> element near the top. */
function looksLikeNzb(content: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(content.subarray(0, 4096))
    .toLowerCase();
  return head.includes('<nzb');
}

function fileNameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
