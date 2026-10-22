import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { OrganizerService } from '../organizer/organizer.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { ProwlarrAdapter } from '../providers/prowlarr/prowlarr.adapter';
import { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  insideAny,
  SetupCheckService,
  usableOrigin,
} from './setup-check.service';
import { SetupCheck } from './setup-check.types';

const TOKEN = 'abc123';
const ORIGIN = 'http://192.168.1.10:3000';

function webhook(url: string, extra: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'Stashboard',
    implementation: 'Webhook',
    onDownload: true,
    fields: [
      { name: 'url', value: url },
      { name: 'method', value: 1 },
    ],
    ...extra,
  };
}

describe('SetupCheckService', () => {
  let prisma: {
    integrationConfig: { findUnique: jest.Mock };
    libraryAutomationSettings: { findUnique: jest.Mock; upsert: jest.Mock };
    downloadHandoffSettings: { findUnique: jest.Mock };
  };
  let stash: Record<string, jest.Mock>;
  let whisparr: Record<string, jest.Mock>;
  let catalog: { getConfiguredCatalogProviderOrNull: jest.Mock };
  let organizer: Record<string, jest.Mock>;
  let prowlarr: Record<string, jest.Mock>;
  let sabnzbd: Record<string, jest.Mock>;
  let service: SetupCheckService;

  const byId = (checks: SetupCheck[], id: string) => {
    const check = checks.find((entry) => entry.id === id);
    if (!check) {
      throw new Error(`No check ${id}`);
    }
    return check;
  };

  beforeEach(() => {
    prisma = {
      integrationConfig: {
        findUnique: jest.fn(({ where }: { where: { type: string } }) =>
          Promise.resolve(
            // Prowlarr and SABnzbd are optional, and not added here.
            where.type === 'PROWLARR' || where.type === 'SABNZBD'
              ? null
              : {
                  type: where.type,
                  enabled: true,
                  status: 'CONFIGURED',
                  baseUrl:
                    where.type === 'STASH'
                      ? 'http://stash:9999'
                      : 'http://wh:6969',
                  apiKey: 'key',
                },
          ),
        ),
      },
      libraryAutomationSettings: {
        findUnique: jest.fn().mockResolvedValue({ webhookToken: TOKEN }),
        upsert: jest.fn().mockResolvedValue({ webhookToken: TOKEN }),
      },
      downloadHandoffSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    stash = {
      getVersion: jest.fn().mockResolvedValue('v0.27.2'),
      getLibraryRoots: jest.fn().mockResolvedValue(['/data/scenes']),
      listStashBoxes: jest.fn().mockResolvedValue([
        {
          name: 'StashDB',
          endpoint: 'https://stashdb.org/graphql',
          apiKey: 'k',
        },
      ]),
    };
    whisparr = {
      getSystemStatus: jest.fn().mockResolvedValue({ version: '3.0.1' }),
      getRootFolders: jest
        .fn()
        .mockResolvedValue([{ id: 1, path: '/mnt/media/scenes' }]),
      getConfigSection: jest.fn((_config: unknown, section: string) =>
        Promise.resolve(
          section === 'mediamanagement'
            ? { id: 1, copyUsingHardlinks: true }
            : {
                id: 1,
                renameScenes: true,
                sceneFolderFormat: '{Studio Title}',
                standardSceneFormat: '{Scene Title}',
              },
        ),
      ),
      updateConfigSection: jest.fn().mockResolvedValue(undefined),
      listNotifications: jest
        .fn()
        .mockResolvedValue([webhook(`${ORIGIN}/api/hooks/whisparr/${TOKEN}`)]),
      getNotificationSchema: jest.fn().mockResolvedValue([
        {
          implementation: 'Webhook',
          configContract: 'WebhookSettings',
          presets: [],
          fields: [
            { name: 'url', value: null },
            { name: 'method', value: 1 },
          ],
        },
      ]),
      saveNotification: jest.fn().mockResolvedValue(undefined),
      getIndexerHealth: jest
        .fn()
        .mockResolvedValue({ searchable: 2, paused: [] }),
    };
    catalog = {
      getConfiguredCatalogProviderOrNull: jest.fn().mockResolvedValue({
        label: 'StashDB',
        baseUrl: 'https://stashdb.org/graphql',
      }),
    };
    organizer = {
      getSettings: jest.fn().mockResolvedValue({
        renamePattern: '{Studio Title}/{Scene Title}',
        whisparrPathFrom: '/data',
        whisparrPathTo: '/mnt/media',
        whisparrImportMode: 'move',
      }),
      whisparrNaming: jest.fn().mockResolvedValue({
        pattern: '{Studio Title}/{Scene Title}',
        problem: null,
      }),
      updateSettings: jest.fn().mockResolvedValue({}),
    };
    prowlarr = {
      getSystemStatus: jest.fn().mockResolvedValue({ version: '1.30.2' }),
      countEnabledIndexers: jest.fn().mockResolvedValue(3),
      listEnabledDownloadClients: jest.fn().mockResolvedValue(['qBittorrent']),
    };
    sabnzbd = {
      getVersion: jest.fn().mockResolvedValue('4.3.2'),
      listCategories: jest.fn().mockResolvedValue(['*', 'xxx', 'stashboard']),
      categoryFolder: jest
        .fn()
        .mockResolvedValue('/downloads/complete/stashboard-downloads'),
    };
    service = new SetupCheckService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      whisparr as unknown as WhisparrAdapter,
      catalog as unknown as CatalogProviderService,
      organizer as unknown as OrganizerService,
      prowlarr as unknown as ProwlarrAdapter,
      sabnzbd as unknown as SabnzbdAdapter,
    );
    service.see = jest.fn().mockResolvedValue(true);
  });

  it('reports everything ok on a good setup', async () => {
    const { checks } = await service.run(ORIGIN);
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['stash', 'ok'],
      ['whisparr', 'ok'],
      ['stash-boxes', 'ok'],
      ['library-folders', 'ok'],
      ['path-mapping', 'ok'],
      ['import-mode', 'ok'],
      ['naming', 'ok'],
      ['webhook', 'ok'],
      ['indexers', 'ok'],
    ]);
    expect(byId(checks, 'stash').summary).toBe('Connected to Stash v0.27.2.');
    expect(byId(checks, 'whisparr').summary).toBe(
      'Connected to Whisparr 3.0.1.',
    );
  });

  it('fails Stash when it isn’t set up and skips what needs it', async () => {
    prisma.integrationConfig.findUnique.mockImplementation(
      ({ where }: { where: { type: string } }) =>
        Promise.resolve(
          where.type === 'STASH'
            ? null
            : {
                enabled: true,
                status: 'CONFIGURED',
                baseUrl: 'http://wh:6969',
                apiKey: null,
              },
        ),
    );
    const { checks } = await service.run();
    expect(byId(checks, 'stash').status).toBe('fail');
    expect(byId(checks, 'stash').link?.route).toBe('/settings/integrations');
    expect(byId(checks, 'stash-boxes').status).toBe('skip');
    expect(byId(checks, 'library-folders').status).toBe('skip');
    expect(byId(checks, 'path-mapping').status).toBe('skip');
    expect(byId(checks, 'indexers').status).toBe('ok');
  });

  it('fails Whisparr when it can’t be reached and skips its checks', async () => {
    whisparr.getSystemStatus.mockRejectedValue(
      new BadGatewayException('Failed to reach Whisparr provider endpoint.'),
    );
    const { checks } = await service.run();
    const check = byId(checks, 'whisparr');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Failed to reach Whisparr');
    for (const id of ['import-mode', 'naming', 'webhook', 'indexers']) {
      expect(byId(checks, id).status).toBe('skip');
    }
    expect(whisparr.getIndexerHealth).not.toHaveBeenCalled();
  });

  it('turns an unexpected error in one check into a skip', async () => {
    whisparr.getIndexerHealth.mockRejectedValue(new Error('boom'));
    const { checks } = await service.run();
    expect(byId(checks, 'indexers')).toMatchObject({
      status: 'skip',
      detail: 'boom.',
    });
    expect(byId(checks, 'naming').status).toBe('ok');
  });

  it('fails when Stash has no stash-box, warns when the catalog one is missing', async () => {
    stash.listStashBoxes.mockResolvedValue([]);
    let { checks } = await service.run();
    expect(byId(checks, 'stash-boxes').status).toBe('fail');

    stash.listStashBoxes.mockResolvedValue([
      { name: 'FansDB', endpoint: 'https://fansdb.cc/graphql', apiKey: 'k' },
    ]);
    ({ checks } = await service.run());
    expect(byId(checks, 'stash-boxes')).toMatchObject({
      status: 'warn',
      summary: 'Stash doesn’t have StashDB set up.',
    });
  });

  it('warns about library folders Stashboard can’t see, with how to mount them', async () => {
    stash.getLibraryRoots.mockResolvedValue(['/data/scenes', '/data/more']);
    service.see = jest.fn((folder: string) =>
      Promise.resolve(folder === '/data/scenes'),
    );
    const { checks } = await service.run();
    const check = byId(checks, 'library-folders');
    expect(check.status).toBe('warn');
    expect(check.summary).toBe(
      'Stashboard can’t see 1 of Stash’s 2 library folders.',
    );
    expect(check.detail).toContain('/data/more');
    expect(check.detail).toContain('Add another Path');
  });

  it('warns when a Whisparr root folder isn’t in Stash’s library after mapping', async () => {
    whisparr.getRootFolders.mockResolvedValue([
      { id: 1, path: '/mnt/media/scenes' },
      { id: 2, path: '/downloads/other' },
    ]);
    const { checks } = await service.run();
    const check = byId(checks, 'path-mapping');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('/downloads/other');
    expect(check.detail).not.toContain('/mnt/media/scenes');
  });

  it('warns about copies and turns hardlinks on', async () => {
    whisparr.getConfigSection.mockImplementation(
      (_config: unknown, section: string) =>
        Promise.resolve(
          section === 'mediamanagement'
            ? { id: 1, copyUsingHardlinks: false, other: 'x' }
            : { id: 1, renameScenes: true },
        ),
    );
    const { checks } = await service.run();
    expect(byId(checks, 'import-mode')).toMatchObject({
      status: 'warn',
      fix: { action: 'whisparr-hardlinks' },
    });

    await expect(service.fix('whisparr-hardlinks')).resolves.toMatchObject({
      ok: true,
    });
    expect(whisparr.updateConfigSection).toHaveBeenCalledWith(
      expect.anything(),
      'mediamanagement',
      { id: 1, copyUsingHardlinks: true, other: 'x' },
    );
  });

  it('warns when Whisparr doesn’t rename, and turns renaming on', async () => {
    whisparr.getConfigSection.mockResolvedValue({
      id: 3,
      renameScenes: false,
      copyUsingHardlinks: true,
    });
    const { checks } = await service.run();
    expect(byId(checks, 'naming')).toMatchObject({
      status: 'warn',
      fix: { action: 'whisparr-rename' },
    });
    await service.fix('whisparr-rename');
    expect(whisparr.updateConfigSection).toHaveBeenCalledWith(
      expect.anything(),
      'naming',
      expect.objectContaining({ id: 3, renameScenes: true }),
    );
  });

  it('suggests Whisparr’s naming when Stashboard’s pattern differs, and applies it', async () => {
    organizer.getSettings.mockResolvedValue({
      renamePattern: '{studio}/{date} - {title}',
      whisparrPathFrom: '/data',
      whisparrPathTo: '/mnt/media',
    });
    const { checks } = await service.run();
    expect(byId(checks, 'naming')).toMatchObject({
      status: 'warn',
      fix: { action: 'use-whisparr-naming', label: 'Use Whisparr’s naming' },
    });
    await service.fix('use-whisparr-naming');
    expect(organizer.updateSettings).toHaveBeenCalledWith({
      renamePattern: '{Studio Title}/{Scene Title}',
    });
  });

  it('offers to add the webhook when Whisparr has none, and adds it', async () => {
    whisparr.listNotifications.mockResolvedValue([]);
    const { checks } = await service.run(ORIGIN);
    const check = byId(checks, 'webhook');
    expect(check).toMatchObject({
      status: 'warn',
      fix: { action: 'whisparr-webhook' },
    });
    expect(check.detail).toContain(`${ORIGIN}/api/hooks/whisparr/${TOKEN}`);

    await service.fix('whisparr-webhook', ORIGIN);
    const body = whisparr.saveNotification.mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      name: 'Stashboard',
      implementation: 'Webhook',
      onDownload: true,
      onUpgrade: true,
    });
    expect(body).not.toHaveProperty('presets');
    expect(body.fields).toEqual([
      { name: 'url', value: `${ORIGIN}/api/hooks/whisparr/${TOKEN}` },
      { name: 'method', value: 1 },
    ]);
  });

  it('spots a webhook with an old token and updates it in place', async () => {
    whisparr.listNotifications.mockResolvedValue([
      webhook(`${ORIGIN}/api/hooks/whisparr/old`),
    ]);
    const { checks } = await service.run(ORIGIN);
    expect(byId(checks, 'webhook').summary).toBe(
      'Whisparr’s webhook uses an old Stashboard address.',
    );
    await service.fix('whisparr-webhook', ORIGIN);
    expect(whisparr.saveNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 7,
        fields: [
          { name: 'url', value: `${ORIGIN}/api/hooks/whisparr/${TOKEN}` },
          { name: 'method', value: 1 },
        ],
      }),
    );
  });

  it('only explains the webhook when Stashboard’s address is localhost', async () => {
    whisparr.listNotifications.mockResolvedValue([]);
    const { checks } = await service.run('http://localhost:4200');
    expect(byId(checks, 'webhook').fix).toBeUndefined();
    await expect(
      service.fix('whisparr-webhook', 'http://localhost:4200'),
    ).rejects.toThrow(/\/api\/hooks\/whisparr\/abc123/);
    expect(whisparr.saveNotification).not.toHaveBeenCalled();
  });

  it('fails with no searchable indexers and warns about paused ones', async () => {
    whisparr.getIndexerHealth.mockResolvedValue({ searchable: 0, paused: [] });
    let { checks } = await service.run();
    expect(byId(checks, 'indexers').status).toBe('fail');

    whisparr.getIndexerHealth.mockResolvedValue({
      searchable: 2,
      paused: [{ name: 'Tracker', until: '2026-10-20T10:00:00Z' }],
    });
    ({ checks } = await service.run());
    expect(byId(checks, 'indexers')).toMatchObject({
      status: 'warn',
      summary: 'One of Whisparr’s indexers is paused after errors.',
    });
  });

  describe('Prowlarr', () => {
    const withProwlarr = (row: Record<string, unknown> | null) => {
      const original =
        prisma.integrationConfig.findUnique.getMockImplementation();
      prisma.integrationConfig.findUnique.mockImplementation(
        (args: { where: { type: string } }) =>
          args.where.type === 'PROWLARR'
            ? Promise.resolve(row)
            : original?.(args),
      );
    };

    it('leaves Prowlarr out until it has been added', async () => {
      const { checks } = await service.run();
      expect(checks.some((check) => check.id === 'prowlarr')).toBe(false);
      expect(prowlarr.getSystemStatus).not.toHaveBeenCalled();
    });

    it('reports a reachable Prowlarr with its indexers and download client', async () => {
      withProwlarr({
        enabled: true,
        status: 'CONFIGURED',
        baseUrl: 'http://prowlarr:9696',
        apiKey: 'p',
      });
      const { checks } = await service.run();
      const check = byId(checks, 'prowlarr');
      expect(check.status).toBe('ok');
      expect(check.summary).toBe(
        'Connected to Prowlarr 1.30.2, with 3 indexers and qBittorrent for downloads.',
      );
      expect(prowlarr.getSystemStatus).toHaveBeenCalledWith({
        baseUrl: 'http://prowlarr:9696',
        apiKey: 'p',
      });
    });

    it('fails when a saved Prowlarr can’t be reached, even after a failed test', async () => {
      withProwlarr({
        enabled: true,
        status: 'ERROR',
        baseUrl: 'http://prowlarr:9696',
        apiKey: 'p',
      });
      prowlarr.getSystemStatus.mockRejectedValue(
        new BadGatewayException('Couldn’t reach Prowlarr.'),
      );
      const check = byId((await service.run()).checks, 'prowlarr');
      expect(check.status).toBe('fail');
      expect(check.detail).toContain('Couldn’t reach Prowlarr.');
      expect(check.link?.route).toBe('/settings/integrations');
    });

    it('warns when Prowlarr has no download client', async () => {
      withProwlarr({
        enabled: true,
        status: 'CONFIGURED',
        baseUrl: 'http://prowlarr:9696',
        apiKey: 'p',
      });
      prowlarr.listEnabledDownloadClients.mockResolvedValue([]);
      const check = byId((await service.run()).checks, 'prowlarr');
      expect(check.status).toBe('warn');
      expect(check.summary).toContain('no download client');
    });
  });

  describe('SABnzbd', () => {
    const SAB = {
      type: 'SABNZBD',
      enabled: true,
      status: 'CONFIGURED',
      baseUrl: 'http://sab:8080',
      apiKey: 's',
    };
    const withSabnzbd = (
      row: Record<string, unknown> | null,
      settings: Record<string, unknown> | null = null,
    ) => {
      const original =
        prisma.integrationConfig.findUnique.getMockImplementation();
      prisma.integrationConfig.findUnique.mockImplementation(
        (args: { where: { type: string } }) =>
          args.where.type === 'SABNZBD'
            ? Promise.resolve(row)
            : original?.(args),
      );
      prisma.downloadHandoffSettings.findUnique.mockResolvedValue(settings);
    };
    const handoff = {
      enabled: true,
      category: 'stashboard',
      destination: '/data/scenes/downloads',
      sabPathFrom: '/downloads',
      sabPathTo: '/mnt/sab',
    };

    it('leaves SABnzbd out until it has been added', async () => {
      const { checks } = await service.run();
      expect(checks.some((check) => check.id === 'sabnzbd')).toBe(false);
      expect(sabnzbd.getVersion).not.toHaveBeenCalled();
    });

    it('fails when SABnzbd can’t be reached', async () => {
      withSabnzbd(SAB);
      sabnzbd.getVersion.mockRejectedValue(
        new BadGatewayException('Couldn’t reach SABnzbd.'),
      );
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');
      expect(check.summary).toBe('Stashboard can’t reach SABnzbd.');
    });

    it('fails when Stashboard’s category is missing', async () => {
      withSabnzbd(SAB);
      sabnzbd.listCategories.mockResolvedValue(['*', 'xxx', 'movies']);
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');
      expect(check.summary).toBe('SABnzbd 4.3.2 has no “stashboard” category.');
    });

    it('is fine with the category while Finished downloads is off', async () => {
      withSabnzbd(SAB, { ...handoff, enabled: false });
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('ok');
      expect(check.summary).toContain('Finished downloads is off');
    });

    it('fails when the destination isn’t inside a Stash library folder', async () => {
      withSabnzbd(SAB, { ...handoff, destination: '/elsewhere' });
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');
      expect(check.summary).toBe(
        '/elsewhere isn’t inside one of Stash’s library folders.',
      );
    });

    it('fails when Stashboard can’t see the destination', async () => {
      withSabnzbd(SAB, handoff);
      service.see = jest.fn((folder: string) =>
        Promise.resolve(folder !== '/data/scenes/downloads'),
      );
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');
      expect(check.summary).toBe(
        'Stashboard can’t see /data/scenes/downloads.',
      );
    });

    it('checks SABnzbd’s finished folder through the mapping', async () => {
      withSabnzbd(SAB, handoff);
      const see = jest.fn((folder: string) =>
        Promise.resolve(folder !== '/mnt/sab/complete/stashboard-downloads'),
      );
      service.see = see;
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');
      expect(check.summary).toContain('/mnt/sab/complete/stashboard-downloads');
      expect(see).toHaveBeenCalledWith(
        '/mnt/sab/complete/stashboard-downloads',
      );
    });

    it('is ok when everything lines up', async () => {
      withSabnzbd(SAB, handoff);
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check).toMatchObject({
        status: 'ok',
        summary:
          'Connected to SABnzbd 4.3.2. Finished “stashboard” downloads go to /data/scenes/downloads.',
      });
    });

    it('with drop-ins on, needs SABnzbd’s folder to be known and visible', async () => {
      withSabnzbd(SAB, { ...handoff, dropIns: true });
      let check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('ok');
      expect(check.summary).toContain(
        'Files you put in /mnt/sab/complete/stashboard-downloads are brought in too.',
      );

      service.see = jest.fn((folder: string) =>
        Promise.resolve(folder !== '/mnt/sab/complete/stashboard-downloads'),
      );
      check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');

      sabnzbd.categoryFolder.mockResolvedValue(null);
      check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('fail');
      expect(check.summary).toContain(
        'files you put there can’t be brought in',
      );
    });

    it('doesn’t need to know SABnzbd’s folder while drop-ins are off', async () => {
      withSabnzbd(SAB, handoff);
      sabnzbd.categoryFolder.mockResolvedValue(null);
      const check = byId((await service.run()).checks, 'sabnzbd');
      expect(check.status).toBe('ok');
    });
  });

  it('rejects an unknown fix', async () => {
    await expect(service.fix('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('setup check helpers', () => {
  it('knows when a folder is in a library', () => {
    expect(insideAny('/data/scenes', ['/data/scenes/'])).toBe(true);
    expect(insideAny('/data/scenes/new', ['/data/scenes'])).toBe(true);
    expect(insideAny('/data/scenesx', ['/data/scenes'])).toBe(false);
  });

  it('only accepts an address Whisparr could reach', () => {
    expect(usableOrigin('http://192.168.1.10:3000/x')).toBe(
      'http://192.168.1.10:3000',
    );
    expect(usableOrigin('http://localhost:3000')).toBeNull();
    expect(usableOrigin('http://127.0.0.1')).toBeNull();
    expect(usableOrigin('javascript:alert(1)')).toBeNull();
    expect(usableOrigin(null)).toBeNull();
  });
});
