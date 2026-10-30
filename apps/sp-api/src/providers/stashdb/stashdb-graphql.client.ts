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
/**
 * A database error on the catalog's own server that fails only that query.
 * Class 08 (its database connection is down) means the catalog is.
 */
const SERVER_SIDE_ERROR = /SQLSTATE\s*(?!08)[0-9A-Z]{5}/i;

/**
 * A catalog that types an argument stash-box sends as an enum (sort: DATE)
 * as a string instead: ThePornDB's stash-box endpoint does.
 */
const STRING_ARGUMENT_ERROR =
  /String cannot represent a non string value: ([A-Z][A-Z0-9_]*)/;
/** How many such values one query may need quoted before giving up. */
const MAX_STRING_ARGUMENT_RETRIES = 6;

/** The value the catalog wants as a string, from its error, if that's what it said. */
export function stringArgumentFrom(
  payload: StashdbGraphqlResponse,
): string | null {
  for (const error of payload.errors ?? []) {
    const match =
      typeof error?.message === 'string'
        ? STRING_ARGUMENT_ERROR.exec(error.message)
        : null;
    if (match) {
      return match[1];
    }
  }
  return null;
}

/** The query with each of these bare enum values written as a string. */
export function quoteArguments(
  query: string,
  values: ReadonlySet<string>,
): string {
  let quoted = query;
  for (const value of values) {
    quoted = quoted.replace(
      new RegExp(`(:\\s*)${value}\\b(?!")`, 'g'),
      `$1"${value}"`,
    );
  }
  return quoted;
}

/** True when the catalog answered, but its own database failed the query. */
export function isServerSideError(error: unknown): boolean {
  return error instanceof Error && SERVER_SIDE_ERROR.test(error.message);
}

/**
 * The total when the catalog couldn't count: what's been seen, plus one
 * more when this page was full (so "more" is still offered).
 */
export function estimatedTotal(
  page: number,
  perPage: number,
  onPage: number,
): number {
  return (page - 1) * perPage + onPage + (onPage >= perPage ? 1 : 0);
}

/**
 * Talks to a stash-box GraphQL API (StashDB, FansDB, ThePornDB): the request, readable
 * network errors, runtime-health reporting, and shared normalizers.
 */
export abstract class StashdbGraphqlClient {
  protected readonly logger = new Logger('StashdbAdapter');
  /** When each refusal (query and message) was last logged as a warning. */
  private readonly refusalsLogged = new Map<string, number>();
  /** Per catalog host: enum values it wants sent as strings. */
  private readonly stringArguments = new Map<string, Set<string>>();

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
      this.logRefusal(
        hostOf(this.resolveGraphqlEndpoint(config.baseUrl)),
        operationName(query),
        message,
      );
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

  /**
   * A search with a total count. When the catalog's own database fails it
   * (StashDB's search has been failing on the count: "SQLSTATE XX000"), the
   * same search is asked again without the count; the caller estimates it.
   */
  protected async executeCountedSearch(
    config: StashdbAdapterBaseConfig,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<StashdbGraphqlResponse> {
    try {
      return await this.executeQuery(config, query, variables);
    } catch (error) {
      const withoutCount = query.replace(/^\s*count\s*$/m, '');
      if (
        !(error instanceof BadGatewayException) ||
        !isServerSideError(error) ||
        withoutCount === query
      ) {
        throw error;
      }
      return this.executeQuery(config, withoutCount, variables);
    }
  }

  /** Said once every few minutes per query and message, not on every lookup. */
  private logRefusal(host: string, operation: string, message: string): void {
    const key = `${host}|${operation}|${message}`;
    const now = Date.now();
    const last = this.refusalsLogged.get(key);
    if (last !== undefined && now - last < REFUSAL_LOG_INTERVAL_MS) {
      this.logger.debug(
        `The catalog at ${host} refused ${operation} again: ${message}`,
      );
      return;
    }
    if (this.refusalsLogged.size > 100) {
      this.refusalsLogged.clear();
    }
    this.refusalsLogged.set(key, now);
    this.logger.warn(
      SERVER_SIDE_ERROR.test(message)
        ? `The catalog at ${host} had an error of its own answering ${operation} (on its server, not Stashboard's); other lookups carry on: ${message}`
        : `The catalog at ${host} refused ${operation}: ${message}`,
    );
  }

  /**
   * Sends the query. A catalog that wants one of stash-box's enum values as a
   * string gets it quoted, and is asked again; what it wanted is remembered,
   * so later queries go out right the first time.
   */
  protected async executeQueryRaw(
    config: StashdbAdapterBaseConfig,
    query: string,
    variables?: Record<string, unknown>,
    trackRuntimeHealth = true,
  ): Promise<StashdbGraphqlResponse> {
    const host = hostOf(this.resolveGraphqlEndpoint(config.baseUrl));
    const known = () => this.stringArguments.get(host) ?? new Set<string>();
    let sent = quoteArguments(query, known());
    let payload = await this.sendQuery(
      config,
      sent,
      variables,
      trackRuntimeHealth,
    );
    for (let tries = 0; tries < MAX_STRING_ARGUMENT_RETRIES; tries += 1) {
      const value = stringArgumentFrom(payload);
      if (!value) {
        break;
      }
      if (!known().has(value)) {
        this.stringArguments.set(host, new Set([...known(), value]));
        this.logger.debug(`The catalog at ${host} takes ${value} as a string.`);
      }
      // Another request may have learned it meanwhile: ask again whenever
      // what's known now changes this query.
      const next = quoteArguments(query, known());
      if (next === sent) {
        break;
      }
      sent = next;
      payload = await this.sendQuery(
        config,
        sent,
        variables,
        trackRuntimeHealth,
      );
    }
    return payload;
  }

  private async sendQuery(
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
