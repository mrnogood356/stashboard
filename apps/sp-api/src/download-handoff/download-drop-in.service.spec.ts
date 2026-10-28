import { Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DownloadDropIn, DownloadHandoff } from '@prisma/client';
import type { ActivityService } from '../activity/activity.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  SabnzbdAdapter,
  SabnzbdHistoryEntry,
} from '../providers/sabnzbd/sabnzbd.adapter';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import { DownloadDropInService } from './download-drop-in.service';
import { DownloadHandoffService } from './download-handoff.service';

describe('DownloadDropInService', () => {
  let root: string;
  /** SABnzbd's folder for the category, as Stashboard sees it. */
  let sabFolder: string;
  let library: string;
  let destination: string;
  let dropIns: DownloadDropIn[];
  let handoffs: Array<Pick<DownloadHandoff, 'sabPath'> & { status?: string }>;
  let settings: Record<string, unknown>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let sabnzbd: Record<string, jest.Mock>;
  let stash: Record<string, jest.Mock>;
  let organizer: Record<string, jest.Mock>;
  let activity: { record: jest.Mock };
  let service: DownloadDropInService;

  /** Long enough after the files were written for them to count as settled. */
  const later = () => Date.now() + 5 * 60_000;
  const write = async (file: string, bytes = 100) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(bytes, 1));
  };
  const exists = (file: string) =>
    fs.lstat(file).then(
      () => true,
      () => false,
    );
  /** Two checks: the first sees the file, the second finds it unchanged. */
  const twoChecks = async (now = later()) => {
    await service.check(now);
    await service.check(now);
  };
  const titles = () =>
    activity.record.mock.calls.map(
      ([entry]) => (entry as { title: string }).title,
    );
  const historyEntry = (
    overrides: Partial<SabnzbdHistoryEntry> = {},
  ): SabnzbdHistoryEntry => ({
    nzoId: 'SABnzbd_nzo_1',
    name: 'Release',
    category: 'stashboard',
    status: 'Completed',
    storage: '/downloads/complete/stashboard-downloads/Release',
    failMessage: null,
    ...overrides,
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-in-'));
    sabFolder = path.join(root, 'sab', 'complete', 'stashboard-downloads');
    library = path.join(root, 'library');
    destination = path.join(library, 'fansdb');
    await fs.mkdir(sabFolder, { recursive: true });
    await fs.mkdir(destination, { recursive: true });

    dropIns = [];
    handoffs = [];
    settings = {
      key: 'GLOBAL',
      enabled: true,
      category: 'stashboard',
      destination,
      sabPathFrom: '/downloads',
      sabPathTo: path.join(root, 'sab'),
      importMode: 'move',
      dropIns: true,
    };
    const integrations: Record<string, Record<string, unknown>> = {
      SABNZBD: {
        enabled: true,
        status: 'CONFIGURED',
        baseUrl: 'http://sab:8080',
        apiKey: 'sab-key',
      },
      STASH: {
        enabled: true,
        status: 'CONFIGURED',
        baseUrl: 'http://stash:9999',
        apiKey: null,
      },
    };
    prisma = {
      downloadDropIn: {
        findMany: jest.fn(
          ({
            where,
          }: {
            where: {
              status?: string | { in: string[] };
              sourcePath?: { in?: string[]; startsWith?: string };
            };
          }) =>
            Promise.resolve(
              dropIns.filter(
                (row) =>
                  (!where?.status ||
                    (typeof where.status === 'string'
                      ? row.status === where.status
                      : where.status.in.includes(row.status))) &&
                  (!where?.sourcePath?.in ||
                    where.sourcePath.in.includes(row.sourcePath)) &&
                  (!where?.sourcePath?.startsWith ||
                    row.sourcePath.startsWith(where.sourcePath.startsWith)),
              ),
            ),
        ),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<DownloadDropIn>;
          }) => {
            const found = dropIns.find((row) => row.id === where.id)!;
            Object.assign(found, data);
            return Promise.resolve({ ...found });
          },
        ),
        upsert: jest.fn(
          ({
            where,
            create,
            update,
          }: {
            where: { sourcePath: string };
            create: Partial<DownloadDropIn>;
            update: Partial<DownloadDropIn>;
          }) => {
            const found = dropIns.find(
              (row) => row.sourcePath === where.sourcePath,
            );
            if (found) {
              Object.assign(found, update);
              return Promise.resolve({ ...found });
            }
            const created = {
              id: `d${dropIns.length + 1}`,
              status: 'placed',
              finalPath: null,
              stashSceneId: null,
              error: null,
              attempts: 0,
              finishedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...create,
            } as DownloadDropIn;
            dropIns.push(created);
            return Promise.resolve({ ...created });
          },
        ),
      },
      downloadHandoff: {
        findMany: jest.fn(() => Promise.resolve(handoffs)),
      },
      downloadHandoffSettings: {
        findUnique: jest.fn(() => Promise.resolve({ ...settings })),
      },
      integrationConfig: {
        findUnique: jest.fn(({ where }: { where: { type: string } }) =>
          Promise.resolve(integrations[where.type] ?? null),
        ),
      },
      libraryAutomationSettings: {
        findUnique: jest.fn().mockResolvedValue({ generateNew: true }),
      },
    };
    sabnzbd = {
      history: jest.fn().mockResolvedValue([]),
      queue: jest.fn().mockResolvedValue([]),
      categoryFolders: jest.fn().mockResolvedValue({
        completed: '/downloads/complete',
        category: '/downloads/complete/stashboard-downloads',
      }),
    };
    stash = {
      getLibraryRoots: jest.fn().mockResolvedValue([library]),
      scanLibraryFolders: jest.fn().mockResolvedValue('job-1'),
      waitForJob: jest.fn().mockResolvedValue('FINISHED'),
      sceneIdsForPaths: jest.fn().mockResolvedValue(['88']),
      startLibraryTask: jest.fn().mockResolvedValue('job-2'),
    };
    organizer = {
      identifyNewScenes: jest.fn().mockResolvedValue({
        linked: [],
        matched: ['88'],
        proposed: [],
        left: [],
      }),
      placeInSceneFolder: jest.fn((_sceneId: string, file: string) =>
        Promise.resolve({ to: file, reason: null }),
      ),
    };
    activity = { record: jest.fn().mockResolvedValue(undefined) };
    const handoff = new DownloadHandoffService(
      prisma as unknown as PrismaService,
      sabnzbd as unknown as SabnzbdAdapter,
      stash as unknown as StashAdapter,
      organizer as unknown as OrganizerService,
    );
    handoff.sleep = () => Promise.resolve();
    service = new DownloadDropInService(
      prisma as unknown as PrismaService,
      handoff,
      sabnzbd as unknown as SabnzbdAdapter,
      stash as unknown as StashAdapter,
      organizer as unknown as OrganizerService,
    );
    for (const target of [handoff, service]) {
      Object.assign(target, {
        activity: activity as unknown as ActivityService,
      });
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('brings in a settled video, identifies it and puts it in its folder', async () => {
    const source = path.join(sabFolder, 'My.Clip', 'My.Clip.mp4');
    await write(source, 5_000);
    await write(path.join(sabFolder, 'My.Clip', 'My.Clip.nfo'));
    const inFolder = path.join(destination, 'Studio', 'Clip', 'Clip.mp4');
    organizer.placeInSceneFolder.mockResolvedValue({
      to: inFolder,
      reason: null,
    });
    // Not in Stash until it has scanned the folder.
    stash.sceneIdsForPaths.mockResolvedValueOnce([]);

    await service.check(later());
    // Seen once: it may still be being written.
    expect(await exists(source)).toBe(true);
    await service.check(later());

    const placed = path.join(destination, 'My.Clip.mp4');
    expect(await exists(source)).toBe(false);
    expect(await exists(placed)).toBe(true);
    // Stash scans just that folder and finds the scene by its exact path.
    expect(stash.scanLibraryFolders).toHaveBeenCalledWith(expect.anything(), [
      destination,
    ]);
    expect(stash.sceneIdsForPaths).toHaveBeenCalledWith(expect.anything(), [
      placed,
    ]);
    expect(organizer.identifyNewScenes).toHaveBeenCalledWith(['88']);
    expect(organizer.placeInSceneFolder).toHaveBeenCalledWith(
      '88',
      placed,
      destination,
    );
    expect(stash.startLibraryTask).toHaveBeenCalledWith(
      expect.anything(),
      'generate',
      ['88'],
    );
    expect(dropIns[0]).toMatchObject({
      sourcePath: source,
      status: 'imported',
      stashSceneId: '88',
      finalPath: inFolder,
    });
    // Its own folder in SABnzbd's folder is tidied away; the category's stays.
    expect(await exists(path.join(sabFolder, 'My.Clip'))).toBe(false);
    expect(await exists(sabFolder)).toBe(true);
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'download',
        title: 'Brought “My.Clip.mp4” into your library',
        detail: expect.stringContaining('Identified and linked'),
      }),
    );
  });

  it('waits until a file has stopped changing', async () => {
    const source = path.join(sabFolder, 'Fresh.mp4');
    await write(source);

    // Written just now: not settled, however often it's looked at.
    await twoChecks(Date.now());
    expect(await exists(source)).toBe(true);
    expect(organizer.identifyNewScenes).not.toHaveBeenCalled();

    // Still growing: the size changed since the last look.
    await fs.appendFile(source, Buffer.alloc(50, 1));
    await service.check(later());
    expect(await exists(source)).toBe(true);

    await service.check(later());
    expect(await exists(source)).toBe(false);
  });

  it('leaves SABnzbd’s own downloads alone: queued, finished, or tracked', async () => {
    const queued = path.join(sabFolder, 'Busy.Release', 'Busy.mkv');
    const finished = path.join(sabFolder, 'Release', 'Release.mkv');
    const tracked = path.join(sabFolder, 'Tracked.Release', 'Tracked.mkv');
    const unpacking = path.join(sabFolder, '_UNPACK_Other', 'Other.mkv');
    for (const file of [queued, finished, tracked, unpacking]) {
      await write(file);
    }
    sabnzbd.queue.mockResolvedValue([
      {
        nzoId: 'SABnzbd_nzo_2',
        name: 'Busy.Release',
        category: 'stashboard',
        status: 'Downloading',
      },
    ]);
    sabnzbd.history.mockResolvedValue([historyEntry()]);
    handoffs = [
      { sabPath: '/downloads/complete/stashboard-downloads/Tracked.Release' },
    ];

    await twoChecks();

    for (const file of [queued, finished, tracked, unpacking]) {
      expect(await exists(file)).toBe(true);
    }
    expect(await fs.readdir(destination)).toEqual([]);
    expect(dropIns).toEqual([]);
  });

  it('brings nothing in when SABnzbd’s queue or history can’t be read', async () => {
    await write(path.join(sabFolder, 'Loose.mp4'));
    sabnzbd.queue.mockRejectedValue(new Error('down'));

    await twoChecks();

    expect(await exists(path.join(sabFolder, 'Loose.mp4'))).toBe(true);
    expect(dropIns).toEqual([]);
  });

  it('copies without removing anything, and never brings a copy in twice', async () => {
    settings.importMode = 'copy';
    const source = path.join(sabFolder, 'Keep', 'Keep.mp4');
    await write(source);

    await twoChecks();
    await twoChecks();
    await twoChecks();

    expect(await exists(source)).toBe(true);
    expect(await fs.readdir(destination)).toEqual(['Keep.mp4']);
    expect(prisma.downloadDropIn.upsert).toHaveBeenCalledTimes(1);
    expect(organizer.identifyNewScenes).toHaveBeenCalledTimes(1);
    expect(dropIns).toHaveLength(1);
  });

  it('leaves a likely match for you to check, without moving it into a folder', async () => {
    organizer.identifyNewScenes.mockResolvedValue({
      linked: [],
      matched: [],
      proposed: ['88'],
      left: ['88'],
    });
    await write(path.join(sabFolder, 'Maybe.mp4'));

    await twoChecks();

    expect(organizer.placeInSceneFolder).not.toHaveBeenCalled();
    expect(dropIns[0]).toMatchObject({
      status: 'imported',
      finalPath: path.join(destination, 'Maybe.mp4'),
    });
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining('Check these matches'),
      }),
    );
  });

  it('says so when a file can’t be brought in, and doesn’t try it again', async () => {
    const source = path.join(sabFolder, 'Taken.mp4');
    await write(source, 5_000);
    await write(path.join(destination, 'Taken.mp4'), 3);

    await twoChecks();
    await twoChecks();

    expect(await exists(source)).toBe(true);
    expect((await fs.stat(path.join(destination, 'Taken.mp4'))).size).toBe(3);
    expect(dropIns[0]).toMatchObject({ status: 'failed' });
    expect(dropIns[0].error).toContain('already at');
    expect(titles()).toEqual([
      'Noticed “Taken.mp4” in the drop-in folder',
      'Couldn’t bring in “Taken.mp4”',
    ]);
    // Left alone from then on, and the Processing page says why.
    expect(service.status().skipped).toEqual([
      expect.objectContaining({
        name: 'Taken.mp4',
        reason: 'failed-before',
        detail: expect.stringContaining('already at'),
      }),
    ]);
  });

  it('keeps a drop-in folder that still has other videos, without a word', async () => {
    const first = path.join(sabFolder, 'Pack', 'One.mp4');
    const second = path.join(sabFolder, 'Pack', 'Two.mp4');
    await write(first);
    await write(second);

    await twoChecks();

    // Both brought in; the last one out removed the folder.
    expect(await exists(path.join(sabFolder, 'Pack'))).toBe(false);
    expect(titles().some((title) => title.startsWith('Left'))).toBe(false);
    expect(dropIns.map((row) => row.status)).toEqual(['imported', 'imported']);
  });

  it('tries again when Stash hasn’t picked the file up yet', async () => {
    stash.sceneIdsForPaths.mockResolvedValue([]);
    await write(path.join(sabFolder, 'Slow.mp4'));

    await twoChecks();
    expect(dropIns[0]).toMatchObject({ status: 'placed', attempts: 1 });

    stash.sceneIdsForPaths.mockResolvedValue(['88']);
    await service.check(later());
    expect(dropIns[0]).toMatchObject({
      status: 'imported',
      stashSceneId: '88',
    });
  });

  it('leaves files you put in alone while drop-ins are off', async () => {
    settings.dropIns = false;
    await write(path.join(sabFolder, 'Loose.mp4'));
    await write(path.join(sabFolder, 'Folder', 'Clip.mp4'));

    await twoChecks();

    expect(await exists(path.join(sabFolder, 'Loose.mp4'))).toBe(true);
    expect(await exists(path.join(sabFolder, 'Folder', 'Clip.mp4'))).toBe(true);
    expect(dropIns).toHaveLength(0);
  });

  describe('the other videos of a finished download', () => {
    const job = () => path.join(sabFolder, 'Release');
    const finished = (status = 'imported') => {
      handoffs.push({
        sabPath: '/downloads/complete/stashboard-downloads/Release',
        status,
      });
      sabnzbd.history.mockResolvedValue([historyEntry()]);
    };

    it('brings them in once its main video is in, drop-ins off too, then removes its folder', async () => {
      settings.dropIns = false;
      finished();
      await write(path.join(job(), 'Second.Scene.mp4'));
      await write(path.join(job(), 'Third.Scene.mp4'));
      await write(path.join(job(), 'Release.nfo'));

      await twoChecks();

      expect(await exists(path.join(destination, 'Second.Scene.mp4'))).toBe(
        true,
      );
      expect(await exists(path.join(destination, 'Third.Scene.mp4'))).toBe(
        true,
      );
      expect(dropIns.map((row) => row.status)).toEqual([
        'imported',
        'imported',
      ]);
      // Nothing but the release notes left: gone.
      expect(await exists(job())).toBe(false);
    });

    it('leaves them while the main video is still being brought in', async () => {
      finished('completed');
      await write(path.join(job(), 'Second.Scene.mp4'));

      await twoChecks();

      expect(await exists(path.join(job(), 'Second.Scene.mp4'))).toBe(true);
      expect(dropIns).toHaveLength(0);
    });

    it('leaves them when downloads are copied, not moved', async () => {
      settings.importMode = 'copy';
      finished();
      await write(path.join(job(), 'Second.Scene.mp4'));

      await twoChecks();

      expect(await exists(path.join(job(), 'Second.Scene.mp4'))).toBe(true);
      expect(dropIns).toHaveLength(0);
    });
  });

  it('removes a folder videos were brought in from once only leftovers are left', async () => {
    const folder = path.join(sabFolder, 'Pack');
    await write(path.join(folder, 'Pack.nfo'));
    await write(path.join(folder, 'Sample', 'sample.mp4'));
    dropIns.push({
      id: 'old',
      sourcePath: path.join(folder, 'Scene.mp4'),
      size: BigInt(100),
      status: 'imported',
      finalPath: path.join(destination, 'Scene.mp4'),
      stashSceneId: '88',
      error: null,
      attempts: 0,
      finishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await write(path.join(sabFolder, 'Untouched', 'notes.nfo'));

    await service.check(later());

    expect(await exists(folder)).toBe(false);
    // Nothing was ever brought in from this one: not Stashboard's to remove.
    expect(await exists(path.join(sabFolder, 'Untouched'))).toBe(true);
  });

  it('isn’t held back by folders that are already gone', async () => {
    const row = (sourcePath: string) => ({
      id: sourcePath,
      sourcePath,
      size: BigInt(100),
      status: 'imported',
      finalPath: path.join(destination, path.basename(sourcePath)),
      stashSceneId: '88',
      error: null,
      attempts: 0,
      finishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    for (let i = 0; i < 25; i += 1) {
      dropIns.push(row(path.join(sabFolder, `Gone ${i}`, 'Scene.mp4')));
    }
    const folder = path.join(sabFolder, 'Pack');
    await write(path.join(folder, 'Pack.nfo'));
    dropIns.push(row(path.join(folder, 'Scene.mp4')));

    await service.check(later());

    expect(await exists(folder)).toBe(false);
  });

  describe('status and problems', () => {
    let warn: jest.SpyInstance;
    let log: jest.SpyInstance;

    beforeEach(() => {
      warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      warn.mockClear();
      log.mockClear();
    });

    const said = (spy: jest.SpyInstance) =>
      spy.mock.calls.map(([message]) => String(message));

    it('says why it isn’t watching when drop-ins are off', async () => {
      settings.dropIns = false;
      await service.check();
      expect(service.status()).toMatchObject({
        state: 'off',
        reason: 'drop-ins-off',
        hint: expect.stringContaining('Finished downloads'),
        folder: null,
      });

      settings.enabled = false;
      await service.check();
      expect(service.status()).toMatchObject({
        state: 'off',
        reason: 'handoff-off',
      });
    });

    it('keeps saying drop-ins are off when the folder can’t be read for a finished download’s other videos', async () => {
      settings.dropIns = false;
      settings.sabPathTo = path.join(root, 'not-mounted');

      await service.check();

      expect(service.status()).toMatchObject({
        state: 'off',
        reason: 'drop-ins-off',
      });
      expect(
        said(warn).filter((line) => line.startsWith("Can't watch")),
      ).toHaveLength(0);
      expect(titles()).toEqual([]);
    });

    it('says SABnzbd isn’t set up', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(null);
      await service.check();
      expect(service.status()).toMatchObject({
        state: 'problem',
        reason: 'sab-not-set-up',
      });
    });

    it('warns once, with both paths, when the folder can’t be opened', async () => {
      // SABnzbd's path isn't mapped to where Stashboard sees it.
      settings.sabPathTo = path.join(root, 'not-mounted');
      await write(path.join(sabFolder, 'Loose.mp4'));

      await service.check();
      await service.check();
      await service.check();

      const status = service.status();
      expect(status).toMatchObject({
        state: 'problem',
        reason: 'folder-unreadable',
        folder: path.join(
          root,
          'not-mounted',
          'complete',
          'stashboard-downloads',
        ),
        sabFolder: '/downloads/complete/stashboard-downloads',
      });
      expect(status.message).toContain(
        '/downloads/complete/stashboard-downloads',
      );
      expect(status.message).toContain('doesn’t exist');
      expect(status.hint).toContain('Path in SABnzbd');
      const warnings = said(warn).filter((line) =>
        line.startsWith("Can't watch for drop-ins"),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(path.join(root, 'not-mounted'));
      expect(titles()).toEqual(['Can’t watch the drop-in folder']);

      // Fixed: said once that it's watching now.
      settings.sabPathTo = path.join(root, 'sab');
      await service.check();
      await service.check();
      expect(service.status()).toMatchObject({
        state: 'watching',
        reason: null,
        folder: sabFolder,
      });
      expect(said(log).filter((line) => line.startsWith('Watching '))).toEqual([
        `Watching ${sabFolder} (SABnzbd: /downloads/complete/stashboard-downloads) for drop-ins; videos put there are brought in once they stop changing.`,
      ]);
    });

    it('refuses a category without a folder of its own, leaving files alone', async () => {
      // Every category's downloads land in the Completed Download Folder.
      sabnzbd.categoryFolders.mockResolvedValue({
        completed: '/downloads/complete',
        category: '/downloads/complete',
        found: true,
        ownFolder: false,
        jobFolders: true,
      });
      const other = path.join(root, 'sab', 'complete', 'tv', 'Show.mkv');
      await write(other);

      await twoChecks();

      expect(await exists(other)).toBe(true);
      expect(service.status()).toMatchObject({
        state: 'problem',
        reason: 'shared-folder',
      });
    });

    it('explains a missing category or one without job folders', async () => {
      sabnzbd.categoryFolders.mockResolvedValue({
        completed: '/downloads/complete',
        category: '/downloads/complete',
        found: false,
        ownFolder: false,
        jobFolders: true,
      });
      await service.check();
      expect(service.status().reason).toBe('category-missing');

      sabnzbd.categoryFolders.mockResolvedValue({
        completed: '/downloads/complete',
        category: '/downloads/complete/stashboard-downloads',
        found: true,
        ownFolder: true,
        jobFolders: false,
      });
      await write(path.join(sabFolder, 'Loose.mp4'));
      await twoChecks();
      expect(service.status()).toMatchObject({
        state: 'problem',
        reason: 'no-job-folders',
        hint: expect.stringContaining('*'),
      });
      expect(await exists(path.join(sabFolder, 'Loose.mp4'))).toBe(true);
    });

    it('says when SABnzbd can’t be asked for its folders', async () => {
      sabnzbd.categoryFolders.mockRejectedValue(new Error('ECONNREFUSED'));
      await service.check();
      expect(service.status()).toMatchObject({
        state: 'problem',
        reason: 'sab-unreachable',
        message: expect.stringContaining('ECONNREFUSED'),
      });
    });

    it('lists what’s settling and what was left alone, and notices a file once', async () => {
      const loose = path.join(sabFolder, 'New.Scene.mp4');
      await write(loose, 1_234);
      await write(path.join(sabFolder, 'Pack', 'Sample', 'clip.mp4'));
      await write(path.join(sabFolder, 'Pack', 'cover.psd'));
      await write(path.join(sabFolder, 'Pack', 'Pack.nfo'));
      await write(path.join(sabFolder, '.New.Scene.mp4.partial.mp4'));
      await write(path.join(sabFolder, 'Release', 'Release.mkv'));
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      const now = Date.now();
      await service.check(now);
      await service.check(now + 5_000);

      const status = service.status();
      expect(status.state).toBe('watching');
      expect(status.settling).toEqual([
        {
          path: loose,
          name: 'New.Scene.mp4',
          size: 1_234,
          firstSeenAt: new Date(now).toISOString(),
          unchangedSince: new Date(now).toISOString(),
        },
      ]);
      expect(
        status.skipped.map((entry) => [entry.name, entry.reason]).sort(),
      ).toEqual([
        ['.New.Scene.mp4.partial.mp4', 'hidden'],
        ['Release', 'sab-job'],
        ['clip.mp4', 'sample'],
        ['cover.psd', 'not-video'],
      ]);
      expect(status.lastResult).toContain('1 new video');
      expect(titles()).toEqual([
        'Noticed “New.Scene.mp4” in the drop-in folder',
      ]);
      expect(
        said(log).filter((line) => line.startsWith('Noticed ')),
      ).toHaveLength(1);
    });

    it('brings in a file whose modified time is in the future once it stops changing', async () => {
      const source = path.join(sabFolder, 'Ahead.mp4');
      await write(source);
      // Copied with its times kept from a machine whose clock is a day ahead.
      const tomorrow = new Date(Date.now() + 24 * 3600_000);
      await fs.utimes(source, tomorrow, tomorrow);

      const now = Date.now();
      await service.check(now);
      await service.check(now + 10_000);
      expect(await exists(source)).toBe(true);
      await service.check(now + 50_000);

      expect(await exists(source)).toBe(false);
      expect(await exists(path.join(destination, 'Ahead.mp4'))).toBe(true);
    });

    it('looks again sooner while a file is settling', async () => {
      await write(path.join(sabFolder, 'Soon.mp4'));
      const before = Date.now();
      await service.check();
      const next = Date.parse(service.status().nextCheckAt!);
      expect(next - before).toBeLessThanOrEqual(60_000);

      // Nothing waiting: back to every 2 minutes.
      await fs.rm(path.join(sabFolder, 'Soon.mp4'));
      await service.check();
      expect(
        Date.parse(service.status().nextCheckAt!) - Date.now(),
      ).toBeGreaterThan(100_000);
    });

    it('checks now on request', async () => {
      await write(path.join(sabFolder, 'Now.mp4'));
      const status = await service.checkNow();
      expect(status.lastCheckAt).not.toBeNull();
      expect(status.checking).toBe(false);
      expect(status.settling.map((file) => file.name)).toEqual(['Now.mp4']);
    });

    it('retries a failed file by forgetting it, so it’s picked up again', async () => {
      const source = path.join(sabFolder, 'Taken.mp4');
      await write(source, 5_000);
      await write(path.join(destination, 'Taken.mp4'), 3);
      await twoChecks();
      expect(dropIns[0]).toMatchObject({ status: 'failed' });

      await fs.rm(path.join(destination, 'Taken.mp4'));
      prisma.downloadDropIn.findUnique = jest.fn(
        ({ where }: { where: { id: string } }) =>
          Promise.resolve(dropIns.find((row) => row.id === where.id) ?? null),
      );
      prisma.downloadDropIn.delete = jest.fn(
        ({ where }: { where: { id: string } }) => {
          dropIns = dropIns.filter((row) => row.id !== where.id);
          return Promise.resolve({});
        },
      );
      await expect(service.retry('d1')).resolves.toBeNull();
      await twoChecks();

      expect(await exists(source)).toBe(false);
      expect(dropIns[0]).toMatchObject({ status: 'imported' });
    });

    it('retries a moved file Stash never picked up by waiting for Stash again', async () => {
      dropIns.push({
        id: 'd9',
        sourcePath: '/gone/Old.mp4',
        size: BigInt(1),
        status: 'failed',
        finalPath: path.join(destination, 'Old.mp4'),
        stashSceneId: null,
        error: 'Stash hasn’t picked it up.',
        attempts: 5,
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      prisma.downloadDropIn.findUnique = jest.fn(() =>
        Promise.resolve(dropIns[0]),
      );
      await expect(service.retry('d9')).resolves.toMatchObject({
        status: 'placed',
        error: null,
      });
      expect(dropIns[0].attempts).toBe(0);
    });
  });

  it('never throws out of the interval', async () => {
    prisma.downloadHandoffSettings.findUnique.mockRejectedValue(
      new Error('database down'),
    );
    await expect(service.watch()).resolves.toBeUndefined();
  });

  describe('SABnzbd’s own downloads, left alone here', () => {
    /** What the “Left alone” list says about the job folder “Release”. */
    const saysAboutRelease = async (entries: SabnzbdHistoryEntry[]) => {
      await write(path.join(sabFolder, 'Release', 'Release.mkv'));
      sabnzbd.history.mockResolvedValue(entries);
      await service.check(Date.now());
      const skipped = service
        .status()
        .skipped.find((entry) => entry.name === 'Release');
      expect(skipped?.reason).toBe('sab-job');
      return skipped?.detail ?? '';
    };
    let followed: Array<{ nzoId: string; source: string }>;

    beforeEach(() => {
      followed = [];
      prisma.downloadHandoff.findMany = jest.fn(
        ({ where }: { where?: { nzoId?: { in: string[] } } }) =>
          Promise.resolve(
            where?.nzoId
              ? followed.filter((row) => where.nzoId!.in.includes(row.nzoId))
              : handoffs,
          ),
      );
      settings.sabManualJobs = true;
      settings.sabManualSince = new Date(Date.now() - 3600_000);
    });

    it('says Finished downloads brings in one added in SABnzbd by hand', async () => {
      await expect(
        saysAboutRelease([historyEntry({ completedAt: new Date() })]),
      ).resolves.toBe('SABnzbd download — brought in by Finished downloads.');
      // It isn't taken from here.
      expect(dropIns).toHaveLength(0);
    });

    it('says so for one picked up already, and for Stashboard’s own', async () => {
      followed = [{ nzoId: 'SABnzbd_nzo_1', source: 'sabnzbd-manual' }];
      await expect(
        saysAboutRelease([historyEntry({ completedAt: new Date() })]),
      ).resolves.toBe('SABnzbd download — brought in by Finished downloads.');
      followed = [{ nzoId: 'SABnzbd_nzo_1', source: 'stashboard' }];
      await expect(saysAboutRelease([historyEntry()])).resolves.toBe(
        'Sent to SABnzbd by Stashboard; Finished downloads takes care of it.',
      );
    });

    it('stays left alone with a hint when the option is off', async () => {
      settings.sabManualJobs = false;
      const detail = await saysAboutRelease([
        historyEntry({ completedAt: new Date() }),
      ]);
      expect(detail).toContain('left alone');
      expect(detail).toContain(
        'turn on “Also bring in downloads I add to this category in SABnzbd myself”',
      );
    });

    it('says why one finished before the option was turned on is left alone', async () => {
      await expect(
        saysAboutRelease([
          historyEntry({ completedAt: new Date(Date.now() - 2 * 3600_000) }),
        ]),
      ).resolves.toContain('finished before');
    });

    it('says a failed one is left alone', async () => {
      await expect(
        saysAboutRelease([
          historyEntry({ status: 'Failed', completedAt: new Date() }),
        ]),
      ).resolves.toContain('not finished there; left alone');
    });
  });
});
