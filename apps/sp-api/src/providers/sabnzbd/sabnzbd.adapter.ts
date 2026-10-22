import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { fetchWithTimeout } from '../fetch-with-timeout';
import {
  describeErrorResponse,
  ProviderResponseError,
  readJsonResponse,
} from '../provider-response';
import {
  trimTrailingSeparators,
  trimTrailingSeparatorsKeepFirst,
} from '../../path-separators';

export interface SabnzbdAdapterBaseConfig {
  baseUrl: string;
  apiKey?: string | null;
}

/** One finished (or failed) download in SABnzbd's history. */
export interface SabnzbdHistoryEntry {
  nzoId: string;
  name: string | null;
  category: string | null;
  /** "Completed", "Failed", or a step like "Extracting" while it's still busy. */
  status: string;
  /** The finished download's folder, as SABnzbd sees it. */
  storage: string | null;
  failMessage: string | null;
  /** When SABnzbd finished with it (its "completed" time); null when it doesn't say. */
  completedAt?: Date | null;
}

/** One download still in SABnzbd's queue. */
export interface SabnzbdQueueEntry {
  nzoId: string;
  /** The job's name, which becomes its folder's name once it's done. */
  name: string | null;
  category: string | null;
  status: string;
  /** How much is downloaded, 0–100; null when SABnzbd doesn't say. */
  percentage?: number | null;
  /** Time left as SABnzbd shows it, e.g. "0:12:30". */
  timeLeft?: string | null;
}

/** Where SABnzbd puts a category's finished downloads (see categoryFolders). */
export interface SabnzbdCategoryFolders {
  completed: string | null;
  category: string | null;
  /** SABnzbd has a category by that name. */
  found?: boolean;
  /** The category has a folder of its own, not just the Completed Download Folder. */
  ownFolder?: boolean;
  /** Each download gets a folder of its own (no trailing "*"). */
  jobFolders?: boolean;
}

const UPLOAD_TIMEOUT_MS = 60_000;
/** History and queue are read a page at a time; this is plenty for one category. */
export const SABNZBD_LIST_LIMIT = 200;
const LIST_LIMIT = SABNZBD_LIST_LIMIT;

/**
 * Talks to SABnzbd's API: checks the connection and its categories, adds an
 * NZB to one category, and reads the queue and history. It never deletes,
 * retries or pauses anything.
 */
@Injectable()
export class SabnzbdAdapter {
  private readonly logger = new Logger(SabnzbdAdapter.name);

  async testConnection(config: SabnzbdAdapterBaseConfig): Promise<void> {
    await this.getVersion(config);
  }

