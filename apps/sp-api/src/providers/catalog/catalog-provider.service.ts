import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationStatus } from '@prisma/client';
import { IntegrationsService } from '../../integrations/integrations.service';
import {
  CATALOG_PROVIDER_KEYS,
  type CatalogProviderIntegrationType,
  type CatalogProviderKey,
  catalogProviderKeyFromIntegrationType,
  instanceCatalogProviderTypeFromIntegrations,
  isCatalogProviderReady,
  getCatalogProviderLabel,
} from './catalog-provider.util';
import { getRequestedCatalogProvider } from './catalog-provider-context';

export interface CatalogBrowseProviders {
  /** The provider this instance is locked to; requests always go through it. */
  instance: CatalogProviderKey | null;
  /** Providers that are ready to browse, instance provider first. */
  available: Array<{
    key: CatalogProviderKey;
    label: string;
    browseOnly: boolean;
  }>;
}

export interface ConfiguredCatalogProvider {
  integrationType: CatalogProviderIntegrationType;
  providerKey: CatalogProviderKey;
  label: string;
  baseUrl: string;
  apiKey: string | null;
}

@Injectable()
export class CatalogProviderService {
  private readonly logger = new Logger(CatalogProviderService.name);

  constructor(private readonly integrationsService: IntegrationsService) {}

  async getInstanceCatalogProviderType(): Promise<CatalogProviderIntegrationType | null> {
    const integrations = await this.integrationsService.findAll();
    return instanceCatalogProviderTypeFromIntegrations(
      integrations.map((integration) => ({
        type: integration.type,
        enabled: integration.enabled,
        status: integration.status,
        baseUrl: integration.baseUrl,
        config: integration.config,
      })),
    );
  }

  /**
   * The provider a browse page asked for, when it is a ready secondary provider.
   * Null means "use the instance provider".
   */
  private async getRequestedBrowseProviderType(): Promise<CatalogProviderIntegrationType | null> {
    const requested = getRequestedCatalogProvider();
    if (!requested) {
      return null;
    }

    const instanceType = await this.getInstanceCatalogProviderType();
    if (!instanceType || requested === instanceType) {
      return null;
    }

    try {
      const integration = await this.integrationsService.findOne(requested);
      return isCatalogProviderReady(integration) ? requested : null;
    } catch {
      return null;
    }
  }

  /** True when this request is browsing a secondary provider; its scenes can't be requested. */
  async isBrowseOnlyRequest(): Promise<boolean> {
    return (await this.getRequestedBrowseProviderType()) !== null;
  }

  async getBrowseProviders(): Promise<CatalogBrowseProviders> {
    const instance = await this.getInstanceCatalogProviderType();
    const integrations = await this.integrationsService.findAll();
    const ready = new Set(
      integrations
        .filter((integration) => isCatalogProviderReady(integration))
        .map((integration) => integration.type as string),
    );

    const available = CATALOG_PROVIDER_KEYS.filter((key) => ready.has(key))
      .sort((a, b) => (a === instance ? -1 : b === instance ? 1 : 0))
      .map((key) => ({
        key,
        label: getCatalogProviderLabel(key),
        browseOnly: key !== instance,
      }));

    return { instance, available };
  }

  /**
   * Loads one scene, performer or studio by id. If the chosen provider doesn't
   * have it, the other ready provider is tried, so a link still works when the
   * page was reloaded without its provider context. Stash-box ids are UUIDs, so
   * an id never matches the wrong item in the other catalog.
   */
  async withDetailFallback<T>(
    load: (provider: ConfiguredCatalogProvider) => Promise<T>,
  ): Promise<{
    value: T;
    provider: ConfiguredCatalogProvider;
    browseOnly: boolean;
  }> {
    const instanceType = await this.getInstanceCatalogProviderType();
    const primary = await this.getConfiguredCatalogProvider();

    try {
      return {
        value: await load(primary),
        provider: primary,
        browseOnly: primary.integrationType !== instanceType,
      };
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        throw error;
      }

      const { available } = await this.getBrowseProviders();
      for (const option of available) {
        if (option.key === primary.providerKey) {
          continue;
        }

        let fallback: ConfiguredCatalogProvider;
        try {
          fallback = await this.resolveConfiguredCatalogProvider(option.key);
        } catch {
          continue;
        }

        this.logger.debug(
          `Not found in ${primary.label}; trying ${fallback.label}.`,
        );
        try {
          return {
            value: await load(fallback),
            provider: fallback,
            browseOnly: fallback.integrationType !== instanceType,
          };
        } catch (fallbackError) {
          if (!(fallbackError instanceof NotFoundException)) {
            throw fallbackError;
          }
        }
      }

      throw error;
    }
  }

  /** The instance's own provider, ignoring any browse-page choice. Use for requests. */
  async getInstanceCatalogProvider(): Promise<ConfiguredCatalogProvider> {
    return this.resolveConfiguredCatalogProvider(
      await this.getInstanceCatalogProviderType(),
    );
  }

  async getConfiguredCatalogProviderType(): Promise<CatalogProviderIntegrationType | null> {
    const requestedType = await this.getRequestedBrowseProviderType();
    if (requestedType) {
      return requestedType;
    }

    const selectedType = await this.getInstanceCatalogProviderType();
    if (!selectedType) {
      return null;
    }

    try {
      const integration = await this.integrationsService.findOne(selectedType);

      return isCatalogProviderReady(integration) ? selectedType : null;
    } catch {
      return null;
    }
  }

  async getConfiguredCatalogProviderOrNull(): Promise<ConfiguredCatalogProvider | null> {
    const selectedType = await this.getConfiguredCatalogProviderType();
    if (!selectedType) {
      return null;
    }

    try {
      const integration = await this.integrationsService.findOne(selectedType);

      if (integration.status !== IntegrationStatus.CONFIGURED) {
        return null;
      }

      const baseUrl = integration.baseUrl?.trim();
      if (!baseUrl) {
        return null;
      }

      return {
        integrationType: selectedType,
        providerKey: catalogProviderKeyFromIntegrationType(selectedType),
        label: getCatalogProviderLabel(selectedType),
        baseUrl,
        apiKey: integration.apiKey,
      };
    } catch {
      return null;
    }
  }

  async getConfiguredCatalogProvider(): Promise<ConfiguredCatalogProvider> {
    const selectedType =
      (await this.getRequestedBrowseProviderType()) ??
      (await this.getInstanceCatalogProviderType());
    return this.resolveConfiguredCatalogProvider(selectedType);
  }

  private async resolveConfiguredCatalogProvider(
    selectedType: CatalogProviderIntegrationType | null,
  ): Promise<ConfiguredCatalogProvider> {
    if (!selectedType) {
      throw new ConflictException(
        'No catalog provider has been chosen for this Stashboard instance.',
      );
    }

    const integration = await this.integrationsService.findOne(selectedType);
    const label = getCatalogProviderLabel(selectedType);
    const baseUrl = integration.baseUrl?.trim();

    if (
      integration.status !== IntegrationStatus.CONFIGURED ||
      !integration.enabled ||
      !integration.lastHealthyAt
    ) {
      throw new ConflictException(
        `${label} catalog provider is not configured.`,
      );
    }

    if (!baseUrl) {
      throw new BadRequestException(
        `${label} catalog provider is missing a base URL.`,
      );
    }

    return {
      integrationType: selectedType,
      providerKey: catalogProviderKeyFromIntegrationType(selectedType),
      label,
      baseUrl,
      apiKey: integration.apiKey,
    };
  }
}
