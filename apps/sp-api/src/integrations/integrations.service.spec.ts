import {
  IntegrationStatus,
  IntegrationType,
  Prisma,
  RuntimeHealthServiceKey,
} from '@prisma/client';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { ProwlarrAdapter } from '../providers/prowlarr/prowlarr.adapter';
import { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import { buildCatalogProviderSelectionConfig } from '../providers/catalog/catalog-provider.util';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeHealthService } from '../runtime-health/runtime-health.service';
import { IntegrationsService } from './integrations.service';

describe('IntegrationsService', () => {
  const upsert = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
  const updateMany = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
  const findMany = jest.fn();
  const findUnique = jest.fn();
  const transaction = jest.fn();
  const stashTestConnection = jest.fn();
  const stashProbeConnection = jest.fn();
  const stashdbTestConnection = jest.fn();
  const stashdbProbeConnection = jest.fn();
  const whisparrTestConnection = jest.fn();
  const whisparrProbeConnection = jest.fn();
  const prowlarrTestConnection = jest.fn();
  const sabnzbdTestConnection = jest.fn();
  const sabnzbdListCategories = jest.fn();
  const handoffSettingsFindUnique = jest.fn();
  const clearRuntimeHealth = jest.fn();
  const clearAllRuntimeHealth = jest.fn();
  const recordManualRecovery = jest.fn();
  const getRuntimeHealthSummary = jest.fn();

  const prisma = {
    integrationConfig: {
      upsert,
      updateMany,
      findMany,
      findUnique,
    },
    downloadHandoffSettings: { findUnique: handoffSettingsFindUnique },
    $transaction: transaction,
  } as unknown as PrismaService;

  const stashAdapter = {
    testConnection: stashTestConnection,
    probeConnection: stashProbeConnection,
  } as unknown as StashAdapter;

  const stashdbAdapter = {
    testConnection: stashdbTestConnection,
    probeConnection: stashdbProbeConnection,
  } as unknown as StashdbAdapter;

  const whisparrAdapter = {
    testConnection: whisparrTestConnection,
    probeConnection: whisparrProbeConnection,
  } as unknown as WhisparrAdapter;

  const prowlarrAdapter = {
    testConnection: prowlarrTestConnection,
  } as unknown as ProwlarrAdapter;

  const sabnzbdAdapter = {
    testConnection: sabnzbdTestConnection,
    listCategories: sabnzbdListCategories,
  };

  const runtimeHealthService = {
    clearService: clearRuntimeHealth,
    clearAllServices: clearAllRuntimeHealth,
    recordManualRecovery,
    getSummary: getRuntimeHealthSummary,
  } as unknown as RuntimeHealthService;

  let service: IntegrationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntegrationsService(
      prisma,
      stashAdapter,
      stashdbAdapter,
      whisparrAdapter,
      runtimeHealthService,
      prowlarrAdapter,
      sabnzbdAdapter as unknown as SabnzbdAdapter,
    );
  });

  it('resets a single integration to NOT_CONFIGURED with cleared config', async () => {
    upsert.mockResolvedValue({
      type: IntegrationType.STASH,
    });

    await service.reset(IntegrationType.STASH);

    expect(upsert).toHaveBeenCalledWith({
      where: { type: IntegrationType.STASH },
      update: {
        enabled: true,
        name: null,
        baseUrl: null,
        apiKey: null,
        config: Prisma.JsonNull,
        status: IntegrationStatus.NOT_CONFIGURED,
        lastHealthyAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
      create: {
        type: IntegrationType.STASH,
        enabled: true,
        name: null,
        baseUrl: null,
        apiKey: null,
        config: Prisma.JsonNull,
        status: IntegrationStatus.NOT_CONFIGURED,
        lastHealthyAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      },
    });
    expect(clearRuntimeHealth).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.STASH,
    );
  });

  it('resets all integrations and returns them sorted by type', async () => {
    transaction.mockResolvedValue([
      { type: IntegrationType.WHISPARR },
      { type: IntegrationType.STASH },
      { type: IntegrationType.FANSDB },
      { type: IntegrationType.STASHDB },
    ]);

    const result = await service.resetAll();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(clearAllRuntimeHealth).toHaveBeenCalledTimes(1);
    expect(result.map((integration) => integration.type)).toEqual([
      IntegrationType.FANSDB,
      IntegrationType.STASH,
      IntegrationType.STASHDB,
      IntegrationType.WHISPARR,
    ]);
  });

  it('re-saves the chosen catalog provider without wiping an optional browse provider', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.old/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stashdb.local/graphql',
        config: null,
      },
    ]);
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ type: IntegrationType.FANSDB, enabled: true });

    await expect(
      service.upsert(IntegrationType.FANSDB, {
        baseUrl: 'http://fansdb.local/graphql',
      }),
    ).resolves.toMatchObject({ type: IntegrationType.FANSDB });

    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: IntegrationType.FANSDB },
        update: expect.objectContaining({
          baseUrl: 'http://fansdb.local/graphql',
          config: buildCatalogProviderSelectionConfig(),
        }),
      }),
    );
  });

  it('claims the instance and resets the other provider when no provider is chosen yet', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: false,
        status: IntegrationStatus.NOT_CONFIGURED,
        baseUrl: null,
        config: null,
      },
    ]);
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ type: IntegrationType.FANSDB, enabled: true });
    updateMany.mockResolvedValue({ count: 1 });
    transaction.mockImplementation(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );

    await service.upsert(IntegrationType.FANSDB, {
      baseUrl: 'http://fansdb.local/graphql',
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: { in: [IntegrationType.STASHDB] } },
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          config: buildCatalogProviderSelectionConfig(),
        }),
      }),
    );
  });
  it('preserves the stored API key when saving without a new one and clears readiness on connection changes', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      name: 'Local Stash',
      baseUrl: 'http://stash.old',
      apiKey: 'existing-token',
      status: IntegrationStatus.CONFIGURED,
      lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      lastErrorAt: null,
      lastErrorMessage: null,
    });
    upsert.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      status: IntegrationStatus.NOT_CONFIGURED,
      hasApiKey: true,
    });

    await service.upsert(IntegrationType.STASH, {
      baseUrl: 'http://stash.new',
    });

    expect(upsert).toHaveBeenCalledWith({
      where: { type: IntegrationType.STASH },
      update: expect.objectContaining({
        enabled: true,
        name: 'Local Stash',
        baseUrl: 'http://stash.new',
        apiKey: 'existing-token',
        status: IntegrationStatus.NOT_CONFIGURED,
        lastHealthyAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      }),
      create: expect.objectContaining({
        type: IntegrationType.STASH,
        enabled: true,
        name: 'Local Stash',
        baseUrl: 'http://stash.new',
        apiKey: 'existing-token',
        status: IntegrationStatus.NOT_CONFIGURED,
        lastHealthyAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      }),
    });
    expect(clearRuntimeHealth).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.STASH,
    );
  });

  it('removes the saved API key when asked, and asks for a new test', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      name: 'Local Stash',
      baseUrl: 'http://stash.local',
      apiKey: 'existing-token',
      status: IntegrationStatus.CONFIGURED,
      lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      lastErrorAt: null,
      lastErrorMessage: null,
    });
    upsert.mockResolvedValue({ type: IntegrationType.STASH });

    await service.upsert(IntegrationType.STASH, { clearApiKey: true });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          baseUrl: 'http://stash.local',
          apiKey: null,
          status: IntegrationStatus.NOT_CONFIGURED,
        }),
      }),
    );

    await service.upsert(IntegrationType.STASH, {
      clearApiKey: true,
      apiKey: 'replacement',
    });
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ apiKey: 'replacement' }),
      }),
    );
  });

  it('preserves runtime health when saving without a material connection change', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      name: 'Local Stash',
      baseUrl: 'http://stash.local',
      apiKey: 'existing-token',
      status: IntegrationStatus.CONFIGURED,
      lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      lastErrorAt: null,
      lastErrorMessage: null,
    });
    upsert.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
    });

    await service.upsert(IntegrationType.STASH, {
      name: 'Renamed Stash',
    });

    expect(clearRuntimeHealth).not.toHaveBeenCalled();
  });

  it('saves the other catalog provider as browse-only without taking over the instance', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
    ]);
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({ type: IntegrationType.STASHDB, enabled: true });

    await service.upsert(IntegrationType.STASHDB, {
      baseUrl: 'http://stashdb.local/graphql',
    });

    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    const args = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(args.update.baseUrl).toBe('http://stashdb.local/graphql');
    expect(args.update).not.toHaveProperty('config');
  });

  it('only removes a browse-only provider when it is reset', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stashdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.local/graphql',
        config: null,
      },
    ]);
    upsert.mockResolvedValue({ type: IntegrationType.FANSDB });

    await expect(service.reset(IntegrationType.FANSDB)).resolves.toEqual({
      type: IntegrationType.FANSDB,
    });

    expect(transaction).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: IntegrationType.FANSDB } }),
    );
  });
  it('resets both catalog providers when clearing one provider choice', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
    ]);
    transaction.mockResolvedValue([
      { type: IntegrationType.STASHDB },
      { type: IntegrationType.FANSDB },
    ]);

    const result = await service.reset(IntegrationType.FANSDB);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(clearRuntimeHealth).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.CATALOG,
    );
    expect(result).toEqual({ type: IntegrationType.FANSDB });
  });

  it('tests stash integration and stores success metadata', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      name: 'Local Stash',
      baseUrl: 'http://stash.local',
      apiKey: 'token',
    });
    (stashAdapter.testConnection as jest.Mock).mockResolvedValue(undefined);
    upsert.mockResolvedValue({
      type: IntegrationType.STASH,
      status: IntegrationStatus.CONFIGURED,
      lastErrorMessage: null,
    });

    await expect(
      service.testIntegration(IntegrationType.STASH, {}),
    ).resolves.toMatchObject({
      type: IntegrationType.STASH,
      status: IntegrationStatus.CONFIGURED,
    });

    expect(stashTestConnection).toHaveBeenCalledWith({
      baseUrl: 'http://stash.local',
      apiKey: 'token',
    });
    const stashUpsertCall = upsert.mock.calls[0]?.[0] as {
      where: { type: IntegrationType };
      update: {
        enabled: boolean;
        name: string | null;
        baseUrl: string | null;
        apiKey: string | null;
        status: IntegrationStatus;
        lastHealthyAt: Date | null;
        lastErrorAt: Date | null;
        lastErrorMessage: string | null;
      };
    };
    expect(stashUpsertCall.where.type).toBe(IntegrationType.STASH);
    expect(stashUpsertCall.update.enabled).toBe(true);
    expect(stashUpsertCall.update.name).toBe('Local Stash');
    expect(stashUpsertCall.update.baseUrl).toBe('http://stash.local');
    expect(stashUpsertCall.update.apiKey).toBe('token');
    expect(stashUpsertCall.update.status).toBe(IntegrationStatus.CONFIGURED);
    expect(stashUpsertCall.update.lastHealthyAt).toBeInstanceOf(Date);
    expect(stashUpsertCall.update.lastErrorAt).toBeNull();
    expect(stashUpsertCall.update.lastErrorMessage).toBeNull();
    expect(recordManualRecovery).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.STASH,
    );
  });

  it('persists the config that was tested when the test succeeds', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.STASH,
      enabled: true,
      name: 'Local Stash',
      baseUrl: 'http://stash.old',
      apiKey: 'old-token',
      status: IntegrationStatus.ERROR,
      lastHealthyAt: null,
      lastErrorAt: new Date('2026-03-31T00:00:00.000Z'),
      lastErrorMessage: 'bad credentials',
    });
    stashTestConnection.mockResolvedValue(undefined);
    upsert.mockResolvedValue({
      type: IntegrationType.STASH,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://stash.new',
      apiKey: 'new-token',
    });

    await service.testIntegration(IntegrationType.STASH, {
      baseUrl: 'http://stash.new',
      apiKey: 'new-token',
    });

    expect(stashTestConnection).toHaveBeenCalledWith({
      baseUrl: 'http://stash.new',
      apiKey: 'new-token',
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: IntegrationType.STASH },
        update: expect.objectContaining({
          baseUrl: 'http://stash.new',
          apiKey: 'new-token',
          status: IntegrationStatus.CONFIGURED,
        }),
      }),
    );
    expect(recordManualRecovery).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.STASH,
    );
  });

  it('marks the catalog runtime service healthy after a successful catalog repair test', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({
      type: IntegrationType.STASHDB,
      enabled: true,
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: null,
      status: IntegrationStatus.ERROR,
      lastHealthyAt: null,
      lastErrorAt: new Date('2026-03-31T00:00:00.000Z'),
      lastErrorMessage: 'catalog down',
    });
    stashdbTestConnection.mockResolvedValue(undefined);
    updateMany.mockResolvedValue({ count: 0 });
    upsert.mockResolvedValue({
      type: IntegrationType.STASHDB,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://stashdb.local/graphql',
    });
    transaction.mockImplementation(async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
    );

    await expect(
      service.testIntegration(IntegrationType.STASHDB, {}),
    ).resolves.toMatchObject({
      type: IntegrationType.STASHDB,
      status: IntegrationStatus.CONFIGURED,
    });

    expect(recordManualRecovery).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.CATALOG,
    );
  });

  it('tests the other catalog provider as browse-only without taking over the instance', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.ERROR,
        baseUrl: 'http://fansdb.local/graphql',
        config: buildCatalogProviderSelectionConfig(),
      },
    ]);
    findUnique.mockResolvedValue(null);
    stashdbTestConnection.mockResolvedValue(undefined);
    upsert.mockResolvedValue({
      type: IntegrationType.STASHDB,
      status: IntegrationStatus.CONFIGURED,
    });

    await service.testIntegration(IntegrationType.STASHDB, {
      baseUrl: 'http://stashdb.local/graphql',
    });

    expect(stashdbTestConnection).toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    const args = upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(args.update.status).toBe(IntegrationStatus.CONFIGURED);
    expect(args.update).not.toHaveProperty('config');
  });
  it('stores error metadata when integration test fails', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.WHISPARR,
      enabled: true,
      baseUrl: 'http://whisparr.old',
      apiKey: 'old-token',
    });
    whisparrTestConnection.mockRejectedValue(new Error('bad credentials'));
    upsert.mockResolvedValue({
      type: IntegrationType.WHISPARR,
      status: IntegrationStatus.ERROR,
      lastErrorMessage: 'bad credentials',
    });

    await expect(
      service.testIntegration(IntegrationType.WHISPARR, {
        baseUrl: 'http://whisparr.local',
        apiKey: 'token',
      }),
    ).resolves.toMatchObject({
      type: IntegrationType.WHISPARR,
      status: IntegrationStatus.ERROR,
      lastErrorMessage: 'bad credentials',
    });

    const whisparrUpsertCall = upsert.mock.calls[0]?.[0] as {
      where: { type: IntegrationType };
      update: {
        baseUrl: string | null;
        apiKey: string | null;
        status: IntegrationStatus;
        lastHealthyAt: Date | null;
        lastErrorAt: Date | null;
        lastErrorMessage: string | null;
      };
    };
    expect(whisparrUpsertCall.where.type).toBe(IntegrationType.WHISPARR);
    expect(whisparrUpsertCall.update.baseUrl).toBe('http://whisparr.local');
    expect(whisparrUpsertCall.update.apiKey).toBe('token');
    expect(whisparrUpsertCall.update.status).toBe(IntegrationStatus.ERROR);
    expect(whisparrUpsertCall.update.lastHealthyAt).toBeNull();
    expect(whisparrUpsertCall.update.lastErrorAt).toBeInstanceOf(Date);
    expect(whisparrUpsertCall.update.lastErrorMessage).toBe('bad credentials');
    expect(clearRuntimeHealth).toHaveBeenCalledWith(
      RuntimeHealthServiceKey.WHISPARR,
    );
    expect(recordManualRecovery).not.toHaveBeenCalled();
  });

  it('tests Prowlarr with its own adapter and keeps it out of runtime health', async () => {
    findUnique.mockResolvedValue(null);
    prowlarrTestConnection.mockResolvedValue(undefined);
    upsert.mockResolvedValue({
      type: IntegrationType.PROWLARR,
      status: IntegrationStatus.CONFIGURED,
    });

    await service.testIntegration(IntegrationType.PROWLARR, {
      baseUrl: 'http://prowlarr.local:9696',
      apiKey: 'p-key',
    });

    expect(prowlarrTestConnection).toHaveBeenCalledWith({
      baseUrl: 'http://prowlarr.local:9696',
      apiKey: 'p-key',
    });
    const args = upsert.mock.calls[0][0] as {
      where: { type: IntegrationType };
      update: Record<string, unknown>;
    };
    expect(args.where.type).toBe(IntegrationType.PROWLARR);
    expect(args.update.status).toBe(IntegrationStatus.CONFIGURED);
    expect(recordManualRecovery).not.toHaveBeenCalled();
  });

  it('tests SABnzbd and checks Stashboard’s category is there', async () => {
    findUnique.mockResolvedValue(null);
    handoffSettingsFindUnique.mockResolvedValue({ category: 'stashboard' });
    sabnzbdTestConnection.mockResolvedValue(undefined);
    sabnzbdListCategories.mockResolvedValue(['*', 'xxx', 'Stashboard']);
    upsert.mockResolvedValue({
      type: IntegrationType.SABNZBD,
      status: IntegrationStatus.CONFIGURED,
    });

    await service.testIntegration(IntegrationType.SABNZBD, {
      baseUrl: 'http://sab:8080',
      apiKey: 's-key',
    });

    expect(sabnzbdTestConnection).toHaveBeenCalledWith({
      baseUrl: 'http://sab:8080',
      apiKey: 's-key',
    });
    const args = upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(args.update.status).toBe(IntegrationStatus.CONFIGURED);
    expect(recordManualRecovery).not.toHaveBeenCalled();
  });

  it('fails the SABnzbd test when its category is missing', async () => {
    findUnique.mockResolvedValue(null);
    handoffSettingsFindUnique.mockResolvedValue(null);
    sabnzbdTestConnection.mockResolvedValue(undefined);
    sabnzbdListCategories.mockResolvedValue(['*', 'xxx', 'movies']);
    upsert.mockResolvedValue({
      type: IntegrationType.SABNZBD,
      status: IntegrationStatus.ERROR,
    });

    await service.testIntegration(IntegrationType.SABNZBD, {
      baseUrl: 'http://sab:8080',
    });

    const args = upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(args.update.status).toBe(IntegrationStatus.ERROR);
    expect(args.update.lastErrorMessage).toContain('no “stashboard” category');
  });

  it('records a failed Prowlarr test without touching runtime health', async () => {
    findUnique.mockResolvedValue({
      type: IntegrationType.PROWLARR,
      enabled: true,
      baseUrl: 'http://prowlarr.old',
      apiKey: 'old',
    });
    prowlarrTestConnection.mockRejectedValue(
      new Error('Prowlarr refused the API key.'),
    );
    upsert.mockResolvedValue({
      type: IntegrationType.PROWLARR,
      status: IntegrationStatus.ERROR,
    });

    await service.testIntegration(IntegrationType.PROWLARR, {
      baseUrl: 'http://prowlarr.local',
    });

    const args = upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(args.update.status).toBe(IntegrationStatus.ERROR);
    expect(args.update.lastErrorMessage).toBe('Prowlarr refused the API key.');
    expect(clearRuntimeHealth).not.toHaveBeenCalled();
  });

  it('actively probes configured runtime integrations and returns the refreshed summary', async () => {
    findMany.mockResolvedValue([
      {
        type: IntegrationType.STASH,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stash.local',
        apiKey: 'stash-token',
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
      {
        type: IntegrationType.STASHDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://stashdb.local/graphql',
        apiKey: null,
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
        config: buildCatalogProviderSelectionConfig(),
      },
      {
        type: IntegrationType.FANSDB,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://fansdb.local/graphql',
        apiKey: null,
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
        config: null,
      },
      {
        type: IntegrationType.WHISPARR,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://whisparr.local',
        apiKey: 'whisparr-token',
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
      {
        type: IntegrationType.PROWLARR,
        enabled: true,
        status: IntegrationStatus.CONFIGURED,
        baseUrl: 'http://prowlarr.local',
        apiKey: 'prowlarr-token',
        lastHealthyAt: new Date('2026-04-01T00:00:00.000Z'),
      },
    ]);
    stashProbeConnection.mockResolvedValue(undefined);
    stashdbProbeConnection.mockResolvedValue(undefined);
    whisparrProbeConnection.mockRejectedValue(new Error('Whisparr offline'));
    getRuntimeHealthSummary.mockResolvedValue({
      degraded: true,
      failureThreshold: 2,
      services: {
        catalog: {
          service: RuntimeHealthServiceKey.CATALOG,
          status: 'HEALTHY',
          degraded: false,
          consecutiveFailures: 0,
          lastHealthyAt: null,
          lastFailureAt: null,
          lastErrorMessage: null,
          degradedAt: null,
        },
        stash: {
          service: RuntimeHealthServiceKey.STASH,
          status: 'HEALTHY',
          degraded: false,
          consecutiveFailures: 0,
          lastHealthyAt: null,
          lastFailureAt: null,
          lastErrorMessage: null,
          degradedAt: null,
        },
        whisparr: {
          service: RuntimeHealthServiceKey.WHISPARR,
          status: 'DEGRADED',
          degraded: true,
          consecutiveFailures: 2,
          lastHealthyAt: null,
          lastFailureAt: '2026-04-02T00:00:00.000Z',
          lastErrorMessage: 'Whisparr offline',
          degradedAt: '2026-04-02T00:00:00.000Z',
        },
      },
    });

    await expect(service.refreshRuntimeHealth()).resolves.toMatchObject({
      degraded: true,
      services: {
        whisparr: {
          degraded: true,
          lastErrorMessage: 'Whisparr offline',
        },
      },
    });

    expect(stashProbeConnection).toHaveBeenCalledWith({
      baseUrl: 'http://stash.local',
      apiKey: 'stash-token',
    });
    expect(stashdbProbeConnection).toHaveBeenCalledWith({
      baseUrl: 'http://stashdb.local/graphql',
      apiKey: null,
    });
    expect(whisparrProbeConnection).toHaveBeenCalledWith({
      baseUrl: 'http://whisparr.local',
      apiKey: 'whisparr-token',
    });
    expect(prowlarrTestConnection).not.toHaveBeenCalled();
    expect(getRuntimeHealthSummary).toHaveBeenCalledTimes(1);
  });
});
