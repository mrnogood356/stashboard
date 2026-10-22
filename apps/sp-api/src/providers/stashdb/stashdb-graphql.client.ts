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
  type StashdbAdapterBaseConfig,
  type StashdbGraphqlResponse,
  type StashdbSceneImage,
} from './stashdb.types';

/**
 * Talks to a stash-box GraphQL API (StashDB, FansDB): the request, readable
 * network errors, runtime-health reporting, and shared normalizers.
 */
export abstract class StashdbGraphqlClient {
  protected readonly logger = new Logger('StashdbAdapter');

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
      this.logger.warn(
        `The catalog refused ${operationName(query)}: ${message}`,
      );
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

    let response: Response;
    try {
      response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables,
        }),
      });
    } catch (error) {
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
      if (trackRuntimeHealth) {
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
