import { Injectable, Logger } from '@nestjs/common';
import {
  RuntimeHealthServiceKey,
  RuntimeHealthStatus,
  RuntimeIntegrationHealth,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CATALOG_PROVIDER_KEYS,
  configuredCatalogProviderTypeFromIntegrations,
  instanceCatalogProviderTypeFromIntegrations,
} from '../providers/catalog/catalog-provider.util';
import {
  RuntimeHealthResponse,
  RuntimeHealthServiceSummary,
} from './runtime-health.types';

interface RuntimeHealthSnapshot {
  exists: boolean;
  record: RuntimeIntegrationHealth;
}

@Injectable()
export class RuntimeHealthService {
  static readonly FAILURE_THRESHOLD = 2;
  private static readonly SERVICES = [
    RuntimeHealthServiceKey.CATALOG,
    RuntimeHealthServiceKey.STASH,
    RuntimeHealthServiceKey.WHISPARR,
  ] as const;
  private static readonly DEGRADED_FAILURE_THROTTLE_MS = 30_000;
  /** How long the main catalog's address is trusted before it's read again. */
  private static readonly MAIN_CATALOG_TTL_MS = 30_000;

  private readonly logger = new Logger(RuntimeHealthService.name);
  private readonly cache = new Map<
    RuntimeHealthServiceKey,
    RuntimeIntegrationHealth
  >();
  private loadedAll = false;
  private mainCatalog: { host: string | null; at: number } | null = null;
  /** Bumped when the catalog's settings change: a read begun before is stale. */
  private catalogGeneration = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Whether a catalog address is this instance's catalog (StashDB, or
   * FansDB when that's the one chosen). Only that one counts for the
   * catalog's health: browsing the other catalog, or matching against it,
   * says nothing about whether the main one is up. When the main one isn't
   * known, every catalog counts, as before.
   */
  async isMainCatalog(endpoint: string): Promise<boolean> {
    const now = Date.now();
    let main = this.mainCatalog;
    if (!main || now - main.at > RuntimeHealthService.MAIN_CATALOG_TTL_MS) {
      const generation = this.catalogGeneration;
      const rows = await this.prisma.integrationConfig.findMany({
        where: { type: { in: [...CATALOG_PROVIDER_KEYS] } },
      });
      const type =
        instanceCatalogProviderTypeFromIntegrations(rows) ??
        configuredCatalogProviderTypeFromIntegrations(rows);
      const baseUrl = rows.find((row) => row.type === type)?.baseUrl;
      main = { host: baseUrl ? hostOf(baseUrl) : null, at: now };
      // Kept only if the settings didn't change while they were read.
      if (generation === this.catalogGeneration) {
        this.mainCatalog = main;
      }
    }
    return main.host === null || main.host === hostOf(endpoint);
  }

  async getSummary(): Promise<RuntimeHealthResponse> {
    await this.ensureAllLoaded();

    const services = {
      catalog: this.toSummary(RuntimeHealthServiceKey.CATALOG),
      stash: this.toSummary(RuntimeHealthServiceKey.STASH),
      whisparr: this.toSummary(RuntimeHealthServiceKey.WHISPARR),
    };

    return {
      degraded: Object.values(services).some((service) => service.degraded),
      failureThreshold: RuntimeHealthService.FAILURE_THRESHOLD,
      services,
    };
  }

  async recordFailure(
    service: RuntimeHealthServiceKey,
    error: unknown,
  ): Promise<void> {
    const current = await this.getSnapshot(service);
    const now = new Date();
    const message = this.resolveErrorMessage(error);

    if (
      current.exists &&
      current.record.status === RuntimeHealthStatus.DEGRADED &&
      current.record.lastFailureAt &&
      current.record.lastErrorMessage === message &&
      now.getTime() - current.record.lastFailureAt.getTime() <
        RuntimeHealthService.DEGRADED_FAILURE_THROTTLE_MS
    ) {
      return;
    }

    const consecutiveFailures = current.record.consecutiveFailures + 1;
    const status =
      consecutiveFailures >= RuntimeHealthService.FAILURE_THRESHOLD
        ? RuntimeHealthStatus.DEGRADED
        : RuntimeHealthStatus.HEALTHY;

    const persisted = await this.prisma.runtimeIntegrationHealth.upsert({
      where: { service },
      create: {
        service,
        status,
        consecutiveFailures,
        lastFailureAt: now,
        lastErrorMessage: message,
        degradedAt: status === RuntimeHealthStatus.DEGRADED ? now : null,
      },
      update: {
        status,
        consecutiveFailures,
        lastFailureAt: now,
        lastErrorMessage: message,
        degradedAt:
          status === RuntimeHealthStatus.DEGRADED
            ? (current.record.degradedAt ?? now)
            : null,
      },
    });

    this.cache.set(service, persisted);
    if (
      status === RuntimeHealthStatus.DEGRADED &&
      current.record.status !== RuntimeHealthStatus.DEGRADED
    ) {
      this.logger.warn(
        `${serviceLabel(service)} looks down after ${consecutiveFailures} failures in a row: ${message}`,
      );
    }
  }

