import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  IntegrationConfig,
  IntegrationStatus,
  IntegrationType,
  Prisma,
} from '@prisma/client';
import {
  StashAdapter,
  StashAdapterBaseConfig,
} from '../providers/stash/stash.adapter';
import {
  StashdbAdapter,
  StashdbAdapterBaseConfig,
} from '../providers/stashdb/stashdb.adapter';
import {
  WhisparrAdapter,
  WhisparrAdapterBaseConfig,
} from '../providers/whisparr/whisparr.adapter';
import { ProwlarrAdapter } from '../providers/prowlarr/prowlarr.adapter';
import { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import {
  CATALOG_PROVIDER_KEYS,
  type CatalogProviderIntegrationType,
  buildCatalogProviderSelectionConfig,
  configuredCatalogProviderTypeFromIntegrations,
  getCatalogProviderLabel,
  instanceCatalogProviderTypeFromIntegrations,
  isCatalogProviderIntegrationType,
} from '../providers/catalog/catalog-provider.util';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeHealthService } from '../runtime-health/runtime-health.service';
import { RuntimeHealthResponse } from '../runtime-health/runtime-health.types';
import { runtimeHealthServiceForIntegration } from './integration-runtime-health.util';
import { UpdateIntegrationDto } from './dto/update-integration.dto';

type PersistedIntegrationValues = {
  enabled: boolean;
  name: string | null;
  baseUrl: string | null;
  apiKey: string | null;
};

type PersistedIntegrationState = {
  status: IntegrationStatus;
  lastHealthyAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;
};