  async getVersion(config: SabnzbdAdapterBaseConfig): Promise<string | null> {
    const payload = await this.call(config, 'version');
    const version = (payload as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : null;
  }

  /** The categories set up in SABnzbd (Settings → Categories). */
  async listCategories(config: SabnzbdAdapterBaseConfig): Promise<string[]> {
    const payload = await this.call(config, 'get_cats');
    const categories = (payload as { categories?: unknown } | null)?.categories;
    return Array.isArray(categories)
      ? categories.filter(
          (entry): entry is string => typeof entry === 'string' && !!entry,
        )
      : [];
  }

  /**
   * Where a category's finished downloads go, as SABnzbd sees it: the
   * category's folder, under the Completed Download Folder unless it's a
   * full path itself. Null when SABnzbd doesn't say.
   */
  async categoryFolder(
    config: SabnzbdAdapterBaseConfig,
    category: string,
  ): Promise<string | null> {
    return (await this.categoryFolders(config, category)).category;
  }

  /**
   * SABnzbd's Completed Download Folder, and the category's folder (as in
   * categoryFolder), both as SABnzbd sees them; null where it doesn't say.
   *
   * A category folder written with a trailing "*" ("stashboard*") tells
   * SABnzbd not to give each download a folder of its own; the "*" isn't
   * part of the folder's name, so it's left off, and `jobFolders` says so.
   */
  async categoryFolders(
    config: SabnzbdAdapterBaseConfig,
    category: string,
  ): Promise<SabnzbdCategoryFolders> {
    const [misc, categories] = await Promise.all([
      this.call(config, 'get_config', { section: 'misc' }),
      this.call(config, 'get_config', { section: 'categories' }),
    ]);
    const rawCompleteDir = readString(
      (misc as { config?: { misc?: { complete_dir?: unknown } } } | null)
        ?.config?.misc?.complete_dir,
    );
    const completeDir = rawCompleteDir
      ? trimTrailingSeparatorsKeepFirst(rawCompleteDir)
      : null;
    const list = (categories as { config?: { categories?: unknown } } | null)
      ?.config?.categories;
    const entry = Array.isArray(list)
      ? (list as Array<Record<string, unknown>>).find(
          (item) =>
            typeof item?.name === 'string' &&
            item.name.toLowerCase() === category.toLowerCase(),
        )
      : undefined;
    const rawDir = readString(entry?.dir);
    const jobFolders = !rawDir?.endsWith('*');
    const dir =
      (rawDir &&
        readString(
          trimTrailingSeparatorsKeepFirst(rawDir.replace(/\*+$/, '')),
        )) ??
      null;
    const flags = {
      found: entry !== undefined,
      ownFolder: dir !== null,
      jobFolders,
    };
    if (dir && /^([\\/]|[a-z]:[\\/])/i.test(dir)) {
      return { completed: completeDir, category: dir, ...flags };
    }
    if (!completeDir) {
      return { completed: null, category: null, ...flags };
    }
    return {
      completed: completeDir,
      category: dir
        ? `${trimTrailingSeparators(completeDir)}/${dir.replace(/^[\\/]+/, '')}`
        : completeDir,
      ...flags,
    };
  }

  /**
   * Adds an NZB to SABnzbd under one category and returns its id. The file is
   * uploaded, so SABnzbd doesn't have to reach Prowlarr itself.
   */
  async addNzb(
    config: SabnzbdAdapterBaseConfig,
    nzb: {
      content: Uint8Array;
      fileName: string;
      category: string;
      name: string;
    },
  ): Promise<string> {
    const form = new FormData();
    form.append(
      'name',
      new Blob([new Uint8Array(nzb.content)], { type: 'application/x-nzb' }),
      nzb.fileName,
    );
    const payload = await this.call(
      config,
      'addfile',
      { cat: nzb.category, nzbname: nzb.name },
      { body: form, timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    const row = payload as {
      status?: unknown;
      nzo_ids?: unknown;
      error?: unknown;
    } | null;
    const ids = Array.isArray(row?.nzo_ids)
      ? row.nzo_ids.filter(
          (id): id is string => typeof id === 'string' && !!id.trim(),
        )
      : [];
    if (row?.status === false || ids.length === 0) {
      throw new BadGatewayException(
        typeof row?.error === 'string' && row.error.trim()
          ? `SABnzbd didn’t take the download: ${row.error.trim()}`
          : 'SABnzbd didn’t take the download.',
      );
    }
    return ids[0];
  }

  /** Finished and failed downloads in one category, newest first. */
  async history(
    config: SabnzbdAdapterBaseConfig,
    category: string,
    start = 0,
  ): Promise<SabnzbdHistoryEntry[]> {
    const payload = await this.call(config, 'history', {
      category,
      limit: String(LIST_LIMIT),
      ...(start > 0 ? { start: String(start) } : {}),
    });
    const slots = (payload as { history?: { slots?: unknown } } | null)?.history
      ?.slots;
    if (!Array.isArray(slots)) {
      return [];
    }
    return slots.flatMap((slot): SabnzbdHistoryEntry[] => {
      const row = (slot ?? {}) as Record<string, unknown>;
      const nzoId = readString(row.nzo_id);
      const status = readString(row.status);
      // Seconds since 1970, as a number (or, in some versions, a string).
      const completed = Number(row.completed ?? NaN);
      return nzoId && status
        ? [
            {
              nzoId,
              name: readString(row.name),
              category: readString(row.category),
              status,
              storage: readString(row.storage),
              failMessage: readString(row.fail_message),
              completedAt:
                Number.isFinite(completed) && completed > 0
                  ? new Date(completed * 1000)
                  : null,
            },
          ]
        : [];
    });
  }

  /** Downloads still waiting or downloading in one category. */
  async queue(
    config: SabnzbdAdapterBaseConfig,
    category: string,
  ): Promise<SabnzbdQueueEntry[]> {
    const payload = await this.call(config, 'queue', {
      category,
      limit: String(LIST_LIMIT),
    });
    const slots = (payload as { queue?: { slots?: unknown } } | null)?.queue
      ?.slots;
    if (!Array.isArray(slots)) {
      return [];
    }
    return slots.flatMap((slot): SabnzbdQueueEntry[] => {
      const row = (slot ?? {}) as Record<string, unknown>;
      const nzoId = readString(row.nzo_id);
      // SABnzbd sends the percentage as a string.
      const percentage =
        typeof row.percentage === 'number'
          ? row.percentage
          : Number(readString(row.percentage) ?? NaN);
      return nzoId
        ? [
            {
              nzoId,
              name: readString(row.filename),
              category: readString(row.cat),
              status: readString(row.status) ?? 'Queued',
              percentage: Number.isFinite(percentage) ? percentage : null,
              timeLeft: readString(row.timeleft),
            },
          ]
        : [];
    });
  }

  private async call(
    config: SabnzbdAdapterBaseConfig,
    mode: string,
    params: Record<string, string> = {},
    options: { body?: FormData; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const url = new URL(config.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api`;
    const search = new URLSearchParams({ mode, output: 'json', ...params });
    if (config.apiKey?.trim()) {
      search.set('apikey', config.apiKey.trim());
    }
    url.search = search.toString();
    // The address carries the API key, so only the mode is logged.
    this.logger.debug(`SABnzbd request mode=${mode}.`);

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url.toString(),
        {
          method: options.body ? 'POST' : 'GET',
          headers: { Accept: 'application/json' },
          body: options.body,
        },
        options.timeoutMs,
      );
    } catch (error) {
      // The address carries the API key, so only the mode is logged.
      this.logger.warn(
        `SABnzbd request mode=${mode} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(
        isAbort(error)
          ? 'SABnzbd took too long to answer.'
          : 'Couldn’t reach SABnzbd. Check that it’s running and its address.',
      );
    }

    if (!response.ok) {
      const message = await describeErrorResponse(response, 'SABnzbd');
      this.logger.warn(`SABnzbd mode=${mode}: ${message}`);
      throw new BadGatewayException(
        response.status === 401 || response.status === 403
          ? 'SABnzbd refused the API key. Check it in Settings → Integrations.'
          : message,
      );
    }

    let payload: unknown;
    try {
      payload = await readJsonResponse(response, 'SABnzbd');
    } catch (error) {
      this.logger.warn(
        `SABnzbd's answer to mode=${mode} couldn't be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(
        error instanceof ProviderResponseError
          ? error.message
          : 'SABnzbd replied with something unreadable.',
      );
    }
    // SABnzbd answers a bad key with 200 and { status: false, error: "API Key Incorrect" }.
    const error = (payload as { error?: unknown } | null)?.error;
    if (typeof error === 'string' && /api key/i.test(error)) {
      this.logger.warn(`SABnzbd refused the API key (mode=${mode}).`);
      throw new BadGatewayException(
        'SABnzbd refused the API key. Check it in Settings → Integrations.',
      );
    }
    return payload;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
