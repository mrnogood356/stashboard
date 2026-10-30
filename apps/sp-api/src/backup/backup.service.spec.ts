import { BadRequestException } from '@nestjs/common';
import { IntegrationStatus } from '@prisma/client';
import type { AppearanceService } from '../appearance/appearance.service';
import type { AutomationService } from '../automation/automation.service';
import type { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import type { HiddenContentService } from '../hidden-content/hidden-content.service';
import type { IntegrationsService } from '../integrations/integrations.service';
import type { LogsService } from '../logs/logs.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PlaybackSettingsService } from '../playback/playback-settings.service';
import type { PrismaService } from '../prisma/prisma.service';
import { BackupService, type SettingsBackup } from './backup.service';

const TOKEN = 'a'.repeat(48);

function setup() {
  const prisma = {
    integrationConfig: {
      findMany: jest.fn().mockResolvedValue([
        {
          type: 'STASH',
          enabled: true,
          name: null,
          baseUrl: 'http://stash:9999',
          apiKey: 'stash-key',
          config: null,
        },
        {
          type: 'STASHDB',
          enabled: true,
          name: null,
          baseUrl: 'https://stashdb.org/graphql',
          apiKey: 'box-key',
          config: { catalogProviderSelection: { selected: true } },
        },
        {
          type: 'PROWLARR',
          enabled: true,
          name: null,
          baseUrl: null,
          apiKey: null,
          config: null,
        },
      ]),
    },
    libraryAutomationSettings: { update: jest.fn() },
  };
  const integrations = {
    testIntegration: jest.fn().mockResolvedValue({
      status: IntegrationStatus.CONFIGURED,
      lastErrorMessage: null,
    }),
  };
  const notifications = {
    getSettings: jest.fn().mockResolvedValue({
      enabled: true,
      channel: 'DISCORD',
      url: 'https://discord.com/api/webhooks/1/abc',
      token: null,
      userKey: null,
      notifyDownloading: false,
      notifyAvailable: true,
      notifyFailed: true,
    }),
    updateSettings: jest.fn(),
  };
  const automation = {
    getSettingsDto: jest.fn().mockResolvedValue({
      scanOnImport: true,
      identifyNew: true,
      generateNew: false,
      removeSamples: false,
      watchFolders: true,
      tidyAfterImport: true,
      webhookPath: `/api/hooks/whisparr/${TOKEN}`,
    }),
    getSettings: jest.fn().mockResolvedValue({ webhookToken: TOKEN }),
    updateSettings: jest.fn(),
  };
  const organizer = {
    getSettingsDto: jest.fn().mockResolvedValue({
      renamePattern: '{studio}/{title}',
      renameRoot: '',
      keepFolders: ['/data/keep'],
      hasTpdbKey: true,
      whisparrImportMode: 'move',
      libraryRoots: ['/data'],
    }),
    getSettings: jest.fn().mockResolvedValue({ tpdbApiKey: 'tpdb-key' }),
    updateSettings: jest.fn(),
  };
  const handoff = {
    getSettingsDto: jest.fn().mockResolvedValue({
      enabled: true,
      category: 'stashboard',
      destination: '/data/new',
      sabPathFrom: null,
      sabPathTo: null,
      importMode: 'move',
      dropIns: false,
      sabManualJobs: true,
    }),
    updateSettings: jest.fn(),
  };
  const hidden = {
    getSettings: jest.fn().mockResolvedValue({
      words: ['vr'],
      tags: [],
      studios: [{ id: 's1', name: 'Studio' }],
      performers: [],
      hideOwned: true,
    }),
    updateSettings: jest.fn(),
  };
  const appearance = {
    get: jest.fn().mockResolvedValue({
      mode: 'dark',
      lightTheme: 'light',
      darkTheme: 'nord',
      accentColor: null,
      radius: 'default',
      density: 'comfortable',
      fontScale: 'default',
      material: 'glass',
      customCss: '',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }),
    update: jest.fn(),
  };
  const playback = {
    get: jest.fn().mockResolvedValue({
      enabled: true,
      feedEnabled: false,
      previewsEnabled: true,
      updatedAt: null,
    }),
    update: jest.fn(),
  };
  const logs = {
    settings: jest.fn().mockResolvedValue({
      level: 'info',
      fileEnabled: true,
      saved: true,
      envLevel: 'info',
      fileDirectory: null,
      fileError: null,
    }),
    updateSettings: jest.fn(),
  };

  const service = new BackupService(
    prisma as unknown as PrismaService,
    integrations as unknown as IntegrationsService,
    automation as unknown as AutomationService,
    notifications as unknown as NotificationsService,
    organizer as unknown as OrganizerService,
    handoff as unknown as DownloadHandoffService,
    hidden as unknown as HiddenContentService,
    appearance as unknown as AppearanceService,
    playback as unknown as PlaybackSettingsService,
    logs as unknown as LogsService,
  );
  return {
    service,
    prisma,
    integrations,
    notifications,
    automation,
    organizer,
    handoff,
    appearance,
  };
}

describe('BackupService', () => {
  it('exports every page’s settings, with the catalog first and keys included', async () => {
    const { service } = setup();
    const file = await service.export(true);

    expect(file).toEqual(
      expect.objectContaining({
        format: 'stashboard-settings',
        formatVersion: 1,
        includesSecrets: true,
      }),
    );
    // Prowlarr was never set up, so it isn't in the file.
    expect(file.settings.integrations).toEqual([
      {
        type: 'STASHDB',
        enabled: true,
        baseUrl: 'https://stashdb.org/graphql',
        apiKey: 'box-key',
      },
      {
        type: 'STASH',
        enabled: true,
        baseUrl: 'http://stash:9999',
        apiKey: 'stash-key',
      },
    ]);
    expect(file.settings.organizer).toEqual({
      renamePattern: '{studio}/{title}',
      renameRoot: '',
      keepFolders: ['/data/keep'],
      tpdbApiKey: 'tpdb-key',
      whisparrImportMode: 'move',
    });
    expect(file.settings.automation).toEqual(
      expect.objectContaining({ generateNew: false, webhookToken: TOKEN }),
    );
    // Only what the page saves: not when it was saved.
    expect(file.settings.appearance).not.toHaveProperty('updatedAt');
    expect(file.settings.logs).toEqual({ level: 'info', fileEnabled: true });
  });

  it('leaves keys, tokens and webhook links out when asked', async () => {
    const { service } = setup();
    const file = await service.export(false);
    const text = JSON.stringify(file);

    expect(file.includesSecrets).toBe(false);
    for (const secret of [
      'stash-key',
      'box-key',
      'tpdb-key',
      TOKEN,
      'discord.com',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(file.settings.notifications).toEqual(
      expect.objectContaining({ enabled: true, channel: 'DISCORD' }),
    );
  });

  it('restores a file it exported: integrations tested first, then each page', async () => {
    const { service, integrations, notifications, appearance, prisma } =
      setup();
    const file = await service.export(true);

    const { results } = await service.restore(file);

    expect(
      integrations.testIntegration.mock.calls.map((call) => call[0]),
    ).toEqual(['STASHDB', 'STASH']);
    expect(integrations.testIntegration).toHaveBeenCalledWith(
      'STASH',
      expect.objectContaining({
        baseUrl: 'http://stash:9999',
        apiKey: 'stash-key',
      }),
    );
    expect(notifications.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://discord.com/api/webhooks/1/abc',
      }),
    );
    expect(appearance.update).toHaveBeenCalledWith(
      expect.objectContaining({ darkTheme: 'nord', material: 'glass' }),
    );
    expect(prisma.libraryAutomationSettings.update).toHaveBeenCalledWith({
      where: { key: 'GLOBAL' },
      data: { webhookToken: TOKEN },
    });
    expect(results.every((result) => result.status === 'restored')).toBe(true);
  });

  it('keeps current values for anything the file leaves out', async () => {
    const { service, appearance } = setup();

    await service.restore({
      format: 'stashboard-settings',
      formatVersion: 1,
      settings: { appearance: { darkTheme: 'oled' } },
    });

    expect(appearance.update).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'dark',
        darkTheme: 'oled',
        material: 'glass',
      }),
    );
  });

  it('changes nothing when any value is wrong', async () => {
    const { service, appearance, integrations } = setup();
    const file: SettingsBackup = await service.export(true);
    file.settings.appearance = { mode: 'neon' };
    file.settings.integrations = [{ type: 'PLEX', baseUrl: 'http://plex' }];

    const restoring = service.restore(file);

    await expect(restoring).rejects.toBeInstanceOf(BadRequestException);
    await expect(restoring).rejects.toThrow(/Nothing was restored/);
    await expect(restoring).rejects.toThrow(/Appearance/);
    await expect(restoring).rejects.toThrow(/“PLEX” isn’t a known service/);
    expect(appearance.update).not.toHaveBeenCalled();
    expect(integrations.testIntegration).not.toHaveBeenCalled();
  });

  it('refuses files that aren’t backups, or come from a newer version', async () => {
    const { service } = setup();
    await expect(service.restore({ hello: 'world' })).rejects.toThrow(
      'isn’t a Stashboard settings backup',
    );
    await expect(
      service.restore({
        format: 'stashboard-settings',
        formatVersion: 2,
        settings: {},
      }),
    ).rejects.toThrow('newer Stashboard');
  });

  it('reports a page that can’t be saved here and still restores the rest', async () => {
    const { service, handoff, integrations, appearance } = setup();
    handoff.updateSettings.mockRejectedValue(
      new BadRequestException(
        'Pick a folder inside one of Stash’s library folders.',
      ),
    );
    integrations.testIntegration.mockResolvedValue({
      status: IntegrationStatus.ERROR,
      lastErrorMessage: 'connect ECONNREFUSED',
    });
    const file = await service.export(true);

    const { results } = await service.restore(file);

    expect(results.find((result) => result.id === 'downloads')).toEqual({
      id: 'downloads',
      label: 'Finished downloads',
      status: 'failed',
      message: 'Pick a folder inside one of Stash’s library folders.',
    });
    expect(results.find((result) => result.id === 'integration-STASH')).toEqual(
      expect.objectContaining({
        status: 'warning',
        message: 'Saved, but couldn’t connect: connect ECONNREFUSED',
      }),
    );
    expect(appearance.update).toHaveBeenCalled();
  });
});
