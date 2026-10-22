import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { IntegrationsService } from '../../integrations/integrations.service';
import { buildCatalogProviderSelectionConfig } from './catalog-provider.util';
import { CatalogProviderService } from './catalog-provider.service';
import { runWithRequestedCatalogProvider } from './catalog-provider-context';

describe('CatalogProviderService', () => {
  const integrationsService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
  } as unknown as IntegrationsService;

  let service: CatalogProviderService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CatalogProviderService(integrationsService);
  });

  it('keeps instance catalog identity when the chosen provider is in ERROR', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.ERROR,
        baseUrl: 'http://fansdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.NOT_CONFIGURED,
        baseUrl: null,
        config: null,
      },
    ]);
    integrationsService.findOne = jest.fn().mockResolvedValue({
      type: IntegrationType.FANSDB,
      enabled: true,
      status: IntegrationStatus.ERROR,
      baseUrl: 'http://fansdb.local/graphql',
      apiKey: 'fansdb-key',
    });

    await expect(service.getInstanceCatalogProviderType()).resolves.toBe(
      'FANSDB',
    );
    await expect(
      service.getConfiguredCatalogProviderType(),
    ).resolves.toBeNull();
  });

  it('resolves STASHDB as the configured catalog provider', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stashdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.NOT_CONFIGURED,
        baseUrl: null,
        config: null,
      },
    ]);
    integrationsService.findOne = jest.fn().mockResolvedValue({
      type: IntegrationType.STASHDB,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: 'stashdb-key',
      lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    await expect(service.getConfiguredCatalogProvider()).resolves.toEqual({
      integrationType: 'STASHDB',
      providerKey: 'STASHDB',
      label: 'StashDB',
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: 'stashdb-key',
    });
  });

  it('keeps using the enabled configured provider in a legacy dual-config state', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: false,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stashdb.local/graphql',
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.local/graphql',
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    ]);
    integrationsService.findOne = jest.fn().mockResolvedValue({
      type: IntegrationType.FANSDB,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://fansdb.local/graphql',
      apiKey: 'fansdb-key',
      lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    await expect(service.getConfiguredCatalogProvider()).resolves.toEqual({
      integrationType: 'FANSDB',
      providerKey: 'FANSDB',
      label: 'FansDB',
      baseUrl: 'http://fansdb.local/graphql',
      apiKey: 'fansdb-key',
    });
  });

  it('throws when the configured catalog provider is missing a base URL', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    ]);
    integrationsService.findOne = jest.fn().mockResolvedValue({
      type: IntegrationType.FANSDB,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: '   ',
      apiKey: null,
      lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
    });

    await expect(service.getConfiguredCatalogProvider()).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws when no catalog provider is configured', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.NOT_CONFIGURED,
        baseUrl: null,
        config: null,
      },
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.NOT_CONFIGURED,
        baseUrl: null,
        config: null,
      },
    ]);

    await expect(service.getConfiguredCatalogProvider()).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('throws when a chosen catalog provider has never tested healthy', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stashdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
    ]);
    integrationsService.findOne = jest.fn().mockResolvedValue({
      type: IntegrationType.STASHDB,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: 'stashdb-key',
      lastHealthyAt: null,
    });

    await expect(service.getConfiguredCatalogProvider()).rejects.toThrow(
      'StashDB catalog provider is not configured.',
    );
  });

  it('throws when a chosen catalog provider is unhealthy', async () => {
    integrationsService.findAll = jest.fn().mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.ERROR,
        baseUrl: 'http://stashdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
    ]);
    integrationsService.findOne = jest.fn().mockResolvedValue({
      type: IntegrationType.STASHDB,
      enabled: true,
      status: IntegrationStatus.ERROR,
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: 'stashdb-key',
    });

    await expect(service.getConfiguredCatalogProvider()).rejects.toThrow(
      'StashDB catalog provider is not configured.',
    );
  });

  describe('browsing a secondary provider', () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const stashdb = {
      type: IntegrationType.STASHDB,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: 'stashdb-key',
      lastHealthyAt: now,
      config: buildCatalogProviderSelectionConfig(),
    };
    const fansdb = {
      type: IntegrationType.FANSDB,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://fansdb.local/graphql',
      apiKey: 'fansdb-key',
      lastHealthyAt: now,
      config: null,
    };

    beforeEach(() => {
      integrationsService.findAll = jest
        .fn()
        .mockResolvedValue([stashdb, fansdb]);
      integrationsService.findOne = jest
        .fn()
        .mockImplementation((type: IntegrationType) =>
          Promise.resolve(type === IntegrationType.FANSDB ? fansdb : stashdb),
        );
    });

    it('uses FansDB for catalog lookups only when a browse page asks for it', async () => {
      await expect(
        service.getConfiguredCatalogProvider(),
      ).resolves.toMatchObject({
        providerKey: 'STASHDB',
      });

      await runWithRequestedCatalogProvider('FANSDB', async () => {
        await expect(
          service.getConfiguredCatalogProvider(),
        ).resolves.toMatchObject({
          providerKey: 'FANSDB',
          baseUrl: 'http://fansdb.local/graphql',
        });
        await expect(service.isBrowseOnlyRequest()).resolves.toBe(true);
        // Requests always stay on the instance provider.
        await expect(
          service.getInstanceCatalogProvider(),
        ).resolves.toMatchObject({
          providerKey: 'STASHDB',
        });
      });
    });

    it('ignores a request for a provider that is not ready', async () => {
      integrationsService.findOne = jest
        .fn()
        .mockImplementation((type: IntegrationType) =>
          Promise.resolve(
            type === IntegrationType.FANSDB
              ? {
                  ...fansdb,
                  status: IntegrationStatus.ERROR,
                  lastHealthyAt: null,
                }
              : stashdb,
          ),
        );

      await runWithRequestedCatalogProvider('FANSDB', async () => {
        await expect(
          service.getConfiguredCatalogProvider(),
        ).resolves.toMatchObject({
          providerKey: 'STASHDB',
        });
        await expect(service.isBrowseOnlyRequest()).resolves.toBe(false);
      });
    });

    it('falls back to the other provider when a detail id is not found', async () => {
      const load = jest.fn(async (provider: { providerKey: string }) => {
        if (provider.providerKey === 'STASHDB') {
          throw new NotFoundException('Scene not found in StashDB.');
        }
        return { id: 'fans-scene' };
      });

      await expect(service.withDetailFallback(load)).resolves.toEqual({
        value: { id: 'fans-scene' },
        provider: expect.objectContaining({ providerKey: 'FANSDB' }),
        browseOnly: true,
      });
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not retry on errors other than not-found', async () => {
      const load = jest.fn().mockRejectedValue(new BadRequestException('bad'));
      await expect(service.withDetailFallback(load)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('lists ready providers with the instance provider first', async () => {
      await expect(service.getBrowseProviders()).resolves.toEqual({
        instance: 'STASHDB',
        available: [
          { key: 'STASHDB', label: 'StashDB', browseOnly: false },
          { key: 'FANSDB', label: 'FansDB', browseOnly: true },
        ],
      });
    });
  });
});
