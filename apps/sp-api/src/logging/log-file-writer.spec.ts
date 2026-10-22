import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOG_FILE_PATTERN, LogFileWriter } from './log-file-writer';

describe('LogFileWriter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stashboard-logs-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the folder and appends lines in the background', async () => {
    const logs = join(dir, 'logs');
    const writer = new LogFileWriter(logs);
    writer.write('first');
    writer.write('second');
    await writer.flush();
    writer.write('third');
    await writer.flush();

    expect(await readFile(join(logs, 'stashboard.txt'), 'utf8')).toBe(
      'first\nsecond\nthird\n',
    );
  });

  it('starts a new file at the size limit and keeps only the last few', async () => {
    const writer = new LogFileWriter(dir, { maxBytes: 20, keep: 2 });
    for (const n of [1, 2, 3, 4, 5]) {
      writer.write(`line ${n} 123456789`); // 20 bytes with the newline
      await writer.flush();
    }

    expect((await readdir(dir)).sort()).toEqual([
      'stashboard.0.txt',
      'stashboard.1.txt',
      'stashboard.txt',
    ]);
    expect(await readFile(join(dir, 'stashboard.txt'), 'utf8')).toContain(
      'line 5',
    );
    expect(await readFile(join(dir, 'stashboard.0.txt'), 'utf8')).toContain(
      'line 4',
    );
    expect(await readFile(join(dir, 'stashboard.1.txt'), 'utf8')).toContain(
      'line 3',
    );
  });

  it('carries on from an existing file’s size after a restart', async () => {
    await writeFile(join(dir, 'stashboard.txt'), 'x'.repeat(15));
    const writer = new LogFileWriter(dir, { maxBytes: 20, keep: 1 });
    writer.write('0123456789');
    await writer.flush();

    expect(await readFile(join(dir, 'stashboard.0.txt'), 'utf8')).toBe(
      'x'.repeat(15),
    );
    expect(await readFile(join(dir, 'stashboard.txt'), 'utf8')).toBe(
      '0123456789\n',
    );
  });

  it('gives up quietly, saying so once, when the folder can’t be written', async () => {
    // A file where the folder should be: mkdir fails, as on a read-only volume.
    const blocked = join(dir, 'blocked');
    await writeFile(blocked, '');
    const onError = jest.fn();
    const writer = new LogFileWriter(join(blocked, 'logs'), { onError });

    await expect(writer.ready()).resolves.toBe(false);
    writer.write('lost');
    await writer.flush();
    writer.write('also lost');
    await writer.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('logging to the console only');
    expect(writer.failure).toBeTruthy();
  });

  it('lists only log files, current first', async () => {
    await writeFile(join(dir, 'stashboard.txt'), 'abc');
    await writeFile(join(dir, 'stashboard.1.txt'), 'a');
    await writeFile(join(dir, 'stashboard.0.txt'), 'ab');
    await writeFile(join(dir, 'session-secret'), 'nope');
    await writeFile(join(dir, 'stashboard.txt.bak'), 'nope');

    const files = await new LogFileWriter(dir).list();
    expect(files.map((file) => [file.name, file.size])).toEqual([
      ['stashboard.txt', 3],
      ['stashboard.0.txt', 2],
      ['stashboard.1.txt', 1],
    ]);
    expect(await new LogFileWriter(join(dir, 'missing')).list()).toEqual([]);
  });

  it('allows only log file names', () => {
    expect(LOG_FILE_PATTERN.test('stashboard.txt')).toBe(true);
    expect(LOG_FILE_PATTERN.test('stashboard.4.txt')).toBe(true);
    for (const name of [
      '../stashboard.txt',
      'stashboard.txt/..',
      '..%2Fsession-secret',
      '/etc/passwd',
      'stashboard.-1.txt',
      'session-secret',
    ]) {
      expect(LOG_FILE_PATTERN.test(name)).toBe(false);
    }
  });
});
