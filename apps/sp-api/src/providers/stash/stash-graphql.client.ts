import { BadGatewayException, Logger } from '@nestjs/common';
import { RuntimeHealthServiceKey } from '@prisma/client';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { fetchWithTimeout } from '../fetch-with-timeout';
import {
  describeErrorResponse,
  ProviderResponseError,
  readJsonResponse,
} from '../provider-response';
import {
  type StashAdapterBaseConfig,
  type StashGraphqlResponse,
  type StashProtectedAssetResponse,
} from './stash.types';

/**
 * Talks to Stash's GraphQL API: the request itself, runtime-health reporting,
 * and the helpers every Stash call shares. StashAdapter builds on it.
 */
export abstract class StashGraphqlClient {
  protected readonly logger = new Logger('StashAdapter');

  constructor(protected readonly runtimeHealthService: RuntimeHealthService) {}

  /** Runs a query with richer fields first, then simpler ones for older Stash versions. */
  protected async queryWithFallback(
    config: StashAdapterBaseConfig,
    build: (fields: string) => string,
    fieldSets: string[],
    variables: Record<string, unknown>,
    pick: (data: unknown) => Record<string, unknown> | null | undefined,
  ): Promise<Record<string, unknown> | null> {
    let lastError: unknown = null;
    for (const fields of fieldSets) {
      try {
        const payload = await this.executeQuery(
          config,
          build(fields),
          variables,
        );
        return pick(payload.data ?? {}) ?? null;
      } catch (error) {
        lastError = error;
        if (
          !/Cannot query field|Unknown field|unknown field/i.test(
            this.errorMessage(error),
          )
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  protected async fetchProtectedAsset(
    config: StashAdapterBaseConfig,
    assetUrl: string,
  ): Promise<StashProtectedAssetResponse | null> {
    const resolvedUrl = this.resolveProtectedAssetUrl(config.baseUrl, assetUrl);
    const headers: Record<string, string> = {};
    if (config.apiKey?.trim()) {
      headers.ApiKey = config.apiKey.trim();
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(resolvedUrl, { headers });
    } catch (error) {
      await this.reportRuntimeFailure(error);
      throw new BadGatewayException('Failed to reach Stash provider endpoint.');
    }

    if (response.status === 404) {
      await this.reportRuntimeSuccess();
      return null;
    }

    if (!response.ok) {
      await this.reportRuntimeFailure(
        `Stash provider returned ${response.status} for media request.`,
      );
      throw new BadGatewayException(
        `Stash provider returned ${response.status} for media request.`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await this.reportRuntimeSuccess();

    return {
      body: buffer,
      contentType: response.headers.get('content-type'),
      contentLength: String(buffer.byteLength),
      cacheControl: response.headers.get('cache-control'),
    };
  }

  protected pickFirstDuration(
    files: Array<{ duration?: unknown }>,
  ): number | null {
    for (const file of files) {
      if (typeof file.duration === 'number' && Number.isFinite(file.duration)) {
        return file.duration;
      }
    }

    return null;
  }

  protected normalizeEntityId(id: string): string | null {
    const normalized = id.trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : null;
  }

  protected normalizeOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  protected normalizeStringArray(values: string[] | undefined): string[] {
    const deduped = new Set<string>();
    for (const value of values ?? []) {
      const normalized = this.normalizeOptionalString(value);
      if (normalized) {
        deduped.add(normalized);
      }
    }

    return [...deduped];
  }

  protected parseAssetUrl(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  protected parseOptionalDate(value: unknown): Date | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  protected resolveProtectedAssetUrl(
    baseUrl: string,
    assetUrl: string,
  ): string {
    const base = new URL(baseUrl);
    let candidate: URL;
    try {
      candidate = new URL(assetUrl, base);
    } catch {
      throw new BadGatewayException(
        'Stash provider returned an unexpected media URL.',
      );
    }

    if (candidate.origin === base.origin) {
      return candidate.toString();
    }

    // Stash builds media URLs from its own idea of its address (localhost, a
    // container name, a reverse-proxy domain), which often differs from the
    // address Stashboard is configured with. Keep only the path and query and
    // send the request to the configured origin, so the API key never leaves
    // the Stash server the user set up.
    return new URL(
      `${candidate.pathname}${candidate.search}`,
      base.origin,
    ).toString();
  }

  protected normalizePositiveInteger(value: number, fallback: number): number {
    const normalized = Math.floor(Number(value));
    return normalized > 0 ? normalized : fallback;
  }

  protected async executeQuery(
    config: StashAdapterBaseConfig,
    query: string,
    variables?: Record<string, unknown>,
    trackRuntimeHealth = true,
  ): Promise<StashGraphqlResponse> {
    const endpoint = this.resolveGraphqlEndpoint(config.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (config.apiKey?.trim()) {
      headers.ApiKey = config.apiKey.trim();
    }

    const operation = operationName(query);
    this.logger.verbose(`Stash GraphQL ${operation}`);

    let response: Response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      this.logger.warn(
        `Couldn't reach Stash (${operation}): ${this.errorMessage(error)}`,
      );
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(error);
      }
      throw new BadGatewayException('Failed to reach Stash provider endpoint.');
    }

    if (!response.ok) {
      const message = await describeErrorResponse(response, 'Stash provider');
      this.logger.warn(
        `Stash answered ${response.status} to ${operation}: ${message}`,
      );
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(message);
      }
      throw new BadGatewayException(message);
    }

    let payload: StashGraphqlResponse;
    try {
      payload =
        (await readJsonResponse<StashGraphqlResponse>(response, 'Stash')) ?? {};
    } catch (error) {
      if (!(error instanceof ProviderResponseError)) {
        throw error;
      }
      this.logger.warn(
        `Stash's answer to ${operation} couldn't be read: ${error.message}`,
      );
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(error.message);
      }
      throw new BadGatewayException(error.message);
    }

    if (payload.errors && payload.errors.length > 0) {
      const firstError = payload.errors[0]?.message;
      const message =
        typeof firstError === 'string' && firstError.length > 0
          ? firstError
          : 'Stash GraphQL request failed.';
      this.logger.warn(`Stash refused ${operation}: ${message}`);
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(message);
      }
      throw new BadGatewayException(message);
    }

    if (trackRuntimeHealth) {
      await this.reportRuntimeSuccess();
    }

    return payload;
  }

  protected async reportRuntimeSuccess(): Promise<void> {
    try {
      await this.runtimeHealthService.recordSuccess(
        RuntimeHealthServiceKey.STASH,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record Stash runtime recovery: ${this.errorMessage(error)}`,
      );
    }
  }

  protected async reportRuntimeFailure(error: unknown): Promise<void> {
    try {
      await this.runtimeHealthService.recordFailure(
        RuntimeHealthServiceKey.STASH,
        error,
      );
    } catch (reportingError) {
      this.logger.warn(
        `Failed to record Stash runtime failure: ${this.errorMessage(reportingError)}`,
      );
    }
  }

  protected errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return 'unknown error';
  }

  protected resolveGraphqlEndpoint(baseUrl: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');

    if (cleanPath.endsWith('/graphql')) {
      return parsed.toString();
    }

    parsed.pathname = `${cleanPath}/graphql`;
    return parsed.toString();
  }

  protected resolveSceneViewUrl(baseUrl: string, sceneId: string): string {
    const parsed = new URL(baseUrl);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${cleanPath}/scenes/${encodeURIComponent(sceneId)}`;
    parsed.search = '';
    return parsed.toString();
  }
}

/** "query FindScenes" for log lines, from a GraphQL document. */
function operationName(query: string): string {
  const match = /\b(query|mutation)\s+(\w+)/.exec(query);
  return match ? `${match[1]} ${match[2]}` : 'request';
}
