import * as os from 'node:os';
import type { IndexingService } from '../indexing/indexing.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import { importedFolder } from './automation.controller';
import { AutomationService, stashTimestamp } from './automation.service';

describe('AutomationService', () => {
  let settings: Record<string, unknown>;
  let prisma: {
    libraryAutomationSettings: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    sceneIndex: { findMany: jest.Mock };
    integrationConfig: { findUnique: jest.Mock };
  };
  let stash: {
    startLibraryTask: jest.Mock;
    waitForJob: jest.Mock;
    findLocalScenes: jest.Mock;
  };
  let indexing: {
    syncLibraryProjection: jest.Mock;
    requestImmediateRefresh: jest.Mock;
  };
  let service: AutomationService;

  beforeEach(() => {
    settings = {
      key: 'GLOBAL',
      scanOnImport: true,
      identifyNew: true,
      generateNew: true,
      webhookToken: 'secret-token',
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      lastRunReason: null,
    };
    prisma = {
      libraryAutomationSettings: {
        findUnique: jest.fn(() => Promise.resolve(settings)),
        create: jest.fn(),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          settings = { ...settings, ...data };
          return Promise.resolve(settings);
        }),
      },
      sceneIndex: { findMany: jest.fn().mockResolvedValue([]) },
      integrationConfig: {
        findUnique: jest.fn().mockResolvedValue({
          type: 'STASH',
          enabled: true,
          status: 'CONFIGURED',
          baseUrl: 'http://stash.local',
          apiKey: 'k',
        }),
      },
    };
    stash = {
      startLibraryTask: jest.fn((_config, task: string) =>
        Promise.resolve(`${task}-job`),
      ),
      waitForJob: jest.fn().mockResolvedValue('FINISHED'),
      findLocalScenes: jest
        .fn()
        .mockResolvedValue({ total: 2, items: [{ id: '41' }, { id: '42' }] }),
    };
    indexing = {
      syncLibraryProjection: jest.fn().mockResolvedValue(null),
      requestImmediateRefresh: jest.fn().mockResolvedValue(undefined),
    };
    service = new AutomationService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      indexing as unknown as IndexingService,
    );
    service.sleep = () => Promise.resolve();
  });

  afterEach(() => jest.useRealTimers());

  it('scans, identifies and generates previews for the new scenes, then refreshes Stashboard', async () => {
    await service.run('detected', ['stashdb-1']);

    expect(
      stash.startLibraryTask.mock.calls.map((call) => [call[1], call[2]]),
    ).toEqual([
      ['scan', undefined],
      ['generate', ['41', '42']],
      ['identify', ['41', '42']],
    ]);
    const filter = stash.findLocalScenes.mock.calls[0][1].sceneFilter;
    expect(filter.created_at.modifier).toBe('GREATER_THAN');
    expect(indexing.syncLibraryProjection).toHaveBeenCalled();
    expect(indexing.requestImmediateRefresh).toHaveBeenCalledWith(
      ['stashdb-1'],
      'automation',
    );
    expect(settings.lastRunStatus).toBe('DONE');
    expect(settings.lastRunMessage).toBe(
      'Found 2 new scenes, previews generated, identified.',
    );
  });

  it('removes sample clips that came with an import before doing anything else with them', async () => {
    settings = { ...settings, removeSamples: true };
    const deleteScene = jest.fn().mockResolvedValue(undefined);
    Object.assign(stash, {
      findSampleScenes: jest.fn().mockResolvedValue([
        { id: '41', file: { path: '/data/scenes/A/Sample/a-sample.mkv' } },
        // An old sample, not from this import: left alone.
        { id: '7', file: { path: '/data/old/sample.mkv' } },
      ]),
      deleteScene,
    });

    await service.run('detected');

    expect(deleteScene).toHaveBeenCalledTimes(1);
    expect(deleteScene).toHaveBeenCalledWith(expect.anything(), '41', true);
    expect(
      stash.startLibraryTask.mock.calls.map((call) => [call[1], call[2]]),
    ).toEqual([
      ['scan', undefined],
      ['generate', ['42']],
      ['identify', ['42']],
    ]);
    expect(settings.lastRunMessage).toContain('removed 1 sample');
  });

  it('only scans when identify and generate are off', async () => {
    settings = { ...settings, identifyNew: false, generateNew: false };

    await service.run('manual');

    expect(stash.startLibraryTask.mock.calls.map((call) => call[1])).toEqual([
      'scan',
    ]);
  });

  it('stops and reports when the scan fails', async () => {
    stash.waitForJob.mockResolvedValueOnce('FAILED');

    await service.run('manual');

    expect(stash.findLocalScenes).not.toHaveBeenCalled();
    expect(settings.lastRunStatus).toBe('FAILED');
    expect(settings.lastRunMessage).toBe('Stash scan failed.');
  });

  it('keeps going and says so when Identify cannot start', async () => {
    stash.startLibraryTask.mockImplementation((_config, task: string) =>
      task === 'identify'
        ? Promise.reject(new Error('no StashDB source'))
        : Promise.resolve(`${task}-job`),
    );

    await service.run('manual');

    expect(settings.lastRunMessage).toBe(
      'Found 2 new scenes, previews generated, identify skipped (no StashDB source).',
    );
  });

  it('never runs two scans at once when triggers arrive together', async () => {
    let scanning = 0;
    let mostAtOnce = 0;
    stash.startLibraryTask.mockImplementation(async (_config, task: string) => {
      if (task === 'scan') {
        scanning += 1;
        mostAtOnce = Math.max(mostAtOnce, scanning);
        await new Promise((resolve) => setTimeout(resolve, 5));
        scanning -= 1;
      }
      return `${task}-job`;
    });

    await Promise.all([service.run('manual'), service.run('webhook')]);
    while (service.isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(mostAtOnce).toBe(1);
  });

  it('still does a Run now that arrives while an automatic trigger is being turned away', async () => {
    settings = { ...settings, scanOnImport: false };

    await Promise.all([service.run('webhook'), service.run('manual')]);
    while (service.isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(stash.startLibraryTask).toHaveBeenCalledWith(
      expect.anything(),
      'scan',
    );
  });

  it('does nothing automatically when the feature is off, but Run now still works', async () => {
    settings = { ...settings, scanOnImport: false };

    await service.run('webhook');
    expect(stash.startLibraryTask).not.toHaveBeenCalled();

    await service.run('manual');
    expect(stash.startLibraryTask).toHaveBeenCalled();
  });

  it('turns a burst of Whisparr imports into one run, and ignores unrelated events', async () => {
    jest.useFakeTimers();
    const run = jest.spyOn(service, 'run').mockResolvedValue(undefined);

    expect(service.onWebhook('Grab')).toBe('ignored');
    expect(service.onWebhook('Download')).toBe('scheduled');
    expect(service.onWebhook('Download')).toBe('scheduled');
    jest.advanceTimersByTime(45_000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('webhook');
  });

  it('checks the webhook token', async () => {
    await expect(service.verifyToken('secret-token')).resolves.toBe(true);
    await expect(service.verifyToken('wrong')).resolves.toBe(false);
  });

  it('notices scenes waiting for Stash, but does not rescan the same ones over and over', async () => {
    const run = jest.spyOn(service, 'run').mockResolvedValue(undefined);
    prisma.sceneIndex.findMany.mockResolvedValue([
      { stashId: 'a' },
      { stashId: 'b' },
    ]);

    await service.checkForWaitingScenes();
    await service.checkForWaitingScenes();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('detected', ['a', 'b']);

    prisma.sceneIndex.findMany.mockResolvedValue([
      { stashId: 'a' },
      { stashId: 'b' },
      { stashId: 'c' },
    ]);
    await service.checkForWaitingScenes();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('still links and re-checks waiting scenes with scanning off, without scanning', async () => {
    settings = { ...settings, scanOnImport: false };
    const organizer = {
      checkWaitingScenes: jest
        .fn()
        .mockResolvedValue({ checked: 1, fixed: 1, left: [] }),
    };
    const scoped = new AutomationService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      indexing as unknown as IndexingService,
      organizer as unknown as OrganizerService,
    );
    const run = jest.spyOn(scoped, 'run').mockResolvedValue(undefined);
    prisma.sceneIndex.findMany.mockResolvedValue([{ stashId: 'a' }]);

    await scoped.checkForWaitingScenes();

    expect(run).not.toHaveBeenCalled();
    expect(organizer.checkWaitingScenes).toHaveBeenCalledTimes(1);
  });

  it('formats timestamps the way Stash filters expect', () => {
    expect(stashTimestamp(new Date('2026-10-16T12:34:56.789Z'))).toBe(
      '2026-10-16T12:34:56Z',
    );
  });

  describe('scanning only what Whisparr imported', () => {
    function withOrganizer(roots: string[]) {
      const organizer = {
        getSettings: jest.fn().mockResolvedValue({
          whisparrPathFrom: '/data',
          whisparrPathTo: '/mnt/media',
        }),
        afterImport: jest.fn().mockResolvedValue(0),
        identifyNewScenes: jest.fn((ids: string[]) =>
          Promise.resolve({ linked: [], matched: [], left: ids }),
        ),
      };
      Object.assign(stash, {
        scanLibraryFolders: jest.fn().mockResolvedValue('folder-scan-job'),
        getLibraryRoots: jest.fn().mockResolvedValue(roots),
      });
      const scoped = new AutomationService(
        prisma as unknown as PrismaService,
        stash as unknown as StashAdapter,
        indexing as unknown as IndexingService,
        organizer as unknown as OrganizerService,
      );
      scoped.sleep = () => Promise.resolve();
      return scoped;
    }

    it('scans the folder Whisparr imported into, as Stash sees it', async () => {
      jest.useFakeTimers();
      const scoped = withOrganizer(['/data/scenes']);
      scoped.onWebhook('Download', '/mnt/media/scenes/Studio/Scene A');
      scoped.onWebhook('Download', '/mnt/media/scenes/Studio/Scene B');
      jest.useRealTimers();

      await scoped.run('webhook');

      expect(
        (stash as unknown as { scanLibraryFolders: jest.Mock })
          .scanLibraryFolders,
      ).toHaveBeenCalledWith(expect.anything(), [
        '/data/scenes/Studio/Scene A',
        '/data/scenes/Studio/Scene B',
      ]);
      expect(stash.startLibraryTask).not.toHaveBeenCalledWith(
        expect.anything(),
        'scan',
      );
      expect(settings.lastRunMessage).toBe(
        'Found 2 new scenes, previews generated, identified.',
      );
    });

    it('scans only the folders where files were copied in by hand', async () => {
      const root = os.tmpdir();
      const scoped = withOrganizer([root]);
      settings = { ...settings, watchFolders: true };
      Object.assign(stash, {
        knownFilePaths: jest
          .fn()
          .mockResolvedValue(new Set([`${root}/Renamed/known.mp4`])),
      });
      scoped.folderWatcher = {
        check: jest
          .fn()
          .mockResolvedValue([
            `${root}/Studio/new.mp4`,
            `${root}/Renamed/known.mp4`,
          ]),
      } as unknown as typeof scoped.folderWatcher;

      await scoped.watchLibraryFolders();

      expect(
        (stash as unknown as { scanLibraryFolders: jest.Mock })
          .scanLibraryFolders,
      ).toHaveBeenCalledWith(expect.anything(), [`${root}/Studio`]);
      expect(settings.lastRunReason).toBe('files');
      expect((await scoped.getSettingsDto()).foldersVisible).toBe(true);
    });

    it('identifies and generates a file copied in by hand even when Stash’s clock disagrees', async () => {
      const root = os.tmpdir();
      const scoped = withOrganizer([root]);
      settings = { ...settings, watchFolders: true };
      Object.assign(stash, {
        knownFilePaths: jest.fn().mockResolvedValue(new Set()),
        sceneIdsForPaths: jest.fn().mockResolvedValue(['77']),
        findLocalScenes: jest.fn().mockResolvedValue({ total: 0, items: [] }),
      });
      scoped.folderWatcher = {
        check: jest.fn().mockResolvedValue([`${root}/Studio/new.mp4`]),
      } as unknown as typeof scoped.folderWatcher;

      await scoped.watchLibraryFolders();

      expect(
        (stash as unknown as { sceneIdsForPaths: jest.Mock }).sceneIdsForPaths,
      ).toHaveBeenCalledWith(expect.anything(), [`${root}/Studio/new.mp4`]);
      expect(stash.startLibraryTask).toHaveBeenCalledWith(
        expect.anything(),
        'generate',
        ['77'],
      );
      expect(settings.lastRunMessage).toMatch(/^Found 1 new scene/);
    });

    it('doesn’t watch folders when that is off, or Stashboard can’t see them', async () => {
      const hidden = withOrganizer(['/no/such/library']);
      const check = jest.fn().mockResolvedValue([]);
      hidden.folderWatcher = {
        check,
      } as unknown as typeof hidden.folderWatcher;
      settings = { ...settings, watchFolders: true };
      await hidden.watchLibraryFolders();
      expect(check).not.toHaveBeenCalled();
      expect((await hidden.getSettingsDto()).foldersVisible).toBe(false);

      settings = { ...settings, watchFolders: false };
      await hidden.watchLibraryFolders();
      expect((await hidden.getSettingsDto()).foldersVisible).toBeNull();
    });

    it('scans everything when a folder is outside Stash’s library or unknown', async () => {
      jest.useFakeTimers();
      const outside = withOrganizer(['/data/other']);
      outside.onWebhook('Download', '/mnt/media/scenes/Studio/Scene A');
      jest.useRealTimers();
      await outside.run('webhook');
      expect(stash.startLibraryTask).toHaveBeenCalledWith(
        expect.anything(),
        'scan',
      );

      stash.startLibraryTask.mockClear();
      jest.useFakeTimers();
      const unknown = withOrganizer(['/data/scenes']);
      unknown.onWebhook('Download', '/mnt/media/scenes/Studio/Scene A');
      unknown.onWebhook('Download', null);
      jest.useRealTimers();
      await unknown.run('webhook');
      expect(stash.startLibraryTask).toHaveBeenCalledWith(
        expect.anything(),
        'scan',
      );
    });

    it('reads the folder from Whisparr’s webhook', () => {
      expect(
        importedFolder({
          eventType: 'Download',
          movie: { folderPath: '/mnt/media/scenes/Studio/Scene A' },
        }),
      ).toBe('/mnt/media/scenes/Studio/Scene A');
      expect(
        importedFolder({
          movieFile: { path: '/mnt/media/scenes/Studio/Scene A/a.mp4' },
        }),
      ).toBe('/mnt/media/scenes/Studio/Scene A');
      expect(importedFolder({ eventType: 'Download' })).toBeNull();
      expect(importedFolder('nonsense')).toBeNull();
    });
  });

  it('links Whisparr’s imports itself and asks Stash to identify only the rest', async () => {
    const organizer = {
      identifyNewScenes: jest
        .fn()
        .mockResolvedValue({ linked: ['41'], matched: [], left: ['42'] }),
      afterImport: jest.fn().mockResolvedValue(0),
    };
    const scoped = new AutomationService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      indexing as unknown as IndexingService,
      organizer as unknown as OrganizerService,
    );
    scoped.sleep = () => Promise.resolve();

    await scoped.run('manual');

    expect(organizer.identifyNewScenes).toHaveBeenCalledWith(['41', '42']);
    expect(stash.startLibraryTask).toHaveBeenCalledWith(
      expect.anything(),
      'identify',
      ['42'],
    );
    expect(settings.lastRunMessage).toBe(
      'Found 2 new scenes, previews generated, linked 1 from Whisparr, asked Stash to identify 1 more.',
    );
  });

  it('skips Stash’s Identify when every new scene is already named', async () => {
    const organizer = {
      identifyNewScenes: jest
        .fn()
        .mockResolvedValue({ linked: ['41'], matched: ['42'], left: [] }),
      afterImport: jest.fn().mockResolvedValue(0),
    };
    const scoped = new AutomationService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      indexing as unknown as IndexingService,
      organizer as unknown as OrganizerService,
    );
    scoped.sleep = () => Promise.resolve();

    await scoped.run('manual');

    expect(stash.startLibraryTask).not.toHaveBeenCalledWith(
      expect.anything(),
      'identify',
      expect.anything(),
    );
    expect(settings.lastRunMessage).toBe(
      'Found 2 new scenes, previews generated, linked 1 from Whisparr, matched 1.',
    );
  });

  it('links scenes waiting for an import that already happened', async () => {
    const organizer = {
      identifyNewScenes: jest
        .fn()
        .mockResolvedValue({ linked: [], matched: [], left: [] }),
      linkWaitingScenes: jest.fn().mockResolvedValue(['9']),
      afterImport: jest.fn().mockResolvedValue(0),
    };
    const scoped = new AutomationService(
      prisma as unknown as PrismaService,
      stash as unknown as StashAdapter,
      indexing as unknown as IndexingService,
      organizer as unknown as OrganizerService,
    );
    scoped.sleep = () => Promise.resolve();

    await scoped.run('detected', ['sdb-9']);

    expect(organizer.linkWaitingScenes).toHaveBeenCalledWith(['sdb-9']);
    expect(settings.lastRunMessage).toContain('linked 1 waiting for import');
  });

  describe('tidying up after Whisparr imports', () => {
    const withOrganizer = (organizer: Record<string, jest.Mock>) => {
      const scoped = new AutomationService(
        prisma as unknown as PrismaService,
        stash as unknown as StashAdapter,
        indexing as unknown as IndexingService,
        organizer as unknown as OrganizerService,
      );
      scoped.sleep = () => Promise.resolve();
      return scoped;
    };
    const organizerMock = (running = false) => ({
      identifyNewScenes: jest
        .fn()
        .mockResolvedValue({ linked: [], matched: ['41', '42'], left: [] }),
      afterImport: jest.fn().mockResolvedValue(0),
      status: jest.fn().mockReturnValue({ running }),
      syncWithWhisparr: jest.fn().mockResolvedValue({
        rescanned: 1,
        removed: 2,
        linked: 0,
        failed: 0,
        steps: ['rescanned 1 folder', 'removed 2 extra copies'],
        message: 'Rescanned 1 folder, removed 2 extra copies.',
      }),
    });

    it('syncs with Whisparr after the scan and identify steps', async () => {
      settings = { ...settings, tidyAfterImport: true };
      const organizer = organizerMock();

      await withOrganizer(organizer).run('detected');

      expect(organizer.syncWithWhisparr).toHaveBeenCalledTimes(1);
      expect(
        organizer.syncWithWhisparr.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        organizer.identifyNewScenes.mock.invocationCallOrder[0],
      );
      expect(settings.lastRunMessage).toBe(
        'Found 2 new scenes, previews generated, matched 2, rescanned 1 folder, removed 2 extra copies.',
      );
    });

    it('leaves it out when it is off, for files put in by hand, and while the organizer is busy', async () => {
      settings = { ...settings, tidyAfterImport: false };
      const off = organizerMock();
      await withOrganizer(off).run('detected');
      expect(off.syncWithWhisparr).not.toHaveBeenCalled();

      settings = { ...settings, tidyAfterImport: true };
      const byHand = organizerMock();
      await withOrganizer(byHand).run('files');
      expect(byHand.syncWithWhisparr).not.toHaveBeenCalled();

      const busy = organizerMock(true);
      await withOrganizer(busy).run('detected');
      expect(busy.syncWithWhisparr).not.toHaveBeenCalled();
      expect(settings.lastRunMessage).toContain(
        'tidy-up skipped (the organizer was busy)',
      );
    });

    it('saves the setting', async () => {
      settings = { ...settings, tidyAfterImport: true };
      const saved = await service.updateSettings({ tidyAfterImport: false });
      expect(saved.tidyAfterImport).toBe(false);
    });
  });
});
