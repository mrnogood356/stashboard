import { BadRequestException, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DownloadHandoff } from '@prisma/client';
import type { ActivityService } from '../activity/activity.service';
import type { OrganizerService } from '../organizer/organizer.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  SabnzbdAdapter,
  SabnzbdHistoryEntry,
} from '../providers/sabnzbd/sabnzbd.adapter';
import type { StashAdapter } from '../providers/stash/stash.adapter';
import {
  DownloadHandoffService,
  insideLibrary,
} from './download-handoff.service';

describe('DownloadHandoffService', () => {
  let root: string;
  /** SABnzbd's completed folder for the category, as Stashboard sees it. */
  let sabFolder: string;
  let library: string;
  let destination: string;
  let rows: DownloadHandoff[];
  let settings: Record<string, unknown>;
  let integrations: Record<string, Record<string, unknown> | null>;
  let prisma: Record<string, Record<string, jest.Mock>>;
  let sabnzbd: Record<string, jest.Mock>;
  let stash: Record<string, jest.Mock>;
  let organizer: Record<string, jest.Mock>;
  let activity: { record: jest.Mock };
  let service: DownloadHandoffService;

  const write = async (file: string, bytes = 100) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(bytes, 1));
  };
  const exists = (file: string) =>
    fs.lstat(file).then(
      () => true,
      () => false,
    );
  const handoff = (
    overrides: Partial<DownloadHandoff> = {},
  ): DownloadHandoff => ({
    id: `h${rows.length + 1}`,
    nzoId: 'SABnzbd_nzo_ours',
    source: 'stashboard',
    sceneId: 'fdb-scene-1',
    provider: 'FANSDB',
    releaseTitle: 'Jane.Doe.Beach.Day.1080p',
    status: 'sent',
    sabPath: null,
    finalPath: null,
    stashSceneId: null,
    error: null,
    attempts: 0,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  const historyEntry = (
    overrides: Partial<SabnzbdHistoryEntry> = {},
  ): SabnzbdHistoryEntry => ({
    nzoId: 'SABnzbd_nzo_ours',
    name: 'Jane.Doe.Beach.Day.1080p',
    category: 'stashboard',
    status: 'Completed',
    storage:
      '/downloads/complete/stashboard-downloads/Jane.Doe.Beach.Day.1080p',
    failMessage: null,
    ...overrides,
  });
  const row = (id = 'h1') => rows.find((entry) => entry.id === id)!;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-svc-'));
    sabFolder = path.join(root, 'sab', 'complete', 'stashboard-downloads');
    library = path.join(root, 'library');
    destination = path.join(library, 'downloads');
    await fs.mkdir(sabFolder, { recursive: true });
    await fs.mkdir(destination, { recursive: true });

    rows = [];
    settings = {
      key: 'GLOBAL',
      enabled: true,
      category: 'stashboard',
      destination,
      sabPathFrom: '/downloads',
      sabPathTo: path.join(root, 'sab'),
      importMode: 'move',
    };
    integrations = {
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
    const matches = (
      entry: DownloadHandoff,
      where: { status?: string | { in: string[] } },
    ) =>
      where.status === undefined ||
      (typeof where.status === 'string'
        ? entry.status === where.status
        : where.status.in.includes(entry.status));
    prisma = {
      downloadHandoff: {
        findMany: jest.fn(
          ({ where }: { where: { status?: string | { in: string[] } } }) =>
            Promise.resolve(
              rows.filter((entry) => matches(entry, where ?? {})),
            ),
        ),
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(rows.find((entry) => entry.id === where.id) ?? null),
        ),
        update: jest.fn(
          ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<DownloadHandoff>;
          }) => {
            const found = rows.find((entry) => entry.id === where.id)!;
            Object.assign(found, data);
            return Promise.resolve({ ...found });
          },
        ),
        create: jest.fn(({ data }: { data: Partial<DownloadHandoff> }) => {
          const created = handoff(data);
          rows.push(created);
          return Promise.resolve(created);
        }),
      },
      downloadHandoffSettings: {
        findUnique: jest.fn(() => Promise.resolve({ ...settings })),
        upsert: jest.fn(() => Promise.resolve({ ...settings })),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          Object.assign(settings, data);
          return Promise.resolve({ ...settings });
        }),
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
      addNzb: jest.fn().mockResolvedValue('SABnzbd_nzo_new'),
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
      sceneIdsForPaths: jest.fn().mockResolvedValue(['77']),
      startLibraryTask: jest.fn().mockResolvedValue('job-2'),
    };
    organizer = {
      linkDownloadedScene: jest.fn().mockResolvedValue({ title: 'Beach Day' }),
      placeInSceneFolder: jest.fn((_sceneId: string, file: string) =>
        Promise.resolve({ to: file, reason: null }),
      ),
    };
    activity = { record: jest.fn().mockResolvedValue(undefined) };
    service = new DownloadHandoffService(
      prisma as unknown as PrismaService,
      sabnzbd as unknown as SabnzbdAdapter,
      stash as unknown as StashAdapter,
      organizer as unknown as OrganizerService,
    );
    Object.assign(service, {
      activity: activity as unknown as ActivityService,
    });
    service.sleep = () => Promise.resolve();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('settings', () => {
    it('saves a destination inside one of Stash’s library folders', async () => {
      const saved = await service.updateSettings({
        destination: `${destination}/`,
        importMode: 'copy',
        sabPathFrom: ' /downloads/ ',
      });
      expect(saved).toMatchObject({
        destination,
        importMode: 'copy',
        sabPathFrom: '/downloads',
        libraryRoots: [library],
        sabnzbdReady: true,
      });
    });

    it('turns drop-ins on, showing the folder they come from as Stashboard sees it', async () => {
      settings.dropIns = false;
      const saved = await service.updateSettings({ dropIns: true });
      expect(saved).toMatchObject({ dropIns: true, dropInFolder: sabFolder });
      expect(sabnzbd.categoryFolders).toHaveBeenCalledWith(
        expect.anything(),
        'stashboard',
      );
    });

    it('refuses a destination outside Stash’s library', async () => {
      await expect(
        service.updateSettings({ destination: '/somewhere/else' }),
      ).rejects.toThrow(/inside one of Stash’s library folders/);
      expect(prisma.downloadHandoffSettings.update).not.toHaveBeenCalled();
    });

    it('refuses a destination that steps out with “..” or isn’t a full path', async () => {
      await expect(
        service.updateSettings({ destination: `${library}/../escape` }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.updateSettings({ destination: 'downloads' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to turn on without a destination, or with every category', async () => {
      settings.destination = null;
      settings.enabled = false;
      await expect(service.updateSettings({ enabled: true })).rejects.toThrow(
        'Pick the folder finished downloads go to first.',
      );
      await expect(
        service.updateSettings({ category: '*' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('knows what is inside a library folder', () => {
      expect(insideLibrary('/data/scenes', ['/data/scenes/'])).toBe(true);
      expect(insideLibrary('/data/scenes/dl', ['/data/scenes'])).toBe(true);
      expect(insideLibrary('/data/scenesx', ['/data/scenes'])).toBe(false);
    });
  });

  describe('sending', () => {
    it('adds the NZB to Stashboard’s category and remembers it', async () => {
      const result = await service.send({
        nzb: { content: new Uint8Array([1, 2]), fileName: 'x/y.nzb' },
        releaseTitle: 'Jane.Doe.Beach.Day',
        scene: { id: 'fdb-scene-1', provider: 'FANSDB', title: 'Beach Day' },
      });

      expect(sabnzbd.addNzb).toHaveBeenCalledWith(
        { baseUrl: 'http://sab:8080', apiKey: 'sab-key' },
        expect.objectContaining({
          category: 'stashboard',
          name: 'Jane.Doe.Beach.Day',
          fileName: 'x y.nzb',
        }),
      );
      expect(result).toMatchObject({
        sceneId: 'fdb-scene-1',
        provider: 'FANSDB',
        status: 'sent',
      });
      expect(rows[0].nzoId).toBe('SABnzbd_nzo_new');
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'download',
          title: 'Sent “Beach Day” to SABnzbd',
        }),
      );
    });

    it('is only active when turned on, with a destination and SABnzbd ready', async () => {
      await expect(service.isActive()).resolves.toBe(true);
      settings.enabled = false;
      await expect(service.isActive()).resolves.toBe(false);
      settings.enabled = true;
      integrations.SABNZBD = { ...integrations.SABNZBD, status: 'ERROR' };
      await expect(service.isActive()).resolves.toBe(false);
    });
  });

  describe('watching', () => {
    const video = () =>
      path.join(
        sabFolder,
        'Jane.Doe.Beach.Day.1080p',
        'Jane.Doe.Beach.Day.1080p.mkv',
      );

    it('does nothing at all without open downloads', async () => {
      await service.checkOpen();
      expect(sabnzbd.history).not.toHaveBeenCalled();
    });

    it('only touches its own downloads, never others in SABnzbd', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video(), 5_000);
      // Someone else's download in the same category, and one in Whisparr's.
      const theirs = path.join(sabFolder, 'Other.Release', 'Other.Release.mkv');
      await write(theirs, 9_000);
      const whisparrs = path.join(root, 'sab', 'complete', 'xxx', 'X', 'X.mkv');
      await write(whisparrs, 9_000);
      sabnzbd.history.mockResolvedValue([
        historyEntry({
          nzoId: 'SABnzbd_nzo_theirs',
          storage: '/downloads/complete/stashboard-downloads/Other.Release',
        }),
        historyEntry({
          nzoId: 'SABnzbd_nzo_whisparr',
          category: 'xxx',
          storage: '/downloads/complete/xxx/X',
        }),
        historyEntry(),
      ]);

      await service.checkOpen();

      expect(sabnzbd.history).toHaveBeenCalledWith(
        { baseUrl: 'http://sab:8080', apiKey: 'sab-key' },
        'stashboard',
      );
      expect(await exists(theirs)).toBe(true);
      expect(await exists(whisparrs)).toBe(true);
      expect(await fs.readdir(destination)).toEqual([
        'Jane.Doe.Beach.Day.1080p.mkv',
      ]);
      expect(row()).toMatchObject({
        status: 'imported',
        stashSceneId: '77',
        finalPath: path.join(destination, 'Jane.Doe.Beach.Day.1080p.mkv'),
        sabPath:
          '/downloads/complete/stashboard-downloads/Jane.Doe.Beach.Day.1080p',
      });
    });

    it('scans the folder, finds the scene by path and links the stored scene', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);
      const inFolder = path.join(
        destination,
        'Jane Studio',
        '2024-05-01 - Beach Day',
        '2024-05-01 - Beach Day.mkv',
      );
      organizer.placeInSceneFolder.mockResolvedValue({
        to: inFolder,
        reason: null,
      });

      await service.checkOpen();

      const finalPath = path.join(destination, 'Jane.Doe.Beach.Day.1080p.mkv');
      expect(stash.scanLibraryFolders).toHaveBeenCalledWith(expect.anything(), [
        destination,
      ]);
      expect(stash.sceneIdsForPaths).toHaveBeenCalledWith(expect.anything(), [
        finalPath,
      ]);
      expect(organizer.linkDownloadedScene).toHaveBeenCalledWith('77', {
        provider: 'FANSDB',
        sceneId: 'fdb-scene-1',
      });
      expect(stash.startLibraryTask).toHaveBeenCalledWith(
        expect.anything(),
        'generate',
        ['77'],
      );
      // Once linked, into its own folder inside the destination.
      expect(organizer.placeInSceneFolder).toHaveBeenCalledWith(
        '77',
        finalPath,
        destination,
      );
      expect(row()).toMatchObject({ status: 'imported', finalPath: inFolder });
      const imported = activity.record.mock.calls
        .map(([entry]) => entry as { title: string; detail: string })
        .find((entry) => entry.title.startsWith('Downloaded'));
      expect(imported?.title).toBe('Downloaded “Beach Day” into your library');
      expect(imported?.detail).toContain(`→ ${finalPath}`);
      expect(imported?.detail).toContain(`Put in its folder: ${inFolder}`);
      expect(imported?.detail).toContain('Linked to FansDB scene fdb-scene-1.');
    });

    it('says why when it couldn’t go into its own folder, leaving it in place', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);
      const finalPath = path.join(destination, 'Jane.Doe.Beach.Day.1080p.mkv');
      organizer.placeInSceneFolder.mockResolvedValue({
        to: finalPath,
        reason: `Something is already at /x.mkv, and nothing is replaced. It stayed at ${finalPath}.`,
      });

      await service.checkOpen();

      expect(row()).toMatchObject({ status: 'imported', finalPath });
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Downloaded “Beach Day” into your library',
          status: 'partial',
          detail: expect.stringContaining('Something is already at /x.mkv'),
        }),
      );
    });

    it('removes SABnzbd’s emptied folder with its leftovers after a move', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video(), 5_000);
      const job = path.dirname(video());
      await write(path.join(job, 'release.nfo'));
      await write(path.join(job, 'release.vol00+01.par2'));
      await write(path.join(job, 'Sample', 'sample.mkv'));
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(row().status).toBe('imported');
      expect(await exists(job)).toBe(false);
      // Never the category's folder itself.
      expect(await exists(sabFolder)).toBe(true);
    });

    it('leaves SABnzbd’s folder when another video is still in it, and says so', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video(), 5_000);
      const job = path.dirname(video());
      const other = path.join(job, 'Bonus.Scene.mkv');
      await write(other, 100);
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(row().status).toBe('imported');
      expect(await exists(other)).toBe(true);
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Left SABnzbd’s folder for “Jane.Doe.Beach.Day.1080p”',
          detail: expect.stringContaining('Bonus.Scene.mkv'),
        }),
      );
    });

    it('leaves SABnzbd’s folder when SABnzbd doesn’t say where its downloads go', async () => {
      sabnzbd.categoryFolders.mockResolvedValue({
        completed: null,
        category: null,
      });
      rows.push(handoff({ id: 'h1' }));
      await write(video(), 5_000);

      sabnzbd.history.mockResolvedValue([historyEntry()]);
      await service.checkOpen();

      expect(row().status).toBe('imported');
      expect(await exists(path.dirname(video()))).toBe(true);
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Left SABnzbd’s folder for “Jane.Doe.Beach.Day.1080p”',
        }),
      );
    });

    it('skips previews when Automation doesn’t make them', async () => {
      prisma.libraryAutomationSettings.findUnique.mockResolvedValue({
        generateNew: false,
      });
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(row().status).toBe('imported');
      expect(stash.startLibraryTask).not.toHaveBeenCalled();
    });

    it('copies instead of moving when set to copy', async () => {
      settings.importMode = 'copy';
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(await exists(video())).toBe(true);
      expect(
        await exists(path.join(destination, 'Jane.Doe.Beach.Day.1080p.mkv')),
      ).toBe(true);
      expect(row().status).toBe('imported');
      // A copy leaves SABnzbd's folder as it was, without a word.
      expect(sabnzbd.categoryFolders).not.toHaveBeenCalled();
    });

    it('marks a failed SABnzbd download failed, with SABnzbd’s reason', async () => {
      rows.push(handoff({ id: 'h1' }));
      sabnzbd.history.mockResolvedValue([
        historyEntry({
          status: 'Failed',
          storage: null,
          failMessage: 'Out of retention',
        }),
      ]);

      await service.checkOpen();

      expect(row()).toMatchObject({
        status: 'failed',
        error: 'SABnzbd couldn’t download it: Out of retention.',
      });
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'download', status: 'failed' }),
      );
      expect(stash.scanLibraryFolders).not.toHaveBeenCalled();
    });

    it('leaves a download moved to another category alone', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry({ category: 'xxx' })]);

      await service.checkOpen();

      expect(await exists(video())).toBe(true);
      expect(row().status).toBe('failed');
      expect(row().error).toContain('“xxx” category');
    });

    it('leaves the download alone when something is already at the target', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(video(), 5_000);
      const taken = path.join(destination, 'Jane.Doe.Beach.Day.1080p.mkv');
      await write(taken, 3);
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(await exists(video())).toBe(true);
      expect((await fs.stat(taken)).size).toBe(3);
      expect(row().status).toBe('failed');
      expect(row().error).toContain('already at');
    });

    it('refuses when the destination is no longer in Stash’s library', async () => {
      stash.getLibraryRoots.mockResolvedValue(['/other/library']);
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(await exists(video())).toBe(true);
      expect(row().status).toBe('failed');
      expect(row().error).toContain(
        'isn’t inside one of Stash’s library folders',
      );
    });

    it('waits when Stash can’t be asked, without moving anything', async () => {
      stash.getLibraryRoots.mockRejectedValue(new Error('down'));
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(await exists(video())).toBe(true);
      expect(row().status).toBe('sent');
    });

    it('says plainly when there’s no video to move', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(
        path.join(sabFolder, 'Jane.Doe.Beach.Day.1080p', 'readme.nfo'),
      );
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();

      expect(row().status).toBe('failed');
      expect(row().error).toContain('No video file in');
    });

    it('marks downloads still in progress as downloading', async () => {
      rows.push(handoff({ id: 'h1' }));
      rows.push(handoff({ id: 'h2', nzoId: 'SABnzbd_nzo_queued' }));
      sabnzbd.history.mockResolvedValue([
        historyEntry({ status: 'Extracting' }),
      ]);
      sabnzbd.queue.mockResolvedValue([
        {
          nzoId: 'SABnzbd_nzo_queued',
          category: 'stashboard',
          status: 'Downloading',
        },
        {
          nzoId: 'SABnzbd_nzo_someone',
          category: 'stashboard',
          status: 'Queued',
        },
      ]);

      await service.checkOpen();

      expect(row('h1').status).toBe('downloading');
      expect(row('h2').status).toBe('downloading');
      expect(rows).toHaveLength(2);
    });

    it('stops watching a download SABnzbd forgot about', async () => {
      rows.push(
        handoff({
          id: 'h1',
          createdAt: new Date(Date.now() - 4 * 24 * 3600_000),
        }),
      );

      await service.checkOpen();

      expect(row().status).toBe('ignored');
    });

    it('keeps watching when SABnzbd’s queue can’t be read', async () => {
      sabnzbd.queue.mockRejectedValue(new Error('timeout'));
      rows.push(
        handoff({
          id: 'h1',
          createdAt: new Date(Date.now() - 4 * 24 * 3600_000),
        }),
      );

      await service.checkOpen();

      expect(row().status).toBe('sent');
    });

    it('tries linking again later, then gives up with the reason', async () => {
      stash.sceneIdsForPaths.mockResolvedValue([]);
      rows.push(handoff({ id: 'h1' }));
      await write(video());
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await service.checkOpen();
      expect(row()).toMatchObject({ status: 'completed', attempts: 1 });
      expect(row().error).toContain('Stash hasn’t picked it up');

      for (let index = 0; index < 4; index += 1) {
        await service.checkOpen();
      }
      expect(row().status).toBe('failed');
      expect(row().error).toContain('Link it in Library Tools.');
      // The file stays where it was moved to.
      expect(
        await exists(path.join(destination, 'Jane.Doe.Beach.Day.1080p.mkv')),
      ).toBe(true);
    });

    it('does nothing while turned off', async () => {
      settings.enabled = false;
      rows.push(handoff({ id: 'h1' }));

      await service.checkOpen();

      expect(sabnzbd.history).not.toHaveBeenCalled();
      expect(row().status).toBe('sent');
    });

    it('never throws out of the interval', async () => {
      prisma.downloadHandoff.findMany.mockRejectedValue(new Error('db down'));
      await expect(service.watch()).resolves.toBeUndefined();

      prisma.downloadHandoff.findMany.mockResolvedValue([handoff()]);
      sabnzbd.history.mockRejectedValue(new Error('sab down'));
      await expect(service.watch()).resolves.toBeUndefined();
    });
  });

  it('stops watching one download when asked, touching nothing else', async () => {
    rows.push(handoff({ id: 'h1' }));
    await expect(service.ignore('h1')).resolves.toMatchObject({
      status: 'ignored',
    });
    expect(sabnzbd.history).not.toHaveBeenCalled();
  });

  describe('retry', () => {
    beforeEach(() => {
      // The check it starts is run by hand here.
      service.watch = jest.fn().mockResolvedValue(undefined);
    });

    it('looks for a download that couldn’t be moved in SABnzbd’s history again', async () => {
      rows.push(
        handoff({
          id: 'h1',
          status: 'failed',
          error: 'Something is already at …',
          attempts: 2,
          finishedAt: new Date(),
        }),
      );
      await write(
        path.join(sabFolder, 'Jane.Doe.Beach.Day.1080p', 'Jane.mkv'),
        500,
      );
      sabnzbd.history.mockResolvedValue([historyEntry()]);

      await expect(service.retry('h1')).resolves.toMatchObject({
        status: 'sent',
        error: null,
      });
      expect(service.watch).toHaveBeenCalled();
      await service.checkOpen();
      expect(row()).toMatchObject({ status: 'imported', stashSceneId: '77' });
      expect(await exists(path.join(destination, 'Jane.mkv'))).toBe(true);
    });

    it('waits for Stash again for one already moved', async () => {
      rows.push(
        handoff({
          id: 'h1',
          status: 'failed',
          finalPath: path.join(destination, 'Jane.mkv'),
          attempts: 5,
        }),
      );
      await expect(service.retry('h1')).resolves.toMatchObject({
        status: 'completed',
      });
      expect(row().attempts).toBe(0);
    });

    it('leaves anything that hasn’t failed as it is', async () => {
      rows.push(handoff({ id: 'h1', status: 'imported' }));
      await expect(service.retry('h1')).resolves.toMatchObject({
        status: 'imported',
      });
      expect(prisma.downloadHandoff.update).not.toHaveBeenCalled();
      await expect(service.retry('nope')).rejects.toThrow('isn’t listed');
    });
  });

  describe('downloads added in SABnzbd by hand', () => {
    const manualFolder = () => path.join(sabFolder, 'Manual.Release');
    const manualVideo = () => path.join(manualFolder(), 'Manual.Release.mkv');
    const manualEntry = (overrides: Partial<SabnzbdHistoryEntry> = {}) =>
      historyEntry({
        nzoId: 'SABnzbd_nzo_manual',
        name: 'Manual.Release',
        storage: '/downloads/complete/stashboard-downloads/Manual.Release',
        completedAt: new Date(),
        ...overrides,
      });
    const manualRows = () =>
      rows.filter((entry) => entry.source === 'sabnzbd-manual');

    beforeEach(() => {
      settings.sabManualJobs = true;
      settings.sabManualSince = new Date(Date.now() - 3600_000);
      organizer.identifyNewScenes = jest.fn().mockResolvedValue({
        linked: [],
        matched: ['77'],
        proposed: [],
        left: [],
      });
      organizer.placeInSceneFolder.mockResolvedValue({
        to: path.join(destination, 'Studio', 'Manual', 'Manual.mkv'),
        reason: null,
      });
    });

    it('picks up a finished one, moves it in, identifies it and tidies SABnzbd’s folder', async () => {
      await write(manualVideo(), 5_000);
      await write(path.join(manualFolder(), 'Manual.Release.nfo'));
      sabnzbd.history.mockResolvedValue([manualEntry()]);

      await service.checkOpen();

      expect(manualRows()).toHaveLength(1);
      const [adopted] = manualRows();
      expect(adopted).toMatchObject({
        nzoId: 'SABnzbd_nzo_manual',
        sceneId: null,
        provider: null,
        releaseTitle: 'Manual.Release',
        status: 'imported',
        stashSceneId: '77',
        sabPath: '/downloads/complete/stashboard-downloads/Manual.Release',
        finalPath: path.join(destination, 'Studio', 'Manual', 'Manual.mkv'),
      });
      const placed = path.join(destination, 'Manual.Release.mkv');
      expect(await exists(placed)).toBe(true);
      // SABnzbd's folder for it is only leftovers now: gone.
      expect(await exists(manualFolder())).toBe(false);
      // No catalog scene was asked for, so it's identified, not linked.
      expect(organizer.linkDownloadedScene).not.toHaveBeenCalled();
      expect(organizer.identifyNewScenes).toHaveBeenCalledWith(['77']);
      expect(organizer.placeInSceneFolder).toHaveBeenCalledWith(
        '77',
        placed,
        destination,
      );
      expect(stash.startLibraryTask).toHaveBeenCalledWith(
        expect.anything(),
        'generate',
        ['77'],
      );
      const titles = activity.record.mock.calls.map(
        ([entry]) => (entry as { title: string }).title,
      );
      expect(titles).toEqual([
        'Picked up “Manual.Release” from SABnzbd',
        'Downloaded “Manual.Release” into your library',
      ]);
      expect(activity.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining('Added in SABnzbd'),
        }),
      );
    });

    it('never picks up the same job twice', async () => {
      await write(manualVideo(), 5_000);
      sabnzbd.history.mockResolvedValue([manualEntry()]);
      await service.checkOpen();
      await service.checkOpen();
      expect(prisma.downloadHandoff.create).toHaveBeenCalledTimes(1);
      expect(manualRows()).toHaveLength(1);
    });

    it('treats a job picked up meanwhile (same id) as already done', async () => {
      sabnzbd.history.mockResolvedValue([manualEntry()]);
      prisma.downloadHandoff.create.mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
        }),
      );
      await expect(
        service.adoptManualJobs({ ...settings } as never),
      ).resolves.toBe(0);
    });

    it('leaves Stashboard’s own downloads to be linked to their scene', async () => {
      rows.push(handoff({ id: 'h1' }));
      await write(
        path.join(sabFolder, 'Jane.Doe.Beach.Day.1080p', 'Jane.mkv'),
        500,
      );
      sabnzbd.history.mockResolvedValue([
        historyEntry({ completedAt: new Date() }),
      ]);
      await service.checkOpen();
      expect(manualRows()).toHaveLength(0);
      expect(row()).toMatchObject({ status: 'imported', source: 'stashboard' });
      expect(organizer.linkDownloadedScene).toHaveBeenCalled();
      expect(organizer.identifyNewScenes).not.toHaveBeenCalled();
    });

    it('leaves failed, unfinished, other-category and older jobs alone', async () => {
      const old = new Date(Date.now() - 2 * 3600_000);
      sabnzbd.history.mockResolvedValue([
        manualEntry({ nzoId: 'a', status: 'Failed', failMessage: 'CRC' }),
        manualEntry({ nzoId: 'b', status: 'Extracting' }),
        manualEntry({ nzoId: 'c', status: 'Verifying' }),
        manualEntry({ nzoId: 'd', category: 'xxx' }),
        manualEntry({ nzoId: 'e', completedAt: old }),
        manualEntry({ nzoId: 'f', completedAt: null }),
        manualEntry({ nzoId: 'g', storage: null }),
      ]);
      await write(manualVideo(), 5_000);
      await service.checkOpen();
      expect(prisma.downloadHandoff.create).not.toHaveBeenCalled();
      expect(await exists(manualVideo())).toBe(true);
    });

    it('starts from the last day on its first run, and remembers that', async () => {
      settings.sabManualSince = null;
      const recent = manualEntry({
        nzoId: 'recent',
        completedAt: new Date(Date.now() - 2 * 3600_000),
      });
      const old = manualEntry({
        nzoId: 'old',
        name: 'Old.Release',
        storage: '/downloads/complete/stashboard-downloads/Old.Release',
        completedAt: new Date(Date.now() - 30 * 3600_000),
      });
      sabnzbd.history.mockResolvedValue([recent, old]);
      await write(manualVideo(), 5_000);
      await write(path.join(sabFolder, 'Old.Release', 'Old.mkv'), 5_000);

      const before = Date.now();
      await service.checkOpen();

      const since = settings.sabManualSince as Date;
      expect(since).toBeInstanceOf(Date);
      expect(since.getTime()).toBeGreaterThanOrEqual(before - 24 * 3600_000);
      expect(since.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 3600_000);
      expect(manualRows().map((entry) => entry.nzoId)).toEqual(['recent']);
      expect(await exists(path.join(sabFolder, 'Old.Release', 'Old.mkv'))).toBe(
        true,
      );
    });

    it('does nothing with the option off, or with Finished downloads off', async () => {
      sabnzbd.history.mockResolvedValue([manualEntry()]);
      settings.sabManualJobs = false;
      await service.checkOpen();
      settings.sabManualJobs = true;
      settings.enabled = false;
      await service.checkOpen();
      expect(sabnzbd.history).not.toHaveBeenCalled();
      expect(prisma.downloadHandoff.create).not.toHaveBeenCalled();
    });

    it('takes nothing when the category shares SABnzbd’s completed folder, saying so once', async () => {
      sabnzbd.categoryFolders.mockResolvedValue({
        completed: '/downloads/complete',
        category: '/downloads/complete',
        found: true,
        ownFolder: false,
        jobFolders: true,
      });
      sabnzbd.history.mockResolvedValue([manualEntry()]);
      await write(manualVideo(), 5_000);
      await service.checkOpen();
      await service.checkOpen();
      expect(prisma.downloadHandoff.create).not.toHaveBeenCalled();
      expect(await exists(manualVideo())).toBe(true);
      expect(activity.record).toHaveBeenCalledTimes(1);
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Can’t bring in downloads added in SABnzbd',
          status: 'failed',
        }),
      );
    });

    it('never takes the category’s whole folder', async () => {
      // SABnzbd claims the job is the category folder itself.
      sabnzbd.history.mockResolvedValue([
        manualEntry({ storage: '/downloads/complete/stashboard-downloads' }),
      ]);
      await write(manualVideo(), 5_000);
      await service.checkOpen();
      expect(manualRows()[0]).toMatchObject({ status: 'failed' });
      expect(manualRows()[0].error).toContain('isn’t a download’s own folder');
      expect(await exists(manualVideo())).toBe(true);
    });

    it('leaves it unplaced when there’s only a likely match, saying so', async () => {
      organizer.identifyNewScenes.mockResolvedValue({
        linked: [],
        matched: [],
        proposed: ['77'],
        left: ['77'],
      });
      await write(manualVideo(), 5_000);
      sabnzbd.history.mockResolvedValue([manualEntry()]);
      await service.checkOpen();
      expect(manualRows()[0]).toMatchObject({
        status: 'imported',
        finalPath: path.join(destination, 'Manual.Release.mkv'),
      });
      expect(organizer.placeInSceneFolder).not.toHaveBeenCalled();
      expect(activity.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining('Check these matches'),
        }),
      );
    });

    it('can be tried again after failing', async () => {
      service.watch = jest.fn().mockResolvedValue(undefined);
      rows.push(
        handoff({
          id: 'm1',
          nzoId: 'SABnzbd_nzo_manual',
          source: 'sabnzbd-manual',
          sceneId: null,
          provider: null,
          releaseTitle: 'Manual.Release',
          status: 'failed',
          error: 'No video file in …',
        }),
      );
      sabnzbd.history.mockResolvedValue([manualEntry()]);
      await write(manualVideo(), 5_000);
      await expect(service.retry('m1')).resolves.toMatchObject({
        status: 'sent',
        source: 'sabnzbd-manual',
        sceneId: null,
      });
      await service.checkOpen();
      expect(row('m1')).toMatchObject({ status: 'imported' });
      expect(prisma.downloadHandoff.create).not.toHaveBeenCalled();
    });

    describe('the setting', () => {
      it('shows it, and starts from now when it’s turned on', async () => {
        settings.sabManualJobs = false;
        const before = Date.now();
        const saved = await service.updateSettings({ sabManualJobs: true });
        expect(saved.sabManualJobs).toBe(true);
        expect(Date.parse(saved.sabManualSince!)).toBeGreaterThanOrEqual(
          before,
        );
      });

      it('keeps the cutoff when saved while already on, and when turned off', async () => {
        const since = settings.sabManualSince as Date;
        await service.updateSettings({ importMode: 'copy' });
        expect(settings.sabManualSince).toBe(since);
        const saved = await service.updateSettings({ sabManualJobs: false });
        expect(saved).toMatchObject({
          sabManualJobs: false,
          sabManualSince: since.toISOString(),
        });
      });

      it('starts from now when Finished downloads itself is turned on', async () => {
        settings.enabled = false;
        const before = Date.now();
        await service.updateSettings({ enabled: true });
        expect(
          (settings.sabManualSince as Date).getTime(),
        ).toBeGreaterThanOrEqual(before);
      });
    });
  });
});
