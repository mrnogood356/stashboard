import { BadGatewayException, Logger } from '@nestjs/common';
import { RuntimeHealthServiceKey } from '@prisma/client';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { fetchWithTimeout } from '../fetch-with-timeout';
import { pauseCatalog, withCatalogSlot } from './catalog-rate-limit';
import {
  describeErrorResponse,
  ProviderResponseError,
  readJsonResponse,
} from '../provider-response';
import {
  type StashdbAdapterBaseConfig,
  type StashdbGraphqlResponse,
  type StashdbSceneImage,
} from './stashdb.types';

/** After a 429, one more try only when the server asks to wait this long or less. */
const RETRY_AFTER_429_MAX_MS = 30_000;
/** The same refusal is logged as a warning at most this often. */
const REFUSAL_LOG_INTERVAL_MS = 10 * 60_000;
/** A database error on the catalog's own server. */
const SERVER_SIDE_ERROR = /SQLSTATE/i;

/**
 * Talks to a stash-box GraphQL API (StashDB, FansDB): the request, readable
 * network errors, runtime-health reporting, and shared normalizers.
 */
export abstract class StashdbGraphqlClient {
  protected readonly logger = new Logger('StashdbAdapter');
  /** When each refusal (query and message) was last logged as a warning. */
  private readonly refusalsLogged = new Map<string, number>();

  constructor(protected readonly runtimeHealthService: RuntimeHealthService) {}

  protected async executeQuery(
    config: StashdbAdapterBaseConfig,
    query: string,
    variables?: Record<string, unknown>,
    trackRuntimeHealth = true,
  ): Promise<StashdbGraphqlResponse> {
    const payload = await this.executeQueryRaw(
      config,
      query,
      variables,
      trackRuntimeHealth,
    );

    if (payload.errors && payload.errors.length > 0) {
      const firstError = payload.errors[0]?.message;
      const message =
        typeof firstError === 'string' && firstError.length > 0
          ? firstError
          : 'StashDB GraphQL request failed.';
      this.logRefusal(operationName(query), message);
      // A database error on the catalog's side ("SQLSTATE …") came back from
      // a server that's up: that query failed, the catalog didn't.
      if (trackRuntimeHealth && !SERVER_SIDE_ERROR.test(message)) {
        await this.reportRuntimeFailure(message);
      }
      throw new BadGatewayException(message);
    }

    if (trackRuntimeHealth) {
      await this.reportRuntimeSuccess();
    }

    return payload;
  }

  /** Said once every few minutes per query and message, not on every lookup. */
  private logRefusal(operation: string, message: string): void {
    const key = `${operation}|${message}`;
    const now = Date.now();
    const last = this.refusalsLogged.get(key);
    if (last !== undefined && now - last < REFUSAL_LOG_INTERVAL_MS) {
      this.logger.debug(`The catalog refused ${operation} again: ${message}`);
      return;
    }
    if (this.refusalsLogged.size > 100) {
      this.refusalsLogged.clear();
    }
    this.refusalsLogged.set(key, now);
    this.logger.warn(
      SERVER_SIDE_ERROR.test(message)
        ? `The catalog had an error of its own answering ${operation} (on its server, not Stashboard's); other lookups carry on: ${message}`
        : `The catalog refused ${operation}: ${message}`,
    );
  }