  async recordSuccess(service: RuntimeHealthServiceKey): Promise<void> {
    const current = await this.getSnapshot(service);
    if (
      !current.exists ||
      (current.record.status === RuntimeHealthStatus.HEALTHY &&
        current.record.consecutiveFailures === 0)
    ) {
      return;
    }

    const persisted = await this.prisma.runtimeIntegrationHealth.update({
      where: { service },
      data: {
        status: RuntimeHealthStatus.HEALTHY,
        consecutiveFailures: 0,
        lastHealthyAt: new Date(),
        degradedAt: null,
      },
    });

    this.cache.set(service, persisted);
    if (current.record.status === RuntimeHealthStatus.DEGRADED) {
      this.logger.log(`${serviceLabel(service)} is answering again.`);
    }
  }

  async recordManualRecovery(service: RuntimeHealthServiceKey): Promise<void> {
    const current = await this.getSnapshot(service);
    const now = new Date();
    const persisted = await this.prisma.runtimeIntegrationHealth.upsert({
      where: { service },
      create: {
        service,
        status: RuntimeHealthStatus.HEALTHY,
        consecutiveFailures: 0,
        lastHealthyAt: now,
        lastFailureAt: null,
        lastErrorMessage: null,
        degradedAt: null,
      },
      update: {
        status: RuntimeHealthStatus.HEALTHY,
        consecutiveFailures: 0,
        lastHealthyAt: now,
        lastFailureAt: current.record.lastFailureAt,
        lastErrorMessage: current.record.lastErrorMessage,
        degradedAt: null,
      },
    });

    this.cache.set(service, persisted);
  }

  async clearService(service: RuntimeHealthServiceKey): Promise<void> {
    await this.prisma.runtimeIntegrationHealth.deleteMany({
      where: { service },
    });
    this.cache.delete(service);
    if (service === RuntimeHealthServiceKey.CATALOG) {
      // Cleared when the catalog's settings change: read them again.
      this.forgetMainCatalog();
    }
  }

  async clearAllServices(): Promise<void> {
    await this.prisma.runtimeIntegrationHealth.deleteMany({
      where: {
        service: {
          in: [...RuntimeHealthService.SERVICES],
        },
      },
    });

    for (const service of RuntimeHealthService.SERVICES) {
      this.cache.delete(service);
    }
    this.forgetMainCatalog();
  }

  private forgetMainCatalog(): void {
    this.mainCatalog = null;
    this.catalogGeneration += 1;
  }

  private async getSnapshot(
    service: RuntimeHealthServiceKey,
  ): Promise<RuntimeHealthSnapshot> {
    await this.ensureLoaded(service);

    const cached = this.cache.get(service);
    if (cached) {
      return {
        exists: true,
        record: cached,
      };
    }

    return {
      exists: false,
      record: this.buildDefaultRecord(service),
    };
  }

  private async ensureLoaded(service: RuntimeHealthServiceKey): Promise<void> {
    if (this.cache.has(service) || this.loadedAll) {
      return;
    }

    const record = await this.prisma.runtimeIntegrationHealth.findUnique({
      where: { service },
    });
    if (record) {
      this.cache.set(service, record);
    }
  }

  private async ensureAllLoaded(): Promise<void> {
    if (this.loadedAll) {
      return;
    }

    const records = await this.prisma.runtimeIntegrationHealth.findMany();
    for (const record of records) {
      this.cache.set(record.service, record);
    }

    this.loadedAll = true;
  }

  private toSummary(
    service: RuntimeHealthServiceKey,
  ): RuntimeHealthServiceSummary {
    const record = this.cache.get(service) ?? this.buildDefaultRecord(service);

    return {
      service,
      status: record.status,
      degraded: record.status === RuntimeHealthStatus.DEGRADED,
      consecutiveFailures: record.consecutiveFailures,
      lastHealthyAt: record.lastHealthyAt?.toISOString() ?? null,
      lastFailureAt: record.lastFailureAt?.toISOString() ?? null,
      lastErrorMessage: record.lastErrorMessage,
      degradedAt: record.degradedAt?.toISOString() ?? null,
    };
  }

  private buildDefaultRecord(
    service: RuntimeHealthServiceKey,
  ): RuntimeIntegrationHealth {
    const now = new Date(0);

    return {
      service,
      status: RuntimeHealthStatus.HEALTHY,
      consecutiveFailures: 0,
      lastHealthyAt: null,
      lastFailureAt: null,
      lastErrorMessage: null,
      degradedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private resolveErrorMessage(error: unknown): string {
    if (typeof error === 'string' && error.trim().length > 0) {
      return error.trim();
    }

    if (
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string' &&
      error.message.trim().length > 0
    ) {
      return error.message.trim();
    }

    this.logger.warn(
      'Runtime health recorded a failure without an error message.',
    );
    return 'Runtime provider request failed.';
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function serviceLabel(service: RuntimeHealthServiceKey): string {
  switch (service) {
    case RuntimeHealthServiceKey.CATALOG:
      return 'The catalog (StashDB/FansDB)';
    case RuntimeHealthServiceKey.STASH:
      return 'Stash';
    case RuntimeHealthServiceKey.WHISPARR:
      return 'Whisparr';
    default:
      return String(service);
  }
}
