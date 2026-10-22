import {
  FolderWatchFs,
  LibraryFolderWatcher,
  SETTLE_MS,
  SettleTracker,
} from './folder-watch.util';

/** A tiny in-memory filesystem: folders and files with times and sizes. */
function fakeFs() {
  const nodes = new Map<
    string,
    { folder: boolean; mtimeMs: number; ctimeMs: number; size: number }
  >();
  const parent = (target: string) => target.slice(0, target.lastIndexOf('/'));
  const touch = (folder: string, at: number) => {
    const node = nodes.get(folder);
    if (node) {
      node.mtimeMs = at;
      node.ctimeMs = at;
    }
  };
  const files: FolderWatchFs = {
    readdir: (folder) =>
      Promise.resolve(
        [...nodes.entries()]
          .filter(([key]) => parent(key) === folder)
          .map(([key, node]) => ({
            name: key.slice(folder.length + 1),
            isDirectory: () => node.folder,
            isFile: () => !node.folder,
          })),
      ),
    stat: (target) => {
      const node = nodes.get(target);
      return node ? Promise.resolve(node) : Promise.reject(new Error('gone'));
    },
  };
  return {
    files,
    folder(target: string, at: number) {
      nodes.set(target, { folder: true, mtimeMs: at, ctimeMs: at, size: 0 });
      touch(parent(target), at);
    },
    file(target: string, at: number, size = 100, keepTimes = false) {
      nodes.set(target, {
        folder: false,
        mtimeMs: keepTimes ? 0 : at,
        ctimeMs: keepTimes ? 0 : at,
        size,
      });
      touch(parent(target), at);
    },
  };
}

describe('LibraryFolderWatcher', () => {
  it('reports a new video once it has finished copying, and only once', async () => {
    const disk = fakeFs();
    disk.folder('/lib', 0);
    disk.file('/lib/old.mp4', 0);
    const watcher = new LibraryFolderWatcher(disk.files);
    expect(await watcher.check(['/lib'], 1_000)).toEqual([]);

    disk.folder('/lib/Studio', 2_000);
    disk.file('/lib/Studio/new.mkv', 2_000, 50);
    disk.file('/lib/Studio/new.nfo', 2_000);
    // Still being written.
    expect(await watcher.check(['/lib'], 3_000)).toEqual([]);
    disk.file('/lib/Studio/new.mkv', 4_000, 900);
    expect(await watcher.check(['/lib'], 5_000)).toEqual([]);
    // Finished and still for a minute.
    expect(await watcher.check(['/lib'], 4_000 + SETTLE_MS)).toEqual([
      '/lib/Studio/new.mkv',
    ]);
    expect(await watcher.check(['/lib'], 10 * SETTLE_MS)).toEqual([]);
  });

  it('notices a folder moved in whole, with files keeping their old times', async () => {
    const disk = fakeFs();
    disk.folder('/lib', 0);
    const watcher = new LibraryFolderWatcher(disk.files);
    await watcher.check(['/lib'], 1_000);

    disk.folder('/lib/Moved', 2_000);
    disk.file('/lib/Moved/scene.mp4', 2_000, 100, true);
    await watcher.check(['/lib'], 3_000);
    expect(await watcher.check(['/lib'], 3_000 + SETTLE_MS)).toEqual([
      '/lib/Moved/scene.mp4',
    ]);
  });

  it('takes stock on the first look instead of reporting the whole library', async () => {
    const disk = fakeFs();
    disk.folder('/lib', 0);
    disk.file('/lib/a.mp4', 0);
    const watcher = new LibraryFolderWatcher(disk.files);
    expect(await watcher.check(['/lib'], SETTLE_MS * 5)).toEqual([]);
    expect(await watcher.check(['/lib'], SETTLE_MS * 6)).toEqual([]);
  });
});

describe('SettleTracker', () => {
  const statOf = (nodes: Map<string, { mtimeMs: number; size: number }>) => ({
    stat: (target: string) => {
      const node = nodes.get(target);
      return node
        ? Promise.resolve({ ...node, ctimeMs: node.mtimeMs })
        : Promise.reject(new Error('gone'));
    },
  });

  it('settles a file whose modified time is in the future once it stops changing', async () => {
    // Copied with its times kept from a machine whose clock is a day ahead.
    const nodes = new Map([['/in/a.mp4', { mtimeMs: 86_400_000, size: 10 }]]);
    const tracker = new SettleTracker(statOf(nodes), 30_000);
    tracker.add('/in/a.mp4', 0);

    expect(await tracker.settled(1_000)).toEqual([]);
    expect(await tracker.settled(20_000)).toEqual([]);
    expect(await tracker.settled(31_000)).toEqual(['/in/a.mp4']);
  });

  it('waits again when the size or modified time changes', async () => {
    const nodes = new Map([['/in/b.mp4', { mtimeMs: 0, size: 10 }]]);
    const tracker = new SettleTracker(statOf(nodes), 30_000);
    tracker.add('/in/b.mp4', 0);
    expect(await tracker.settled(100_000)).toEqual([]);

    // Same size, but written to again (a preallocated file filling in).
    nodes.set('/in/b.mp4', { mtimeMs: 110_000, size: 10 });
    expect(await tracker.settled(120_000)).toEqual([]);
    expect(tracker.list()).toEqual([
      { path: '/in/b.mp4', size: 10, firstSeen: 0, stableSince: 120_000 },
    ]);
    expect(await tracker.settled(150_000)).toEqual(['/in/b.mp4']);
    expect(tracker.size).toBe(0);
  });

  it('forgets files that disappear', async () => {
    const nodes = new Map([['/in/c.mp4', { mtimeMs: 0, size: 10 }]]);
    const tracker = new SettleTracker(statOf(nodes), 30_000);
    expect(tracker.add('/in/c.mp4', 0)).toBe(true);
    expect(tracker.add('/in/c.mp4', 5)).toBe(false);
    nodes.clear();
    expect(await tracker.settled(100_000)).toEqual([]);
    expect(tracker.size).toBe(0);
  });
});