  protected async executeQueryRaw(
    config: StashdbAdapterBaseConfig,
    query: string,
    variables?: Record<string, unknown>,
    trackRuntimeHealth = true,
  ): Promise<StashdbGraphqlResponse> {
    const endpoint = this.resolveGraphqlEndpoint(config.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey?.trim()) {
      headers.ApiKey = config.apiKey.trim();
    }

    const operation = operationName(query);
    this.logger.verbose(`Catalog GraphQL ${operation} at ${hostOf(endpoint)}`);

    const host = hostOf(endpoint);
    const send = () =>
      withCatalogSlot(host, () =>
        fetchWithTimeout(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query,
            variables,
          }),
        }),
      );
    let response: Response;
    try {
      response = await send();
      if (response.status === 429) {
        // Asked to slow down: nothing more goes there until it says; a short
        // wait is worth one more try.
        const wait = pauseCatalog(host, response.headers.get('retry-after'));
        this.logger.warn(
          `The catalog at ${host} asked Stashboard to slow down (${operation}); pausing requests to it for ${Math.ceil(wait / 1000)}s.`,
        );
        if (wait > RETRY_AFTER_429_MAX_MS) {
          throw new BadGatewayException(
            `The catalog asked Stashboard to slow down; try again in ${Math.ceil(wait / 1000)} seconds.`,
          );
        }
        response = await send();
      }
    } catch (error) {
      if (error instanceof BadGatewayException) {
        throw error;
      }
      const message = this.providerRequestFailureMessage(error);
      this.logger.warn(
        `Couldn't reach the catalog at ${hostOf(endpoint)} (${operation}): ${this.errorMessage(error)}`,
      );
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(message);
      }
      throw new BadGatewayException(message);
    }

    if (!response.ok) {
      const message = await describeErrorResponse(response, 'StashDB provider');
      this.logger.warn(
        `The catalog at ${hostOf(endpoint)} answered ${response.status} to ${operation}: ${message}`,
      );
      if (response.status === 429) {
        // Still too many: wait it out, without calling the catalog down.
        pauseCatalog(host, response.headers.get('retry-after'));
      } else if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(message);
      }
      throw new BadGatewayException(message);
    }

    try {
      return (
        (await readJsonResponse<StashdbGraphqlResponse>(
          response,
          'The catalog provider',
        )) ?? {}
      );
    } catch (error) {
      if (!(error instanceof ProviderResponseError)) {
        throw error;
      }
      this.logger.warn(
        `The catalog's answer to ${operation} couldn't be read: ${error.message}`,
      );
      if (trackRuntimeHealth) {
        await this.reportRuntimeFailure(error.message);
      }
      throw new BadGatewayException(error.message);
    }
  }

  protected async reportRuntimeSuccess(): Promise<void> {
    try {
      await this.runtimeHealthService.recordSuccess(
        RuntimeHealthServiceKey.CATALOG,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record catalog runtime recovery: ${this.errorMessage(error)}`,
      );
    }
  }

  protected async reportRuntimeFailure(error: unknown): Promise<void> {
    try {
      await this.runtimeHealthService.recordFailure(
        RuntimeHealthServiceKey.CATALOG,
        error,
      );
    } catch (reportingError) {
      this.logger.warn(
        `Failed to record catalog runtime failure: ${this.errorMessage(reportingError)}`,
      );
    }
  }

  protected errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return 'unknown error';
  }

  protected providerRequestFailureMessage(error: unknown): string {
    const details = this.networkErrorDetails(error);

    if (!details) {
      return 'Failed to reach StashDB provider endpoint.';
    }

    return `Failed to reach StashDB provider endpoint: ${details}`;
  }

  protected networkErrorDetails(error: unknown): string | null {
    const details: string[] = [];
    this.collectNetworkErrorDetails(error, details, new Set<unknown>());

    return details.length > 0 ? details.join('; ') : null;
  }

  protected collectNetworkErrorDetails(
    error: unknown,
    details: string[],
    seen: Set<unknown>,
  ): void {
    if (!error || seen.has(error)) {
      return;
    }

    seen.add(error);

    if (typeof error === 'string') {
      const trimmed = error.trim();
      if (trimmed.length > 0) {
        this.addUniqueDetail(details, trimmed);
      }
      return;
    }

    if (error instanceof AggregateError) {
      for (const nestedError of error.errors) {
        this.collectNetworkErrorDetails(nestedError, details, seen);
      }
    }

    if (error instanceof Error) {
      const parts = [
        this.errorCode(error),
        error.message.trim().length > 0 ? error.message.trim() : null,
      ].filter((part): part is string => !!part);

      if (parts.length > 0) {
        this.addUniqueDetail(details, parts.join(' '));
      }

      this.collectNetworkErrorDetails(error.cause, details, seen);
      return;
    }

    if (typeof error === 'object') {
      const maybeError = error as {
        cause?: unknown;
        code?: unknown;
        message?: unknown;
        errors?: unknown;
      };
      const code =
        typeof maybeError.code === 'string' && maybeError.code.trim().length > 0
          ? maybeError.code.trim()
          : null;
      const message =
        typeof maybeError.message === 'string' &&
        maybeError.message.trim().length > 0
          ? maybeError.message.trim()
          : null;

      if (code || message) {
        this.addUniqueDetail(
          details,
          [code, message].filter((part): part is string => !!part).join(' '),
        );
      }

      if (Array.isArray(maybeError.errors)) {
        for (const nestedError of maybeError.errors) {
          this.collectNetworkErrorDetails(nestedError, details, seen);
        }
      }

      this.collectNetworkErrorDetails(maybeError.cause, details, seen);
    }
  }

  protected errorCode(error: Error): string | null {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.trim().length > 0
      ? code.trim()
      : null;
  }

  protected addUniqueDetail(details: string[], detail: string): void {
    if (!details.includes(detail)) {
      details.push(detail);
    }
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

  protected normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  protected normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((entry): entry is string => typeof entry === 'string');
  }

  protected selectPrimaryImage(
    images: StashdbSceneImage[],
  ): StashdbSceneImage | null {
    if (images.length === 0) {
      return null;
    }

    return images.reduce<StashdbSceneImage>((best, current) => {
      const bestWidth = best.width ?? 0;
      const currentWidth = current.width ?? 0;
      return currentWidth > bestWidth ? current : best;
    }, images[0]);
  }

  protected normalizeImages(
    images:
      | Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>
      | null
      | undefined,
  ): StashdbSceneImage[] {
    return (images ?? [])
      .map((image): StashdbSceneImage | null => {
        if (typeof image.id !== 'string' || typeof image.url !== 'string') {
          return null;
        }

        return {
          id: image.id,
          url: image.url,
          width: typeof image.width === 'number' ? image.width : null,
          height: typeof image.height === 'number' ? image.height : null,
        };
      })
      .filter((image): image is StashdbSceneImage => image !== null);
  }
}

/** "query FindScenes" for log lines, from a GraphQL document. */
function operationName(query: string): string {
  const match = /\b(query|mutation)\s+(\w+)/.exec(query);
  return match ? `${match[1]} ${match[2]}` : 'request';
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'its address';
  }
}