type TestedIntegrationConfig = IntegrationConfig & {
  status: Extract<IntegrationStatus, 'CONFIGURED' | 'ERROR'>;
};

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stashAdapter: StashAdapter,
    private readonly stashdbAdapter: StashdbAdapter,
    private readonly whisparrAdapter: WhisparrAdapter,
    private readonly runtimeHealthService: RuntimeHealthService,
    private readonly prowlarrAdapter: ProwlarrAdapter,
    private readonly sabnzbdAdapter: SabnzbdAdapter,
  ) {}

  findAll(): Promise<IntegrationConfig[]> {
    return this.prisma.integrationConfig.findMany({
      orderBy: { type: 'asc' },
    });
  }

  async upsert(
    type: IntegrationType,
    dto: UpdateIntegrationDto,
  ): Promise<IntegrationConfig> {
    const existing = await this.prisma.integrationConfig.findUnique({
      where: { type },
    });
    const isCatalogProvider = isCatalogProviderIntegrationType(type);
    const persistedValues = this.resolvePersistedValues(type, dto, existing);
    const configured = this.hasSavedConfig(type, persistedValues);
    const runtimeHealthInvalidated = this.runtimeHealthInvalidatedBySave(
      existing,
      persistedValues,
      configured,
    );

    const instanceProviderType = isCatalogProvider
      ? await this.getInstanceCatalogProviderType()
      : null;
    if (isCatalogProvider) {
      await this.assertCatalogProviderSaveAllowed(type, configured);
    }
    // The first catalog provider saved becomes this instance's provider. Once one
    // is chosen, the other can be added as an optional browse-only provider: it is
    // not marked as the instance provider and saving it never resets anything.
    const claimsInstance =
      isCatalogProvider &&
      (!instanceProviderType || instanceProviderType === type);
    const resetsOtherProviders = isCatalogProvider && !instanceProviderType;

    const healthState = this.resolveSavedHealthState(
      existing,
      persistedValues,
      configured,
    );
    const selectionConfig =
      claimsInstance && configured
        ? this.catalogProviderSelectionConfig()
        : undefined;
    const updateData = {
      ...persistedValues,
      ...healthState,
      ...(selectionConfig ? { config: selectionConfig } : {}),
    } satisfies Prisma.IntegrationConfigUpdateInput;
    const createData = {
      type,
      ...persistedValues,
      status: IntegrationStatus.NOT_CONFIGURED,
      lastHealthyAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
      ...(selectionConfig ? { config: selectionConfig } : {}),
    } satisfies Prisma.IntegrationConfigCreateInput;
    const upsertArgs = {
      where: { type },
      update: updateData,
      create: createData,
    } satisfies Prisma.IntegrationConfigUpsertArgs;

    if (resetsOtherProviders && configured) {
      const [, integration] = await this.prisma.$transaction([
        this.prisma.integrationConfig.updateMany({
          where: {
            type: {
              in: this.otherCatalogProviderTypes(type),
            },
          },
          data: this.resetPayload(),
        }),
        this.prisma.integrationConfig.upsert(upsertArgs),
      ]);

      if (runtimeHealthInvalidated) {
        await this.clearRuntimeHealth(type);
      }

      this.logger.log(
        `Saved ${integrationLabel(type)} settings (${integration.enabled ? 'on' : 'off'}); it is now the catalog for this instance.`,
      );
      return integration;
    }

    const integration = await this.prisma.integrationConfig.upsert(upsertArgs);

    if (runtimeHealthInvalidated) {
      await this.clearRuntimeHealth(type);
    }

    this.logger.log(
      `Saved ${integrationLabel(type)} settings (${integration.enabled ? 'on' : 'off'}, ${configured ? 'configured' : 'not configured'}).`,
    );
    return integration;
  }

  async findOne(type: IntegrationType): Promise<IntegrationConfig> {
    const integration = await this.prisma.integrationConfig.findUnique({
      where: { type },
    });

    if (!integration) {
      throw new NotFoundException(`Integration ${type} not found`);
    }

    return integration;
  }

  async testIntegration(
    type: IntegrationType,
    dto: UpdateIntegrationDto,
  ): Promise<TestedIntegrationConfig> {
    const isCatalogProvider = isCatalogProviderIntegrationType(type);
    const instanceProviderType = isCatalogProvider
      ? await this.getInstanceCatalogProviderType()
      : null;
    const claimsInstance =
      isCatalogProvider &&
      (!instanceProviderType || instanceProviderType === type);
    const resetsOtherProviders = isCatalogProvider && !instanceProviderType;

    const existing = await this.prisma.integrationConfig.findUnique({
      where: { type },
    });
    const persistedValues = this.resolvePersistedValues(type, dto, existing);
    const selectionConfig = claimsInstance
      ? this.catalogProviderSelectionConfig()
      : undefined;
    const configChanged = this.connectionDetailsChanged(
      existing,
      persistedValues,
    );
    const runtimeService = runtimeHealthServiceForIntegration(type);
    this.logger.debug(`Testing the connection to ${integrationLabel(type)}.`);

    try {
      const config = this.resolveTestConfig(persistedValues);

      switch (type) {
        case IntegrationType.STASH:
          await this.stashAdapter.testConnection(config);
          break;
        case IntegrationType.STASHDB:
        case IntegrationType.FANSDB:
          await this.stashdbAdapter.testConnection(config);
          break;
        case IntegrationType.WHISPARR:
          await this.whisparrAdapter.testConnection(config);
          break;
        case IntegrationType.PROWLARR:
          await this.prowlarrAdapter.testConnection(config);
          break;
        case IntegrationType.SABNZBD:
          await this.testSabnzbd(config);
          break;
      }

      const now = new Date();
      const integration = (await this.persistIntegration(
        type,
        {
          ...persistedValues,
          status: IntegrationStatus.CONFIGURED,
          lastHealthyAt: now,
          lastErrorAt: null,
          lastErrorMessage: null,
        },
        selectionConfig,
        resetsOtherProviders,
      )) as TestedIntegrationConfig;
      if (runtimeService) {
        await this.runtimeHealthService.recordManualRecovery(runtimeService);
      }
      this.logger.log(
        `Connection test to ${integrationLabel(type)} passed; settings saved.`,
      );
      return integration;
    } catch (error) {
      const message = this.resolveErrorMessage(error);
      this.logger.warn(
        `Connection test to ${integrationLabel(type)} failed: ${message}`,
      );
      const integration = (await this.persistIntegration(
        type,
        {
          ...persistedValues,
          status: IntegrationStatus.ERROR,
          lastHealthyAt:
            configChanged || !existing?.lastHealthyAt
              ? null
              : existing.lastHealthyAt,
          lastErrorAt: new Date(),
          lastErrorMessage: message,
        },
        selectionConfig,
        resetsOtherProviders,
      )) as TestedIntegrationConfig;

      if (configChanged && runtimeService) {
        await this.runtimeHealthService.clearService(runtimeService);
      }

      return integration;
    }
  }

  async reset(type: IntegrationType): Promise<IntegrationConfig> {
    const instanceProviderType = isCatalogProviderIntegrationType(type)
      ? await this.getInstanceCatalogProviderType()
      : null;
    // Resetting the instance provider clears the whole catalog choice; resetting
    // an optional browse-only provider only removes that provider.
    if (
      isCatalogProviderIntegrationType(type) &&
      (!instanceProviderType || instanceProviderType === type)
    ) {
      const resetRecords = await this.prisma.$transaction(
        CATALOG_PROVIDER_KEYS.map((providerType) =>
          this.prisma.integrationConfig.upsert({
            where: { type: providerType },
            update: this.resetPayload(),
            create: {
              type: providerType,
              ...this.resetPayload(),
            },
          }),
        ),
      );

      const resetIntegration = resetRecords.find(
        (integration) => integration.type === type,
      );
      if (resetIntegration) {
        await this.clearRuntimeHealth(type);
        this.logger.log(
          `Reset ${integrationLabel(type)}, and the catalog choice with it.`,
        );
        return resetIntegration;
      }
    }

    const integration = await this.prisma.integrationConfig.upsert({
      where: { type },
      update: this.resetPayload(),
      create: {
        type,
        ...this.resetPayload(),
      },
    });

    await this.clearRuntimeHealth(type);

    this.logger.log(`Reset ${integrationLabel(type)}.`);
    return integration;
  }

  async resetAll(): Promise<IntegrationConfig[]> {
    const types = Object.values(IntegrationType);

    const resetRecords = await this.prisma.$transaction(
      types.map((type) =>
        this.prisma.integrationConfig.upsert({
          where: { type },
          update: this.resetPayload(),
          create: {
            type,
            ...this.resetPayload(),
          },
        }),
      ),
    );

    await this.runtimeHealthService.clearAllServices();
    this.logger.log(`Reset all ${resetRecords.length} integrations.`);

    return resetRecords.sort((a, b) => a.type.localeCompare(b.type));
  }

  async refreshRuntimeHealth(): Promise<RuntimeHealthResponse> {
    const integrations = await this.findAll();
    const activeCatalogProviderType =
      (await this.getInstanceCatalogProviderType()) ??
      configuredCatalogProviderTypeFromIntegrations(integrations);
    const probes = integrations
      .filter((integration) =>
        this.shouldProbeRuntimeHealth(integration, activeCatalogProviderType),
      )
      .map((integration) =>
        this.probeRuntimeHealthForIntegration(
          integration.type,
          this.resolveTestConfig(integration),
        ),
      );

    this.logger.debug(
      `Checking ${probes.length} integration(s) are reachable.`,
    );
    await Promise.allSettled(probes);

    return this.runtimeHealthService.getSummary();
  }

  private resetPayload() {
    return {
      enabled: true,
      name: null,
      baseUrl: null,
      apiKey: null,
      config: Prisma.JsonNull,
      status: IntegrationStatus.NOT_CONFIGURED,
      lastHealthyAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    };
  }

  private async assertCatalogProviderSaveAllowed(
    type: CatalogProviderIntegrationType,
    nextConfigured: boolean,
  ): Promise<void> {
    const configuredType = await this.getInstanceCatalogProviderType();

    // No provider chosen yet, or saving an optional browse-only provider: allowed.
    if (!configuredType || configuredType !== type) {
      return;
    }

    if (!nextConfigured) {
      throw new ConflictException(
        `This Stashboard instance is configured for ${getCatalogProviderLabel(type)}. Reset catalog setup before clearing or changing the catalog provider.`,
      );
    }
  }

  private otherCatalogProviderTypes(
    type: CatalogProviderIntegrationType,
  ): CatalogProviderIntegrationType[] {
    return CATALOG_PROVIDER_KEYS.filter(
      (providerType) => providerType !== type,
    );
  }

  private resolveTestConfig(
    values: PersistedIntegrationValues,
  ):
    | StashAdapterBaseConfig
    | StashdbAdapterBaseConfig
    | WhisparrAdapterBaseConfig {
    const baseUrl = values.baseUrl;
    const apiKey = values.apiKey;

    if (!baseUrl) {
      throw new Error('Base URL is required to test this integration.');
    }

    return {
      baseUrl,
      apiKey,
    };
  }

  private resolvePersistedValues(
    type: IntegrationType,
    dto: UpdateIntegrationDto,
    existing: IntegrationConfig | null,
  ): PersistedIntegrationValues {
    return {
      enabled: isCatalogProviderIntegrationType(type)
        ? true
        : (dto.enabled ?? existing?.enabled ?? true),
      name: this.mergeNormalizedInput(existing?.name, dto.name),
      baseUrl: this.mergeNormalizedInput(existing?.baseUrl, dto.baseUrl),
      apiKey: dto.clearApiKey
        ? this.normalizeInput(dto.apiKey)
        : this.mergeNormalizedInput(existing?.apiKey, dto.apiKey),
    };
  }

  private resolveSavedHealthState(
    existing: IntegrationConfig | null,
    values: PersistedIntegrationValues,
    configured: boolean,
  ): PersistedIntegrationState {
    if (
      !configured ||
      !existing ||
      this.connectionDetailsChanged(existing, values)
    ) {
      return {
        status: IntegrationStatus.NOT_CONFIGURED,
        lastHealthyAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      };
    }

    return {
      status: existing.status,
      lastHealthyAt: existing.lastHealthyAt,
      lastErrorAt: existing.lastErrorAt,
      lastErrorMessage: existing.lastErrorMessage,
    };
  }

  private async persistIntegration(
    type: IntegrationType,
    state: PersistedIntegrationValues & PersistedIntegrationState,
    selectionConfig?: Prisma.InputJsonValue,
    resetsOtherProviders = false,
  ): Promise<IntegrationConfig> {
    const updateData = {
      ...state,
      ...(selectionConfig ? { config: selectionConfig } : {}),
    } satisfies Prisma.IntegrationConfigUpdateInput;
    const createData = {
      type,
      ...state,
      ...(selectionConfig ? { config: selectionConfig } : {}),
    } satisfies Prisma.IntegrationConfigCreateInput;
    const upsertArgs = {
      where: { type },
      update: updateData,
      create: createData,
    } satisfies Prisma.IntegrationConfigUpsertArgs;

    if (
      resetsOtherProviders &&
      isCatalogProviderIntegrationType(type) &&
      this.hasSavedConfig(type, state)
    ) {
      const [, integration] = await this.prisma.$transaction([
        this.prisma.integrationConfig.updateMany({
          where: {
            type: {
              in: this.otherCatalogProviderTypes(type),
            },
          },
          data: this.resetPayload(),
        }),
        this.prisma.integrationConfig.upsert(upsertArgs),
      ]);

      return integration;
    }

    return this.prisma.integrationConfig.upsert(upsertArgs);
  }

  private hasSavedConfig(
    type: IntegrationType,
    values: Pick<PersistedIntegrationValues, 'name' | 'baseUrl' | 'apiKey'>,
  ): boolean {
    if (isCatalogProviderIntegrationType(type)) {
      return !!values.baseUrl;
    }

    return !!values.baseUrl || !!values.apiKey || !!values.name;
  }

  private connectionDetailsChanged(
    existing: IntegrationConfig | null,
    values: Pick<PersistedIntegrationValues, 'baseUrl' | 'apiKey'>,
  ): boolean {
    return (
      (existing?.baseUrl ?? null) !== values.baseUrl ||
      (existing?.apiKey ?? null) !== values.apiKey
    );
  }

  private runtimeHealthInvalidatedBySave(
    existing: IntegrationConfig | null,
    values: Pick<PersistedIntegrationValues, 'baseUrl' | 'apiKey'>,
    configured: boolean,
  ): boolean {
    return !configured || this.connectionDetailsChanged(existing, values);
  }

  private async clearRuntimeHealth(type: IntegrationType): Promise<void> {
    const service = runtimeHealthServiceForIntegration(type);
    if (service) {
      await this.runtimeHealthService.clearService(service);
    }
  }

  private shouldProbeRuntimeHealth(
    integration: IntegrationConfig,
    activeCatalogProviderType: CatalogProviderIntegrationType | null,
  ): boolean {
    if (
      !integration.enabled ||
      integration.status !== IntegrationStatus.CONFIGURED ||
      !integration.baseUrl?.trim() ||
      // Optional: never part of the runtime health banner.
      !runtimeHealthServiceForIntegration(integration.type)
    ) {
      return false;
    }

    if (
      isCatalogProviderIntegrationType(integration.type) &&
      integration.type !== activeCatalogProviderType
    ) {
      return false;
    }

    return true;
  }

  private async probeRuntimeHealthForIntegration(
    type: IntegrationType,
    config:
      | StashAdapterBaseConfig
      | StashdbAdapterBaseConfig
      | WhisparrAdapterBaseConfig,
  ): Promise<void> {
    switch (type) {
      case IntegrationType.STASH:
        await this.stashAdapter.probeConnection(config);
        return;
      case IntegrationType.STASHDB:
      case IntegrationType.FANSDB:
        await this.stashdbAdapter.probeConnection(config);
        return;
      case IntegrationType.WHISPARR:
        await this.whisparrAdapter.probeConnection(config);
        return;
      case IntegrationType.PROWLARR:
      case IntegrationType.SABNZBD:
        return;
    }
  }

  /**
   * SABnzbd answers, and has the category Finished downloads sends to
   * (made in SABnzbd under Settings → Categories).
   */
  private async testSabnzbd(config: {
    baseUrl: string;
    apiKey?: string | null;
  }): Promise<void> {
    await this.sabnzbdAdapter.testConnection(config);
    const settings = await this.prisma.downloadHandoffSettings
      .findUnique({ where: { key: 'GLOBAL' } })
      .catch((error: unknown) => {
        this.logger.debug(
          `Couldn't read Finished downloads settings; checking the default category: ${this.resolveErrorMessage(error)}`,
        );
        return null;
      });
    const category = settings?.category?.trim() || 'stashboard';
    const categories = await this.sabnzbdAdapter.listCategories(config);
    if (
      !categories.some(
        (entry) => entry.toLowerCase() === category.toLowerCase(),
      )
    ) {
      throw new Error(
        `SABnzbd has no “${category}” category. Add it in SABnzbd under Settings → Categories, with its own folder.`,
      );
    }
  }

  private mergeNormalizedInput(
    existingValue: string | null | undefined,
    nextValue: string | null | undefined,
  ): string | null {
    return this.normalizeInput(nextValue) ?? existingValue ?? null;
  }

  private async getInstanceCatalogProviderType(): Promise<CatalogProviderIntegrationType | null> {
    const catalogIntegrations = await this.prisma.integrationConfig.findMany({
      where: {
        type: {
          in: [...CATALOG_PROVIDER_KEYS],
        },
      },
      orderBy: { type: 'asc' },
    });

    return instanceCatalogProviderTypeFromIntegrations(catalogIntegrations);
  }

  private catalogProviderSelectionConfig(): Prisma.InputJsonValue {
    return buildCatalogProviderSelectionConfig();
  }

  private normalizeInput(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private resolveErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return 'Integration test failed.';
  }
}

const INTEGRATION_LABELS: Record<IntegrationType, string> = {
  STASH: 'Stash',
  STASHDB: 'StashDB',
  FANSDB: 'FansDB',
  WHISPARR: 'Whisparr',
  PROWLARR: 'Prowlarr',
  SABNZBD: 'SABnzbd',
};

/** "Whisparr", not "WHISPARR", for log lines. */
function integrationLabel(type: IntegrationType): string {
  return INTEGRATION_LABELS[type] ?? type;
}
