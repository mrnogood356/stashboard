import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findLooseVideos,
  findMainVideo,
  HandoffFileError,
  isInside,
  placeVideo,
  removeJobFolder,
} from './download-handoff.files';

describe('finished download files', () => {
  let root: string;
  let job: string;
  let library: string;

  const write = async (file: string, bytes: number) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(bytes, 1));
  };
  const exists = (file: string) =>
    fs.lstat(file).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-'));
    job = path.join(root, 'sab', 'stashboard-downloads', 'Release.Name');
    library = path.join(root, 'library', 'downloads');
    await fs.mkdir(job, { recursive: true });
    await fs.mkdir(library, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('findMainVideo', () => {
    it('picks the largest video and skips samples and other files', async () => {
      await write(path.join(job, 'Release.Name.mkv'), 5_000);
      await write(path.join(job, 'Sample', 'Release.Name.mkv'), 9_000);
      await write(path.join(job, 'release.name-sample.mp4'), 8_000);
      await write(path.join(job, 'extras', 'bts.mp4'), 1_000);
      await write(path.join(job, 'Release.Name.nfo'), 90_000);

      await expect(findMainVideo(job)).resolves.toBe(
        path.join(job, 'Release.Name.mkv'),
      );
    });

    it('finds nothing in a folder without videos, or one that isn’t there', async () => {
      await write(path.join(job, 'Release.Name.nfo'), 10);
      await expect(findMainVideo(job)).resolves.toBeNull();
      await expect(
        findMainVideo(path.join(root, 'missing')),
      ).resolves.toBeNull();
    });

    it('takes a single video file as it is', async () => {
      const file = path.join(job, 'Release.Name.mp4');
      await write(file, 10);
      await expect(findMainVideo(file)).resolves.toBe(file);
    });
  });

  describe('placeVideo', () => {
    it('moves the video into the destination under its own name', async () => {
      const source = path.join(job, 'Release.Name.mkv');
      await write(source, 1_000);

      const placed = await placeVideo({
        source,
        destination: library,
        mode: 'move',
        tag: 'h1',
        within: path.join(root, 'sab'),
      });

      expect(placed).toBe(path.join(library, 'Release.Name.mkv'));
      expect(await exists(placed)).toBe(true);
      expect(await exists(source)).toBe(false);
      // The temporary name is gone.
      expect(await fs.readdir(library)).toEqual(['Release.Name.mkv']);
    });

    it('copies and leaves the original when set to copy', async () => {
      const source = path.join(job, 'Release.Name.mkv');
      await write(source, 1_000);

      const placed = await placeVideo({
        source,
        destination: library,
        mode: 'copy',
        tag: 'h1',
      });

      expect(await exists(placed)).toBe(true);
      expect(await exists(source)).toBe(true);
      expect((await fs.stat(placed)).size).toBe(1_000);
    });

    it('leaves everything alone when something is already at the target', async () => {
      const source = path.join(job, 'Release.Name.mkv');
      await write(source, 1_000);
      await write(path.join(library, 'Release.Name.mkv'), 7);

      await expect(
        placeVideo({ source, destination: library, mode: 'move', tag: 'h1' }),
      ).rejects.toThrow(/already at/);

      expect(await exists(source)).toBe(true);
      expect((await fs.stat(path.join(library, 'Release.Name.mkv'))).size).toBe(
        7,
      );
    });

    it('refuses a source that isn’t a video, or isn’t there', async () => {
      const nfo = path.join(job, 'Release.Name.nfo');
      await write(nfo, 10);
      await expect(
        placeVideo({
          source: nfo,
          destination: library,
          mode: 'move',
          tag: 'h',
        }),
      ).rejects.toBeInstanceOf(HandoffFileError);
      await expect(
        placeVideo({
          source: path.join(job, 'gone.mkv'),
          destination: library,
          mode: 'move',
          tag: 'h',
        }),
      ).rejects.toThrow('The finished file isn’t there any more.');
      expect(await exists(nfo)).toBe(true);
    });

    it('refuses a source that resolves outside SABnzbd’s folder', async () => {
      const outside = path.join(root, 'private', 'home.mkv');
      await write(outside, 10);
      // A link inside the download pointing elsewhere.
      const link = path.join(job, 'Release.Name.mkv');
      await fs.symlink(outside, link);

      await expect(
        placeVideo({
          source: link,
          destination: library,
          mode: 'move',
          tag: 'h',
          within: path.join(root, 'sab'),
        }),
      ).rejects.toThrow(/outside SABnzbd’s download folder/);
      expect(await exists(outside)).toBe(true);
      expect(await fs.readdir(library)).toEqual([]);
    });

    it('refuses a destination Stashboard can’t see', async () => {
      const source = path.join(job, 'Release.Name.mkv');
      await write(source, 10);
      await expect(
        placeVideo({
          source,
          destination: path.join(root, 'nowhere', 'deeper'),
          mode: 'move',
          tag: 'h',
        }),
      ).rejects.toThrow(/can’t see the destination/);
      expect(await exists(source)).toBe(true);
      expect(await exists(path.join(root, 'nowhere'))).toBe(false);
    });

    it('makes the destination again when it was removed but its parent is there', async () => {
      const source = path.join(job, 'Release.Name.mkv');
      await write(source, 10);
      const destination = path.join(root, 'fansdb');
      await expect(
        placeVideo({ source, destination, mode: 'move', tag: 'h' }),
      ).resolves.toBe(path.join(destination, 'Release.Name.mkv'));
    });

    it('resolves a destination given with “..” and still lands inside it', async () => {
      const source = path.join(job, 'Release.Name.mkv');
      await write(source, 10);
      const sneaky = path.join(library, '..', 'downloads');

      const placed = await placeVideo({
        source,
        destination: sneaky,
        mode: 'move',
        tag: 'h',
      });

      expect(await exists(path.join(library, 'Release.Name.mkv'))).toBe(true);
      expect(placed).toBe(path.join(sneaky, 'Release.Name.mkv'));
    });
  });

  it('knows what is inside a folder', () => {
    expect(isInside('/a/b/c.mkv', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/bc/d.mkv', '/a/b')).toBe(false);
    expect(isInside('/a/b/../c/d.mkv', '/a/b')).toBe(false);
  });

  describe('removeJobFolder', () => {
    let category: string;
    let completed: string;

    beforeEach(() => {
      completed = path.join(root, 'sab');
      category = path.join(completed, 'stashboard-downloads');
    });
    const remove = (folder: string) =>
      removeJobFolder({
        folder,
        categoryFolder: category,
        completedFolder: completed,
      });

    it('removes the folder with its leftovers, samples and empty folders', async () => {
      await write(path.join(job, 'release.nfo'), 10);
      await write(path.join(job, 'release.par2'), 10);
      await write(path.join(job, 'release.vol03+04.par2'), 10);
      await write(path.join(job, 'readme.txt'), 10);
      await write(path.join(job, '.DS_Store'), 10);
      await write(path.join(job, 'Sample', 'release-sample.mkv'), 900);
      await fs.mkdir(path.join(job, 'Subs', 'empty'), { recursive: true });

      await expect(remove(job)).resolves.toEqual({
        result: 'removed',
        folder: job,
      });
      expect(await exists(job)).toBe(false);
      expect(await exists(category)).toBe(true);
    });

    it('says when there is nothing there any more', async () => {
      await expect(remove(path.join(category, 'Gone'))).resolves.toMatchObject({
        result: 'gone',
      });
    });

    it('never removes the category folder itself', async () => {
      const result = await remove(category);
      expect(result).toMatchObject({ result: 'kept' });
      expect(await exists(category)).toBe(true);
      // Written another way, it's still the same folder.
      expect(await remove(`${category}/`)).toMatchObject({ result: 'kept' });
      expect(await remove(path.join(job, '..'))).toMatchObject({
        result: 'kept',
      });
    });

    it('never removes the completed folder, or anything outside the category', async () => {
      expect(await remove(completed)).toMatchObject({ result: 'kept' });
      const elsewhere = path.join(root, 'elsewhere', 'Release');
      await fs.mkdir(elsewhere, { recursive: true });
      expect(await remove(elsewhere)).toMatchObject({ result: 'kept' });
      expect(await exists(elsewhere)).toBe(true);
    });

    it('never removes a category folder that is the completed folder', async () => {
      // A category with no folder of its own downloads into the completed folder.
      category = completed;
      expect(await remove(completed)).toMatchObject({ result: 'kept' });
      expect(await exists(completed)).toBe(true);
    });

    it('doesn’t follow a link out of the category folder', async () => {
      const outside = path.join(root, 'precious');
      await write(path.join(outside, 'keep.txt'), 10);
      const link = path.join(category, 'Linked.Release');
      await fs.symlink(outside, link);

      expect(await remove(link)).toMatchObject({ result: 'kept' });
      expect(await exists(path.join(outside, 'keep.txt'))).toBe(true);
    });

    it('leaves a folder with a link inside it', async () => {
      const outside = path.join(root, 'precious');
      await write(path.join(outside, 'keep.txt'), 10);
      await fs.symlink(outside, path.join(job, 'shortcut'));

      expect(await remove(job)).toMatchObject({ result: 'kept' });
      expect(await exists(path.join(outside, 'keep.txt'))).toBe(true);
    });

    it('leaves a folder that still has another video, naming it', async () => {
      await write(path.join(job, 'release.nfo'), 10);
      await write(path.join(job, 'Bonus.mkv'), 10);

      const result = await remove(job);
      expect(result).toMatchObject({ result: 'kept', videos: ['Bonus.mkv'] });
      expect(result.result === 'kept' && result.reason).toContain('Bonus.mkv');
      // Nothing is removed, leftovers included.
      expect(await exists(path.join(job, 'release.nfo'))).toBe(true);
    });

    it('leaves a folder with files it doesn’t know', async () => {
      await write(path.join(job, 'release.r00'), 10);
      await write(path.join(job, 'notes.docx'), 10);

      const result = await remove(job);
      expect(result).toMatchObject({ result: 'kept', videos: [] });
      expect(result.result === 'kept' && result.reason).toContain(
        'other files',
      );
      expect(await exists(path.join(job, 'notes.docx'))).toBe(true);
    });

    it('leaves it when the category folder can’t be seen', async () => {
      category = path.join(root, 'missing');
      expect(await remove(job)).toMatchObject({ result: 'kept' });
      expect(await exists(job)).toBe(true);
    });
  });

  describe('findLooseVideos', () => {
    let category: string;

    beforeEach(() => {
      category = path.join(root, 'sab', 'stashboard-downloads');
    });

    it('finds videos, leaving out samples, hidden files and SABnzbd’s work folders', async () => {
      await write(path.join(category, 'Loose.mp4'), 10);
      await write(path.join(category, 'Folder', 'In.Folder.mkv'), 10);
      await write(path.join(category, 'Folder', 'Sample', 'x.mkv'), 10);
      await write(path.join(category, 'Folder', 'info.nfo'), 10);
      await write(path.join(category, '.hidden.mp4'), 10);
      await write(path.join(category, '_UNPACK_Busy', 'Busy.mkv'), 10);
      await write(path.join(category, '_FAILED_Bad', 'Bad.mkv'), 10);
      await fs.symlink(
        path.join(category, 'Loose.mp4'),
        path.join(category, 'Link.mp4'),
      );

      expect(await findLooseVideos(category)).toEqual([
        path.join(category, 'Folder', 'In.Folder.mkv'),
        path.join(category, 'Loose.mp4'),
      ]);
    });

    it('skips whatever is inside the folders it’s told to', async () => {
      await write(path.join(category, 'Loose.mp4'), 10);
      await write(path.join(job, 'Release.Name.mkv'), 10);

      expect(await findLooseVideos(category, [job])).toEqual([
        path.join(category, 'Loose.mp4'),
      ]);
    });
  });
});
