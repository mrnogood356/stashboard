import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaCacheService } from './media-cache.service';

describe('MediaCacheService', () => {
  let dir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stashboard-media-cache-'));
    process.env.MEDIA_CACHE_DIR = dir;
    delete process.env.MEDIA_CACHE_DISABLED;
    delete process.env.MEDIA_CACHE_TTL_HOURS;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(dir, { recursive: true, force: true });
  });

  const asset = (bytes: number[]) => ({
    body: Buffer.from(bytes),
    contentType: 'image/jpeg',
  });

  it('loads once, then serves repeat requests from disk', async () => {
    const cache = new MediaCacheService();
    const load = jest.fn().mockResolvedValue(asset([1, 2, 3]));

    await expect(cache.getOrLoad('stash|a|scene', '1', load)).resolves.toEqual(
      asset([1, 2, 3]),
    );
    await expect(cache.getOrLoad('stash|a|scene', '1', load)).resolves.toEqual(
      asset([1, 2, 3]),
    );

    expect(load).toHaveBeenCalledTimes(1);
    // A fresh instance (e.g. after a container restart) still hits the disk cache.
    await new MediaCacheService().getOrLoad('stash|a|scene', '1', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one load between concurrent requests for the same image', async () => {
    const cache = new MediaCacheService();
    let resolve!: (value: ReturnType<typeof asset>) => void;
    let loadStarted!: () => void;
    const started = new Promise<void>((r) => (loadStarted = r));
    const load = jest.fn(() => {
      loadStarted();
      return new Promise<ReturnType<typeof asset>>((r) => (resolve = r));
    });

    const first = cache.getOrLoad('ns', '7', load);
    const second = cache.getOrLoad('ns', '7', load);
    // Wait for the load itself, not a fixed delay: disk checks come first
    // and can be slow on a busy machine.
    await started;
    resolve(asset([9]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      asset([9]),
      asset([9]),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not load twice when the first request finishes during the second one's disk check", async () => {
    const cache = new MediaCacheService();
    let firstFinished!: () => void;
    const first = new Promise<void>((r) => (firstFinished = r));
    const internals = cache as unknown as {
      read: (key: string) => Promise<unknown>;
    };
    const read = internals.read.bind(cache);
    let reads = 0;
    internals.read = async (key) => {
      reads += 1;
      const n = reads;
      const result = await read(key);
      if (n === 2) {
        // The second request's "not cached" answer only arrives after the
        // first request has loaded, written and finished.
        await first;
      }
      return result;
    };
    const load = jest.fn().mockResolvedValue(asset([4]));

    await Promise.all([
      cache.getOrLoad('ns', '8', load).finally(firstFinished),
      cache.getOrLoad('ns', '8', load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps different namespaces and ids apart and does not cache misses', async () => {
    const cache = new MediaCacheService();
    await cache.getOrLoad('stash|a|scene', '1', () =>
      Promise.resolve(asset([1])),
    );
    await expect(
      cache.getOrLoad('stash|b|scene', '1', () => Promise.resolve(asset([2]))),
    ).resolves.toEqual(asset([2]));

    const missing = jest.fn().mockResolvedValue(null);
    await cache.getOrLoad('ns', 'gone', missing);
    await cache.getOrLoad('ns', 'gone', missing);
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it('reloads entries older than the TTL', async () => {
    process.env.MEDIA_CACHE_TTL_HOURS = '1';
    const cache = new MediaCacheService();
    const load = jest.fn().mockResolvedValue(asset([1]));
    await cache.getOrLoad('ns', '1', load);

    // Simulate two hours passing.
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 2 * 3_600_000);
    await cache.getOrLoad('ns', '1', load);
    expect(load).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('falls back to loading directly when disabled', async () => {
    process.env.MEDIA_CACHE_DISABLED = 'true';
    const cache = new MediaCacheService();
    const load = jest.fn().mockResolvedValue(asset([1]));
    await cache.getOrLoad('ns', '1', load);
    await cache.getOrLoad('ns', '1', load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await readdir(dir)).toEqual([]);
  });

  it('falls back to loading directly when the cache folder cannot be created', async () => {
    // A path below a regular file can never be created as a directory.
    const blocker = join(dir, 'not-a-folder');
    await writeFile(blocker, 'x');
    process.env.MEDIA_CACHE_DIR = join(blocker, 'cache');
    const cache = new MediaCacheService();
    const load = jest.fn().mockResolvedValue(asset([1]));
    await expect(cache.getOrLoad('ns', '1', load)).resolves.toEqual(asset([1]));
  });
});
