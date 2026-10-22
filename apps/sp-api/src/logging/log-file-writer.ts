import { appendFileSync, constants } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';

export const LOG_FILE_NAME = 'stashboard.txt';
/** stashboard.txt and its rotated copies stashboard.0.txt … stashboard.99.txt; nothing else is ever served. */
export const LOG_FILE_PATTERN = /^stashboard(?:\.\d{1,2})?\.txt$/;

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEPT_FILES = 5;
/** Lines waiting for a slow disk beyond this are dropped, oldest first. */
const MAX_QUEUED_LINES = 20_000;
const FLUSH_DELAY_MS = 100;

export interface LogFileInfo {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface LogFileWriterOptions {
  maxBytes?: number;
  /** Rotated files kept besides the current one: stashboard.0.txt (newest) … */
  keep?: number;
  /** Told once when the files can't be written; logging carries on without them. */
  onError?: (message: string) => void;
}

/**
 * Writes log lines to `directory`/stashboard.txt like the *arr apps: in the
 * background, a batch at a time, starting a new file at `maxBytes` and
 * keeping the last few (stashboard.0.txt is the newest old one). If the folder
 * can't be written it gives up quietly after saying so once, so a read-only
 * volume never takes the app down.
 */
export class LogFileWriter {
  private readonly maxBytes: number;
  private readonly keep: number;
  private queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private size: number | null = null;
  private failedWith: string | null = null;
  private opening: Promise<boolean> | null = null;

  constructor(
    readonly directory: string,
    private readonly options: LogFileWriterOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.keep = Math.max(0, options.keep ?? DEFAULT_KEPT_FILES);
  }

  get path(): string {
    return join(this.directory, LOG_FILE_NAME);
  }

  /** Why writing stopped, or null while it works. */
  get failure(): string | null {
    return this.failedWith;
  }

  write(line: string): void {
    if (this.failedWith !== null) {
      return;
    }
    this.queue.push(`${line}\n`);
    if (this.queue.length > MAX_QUEUED_LINES) {
      this.queue.splice(0, this.queue.length - MAX_QUEUED_LINES);
    }
    this.schedule();
  }

  /** Writes everything queued so far. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await this.flushing;
    }
    if (this.queue.length === 0 || this.failedWith !== null) {
      return;
    }
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
      // Lines written while the last batch was finishing.
      this.schedule();
    });
    await this.flushing;
  }

  private schedule(): void {
    if (
      this.timer ||
      this.flushing ||
      this.queue.length === 0 ||
      this.failedWith !== null
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref?.();
  }

  /** For process exit, when there's no time for anything async. */
  flushSync(): void {
    if (this.queue.length === 0 || this.failedWith !== null) {
      return;
    }
    const chunk = this.queue.join('');
    this.queue = [];
    try {
      appendFileSync(this.path, chunk);
    } catch {
      // Exiting anyway.
    }
  }

  /** The log files there now, current first. */
  async list(): Promise<LogFileInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const files = await Promise.all(
      names
        .filter((name) => LOG_FILE_PATTERN.test(name))
        .map(async (name) => {
          try {
            const info = await stat(join(this.directory, name));
            return info.isFile()
              ? {
                  name,
                  size: info.size,
                  modifiedAt: info.mtime.toISOString(),
                }
              : null;
          } catch {
            return null;
          }
        }),
    );
    return files
      .filter((file): file is LogFileInfo => file !== null)
      .sort((a, b) => fileOrder(a.name) - fileOrder(b.name));
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.join('');
        this.queue = [];
        const bytes = Buffer.byteLength(chunk);
        if (this.size === null) {
          if (!(await this.ready())) {
            return;
          }
        }
        this.size ??= 0;
        if (this.size > 0 && this.size + bytes > this.maxBytes) {
          await this.rotate();
        }
        await appendFile(this.path, chunk);
        this.size += bytes;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Creates the folder and checks it can be written, so a problem shows at
   * start-up rather than with the first line. False when it can't.
   */
  ready(): Promise<boolean> {
    this.opening ??= (async () => {
      if (this.failedWith === null && this.size === null) {
        try {
          await this.open();
        } catch (error) {
          this.fail(error);
        }
      }
      return this.failedWith === null;
    })();
    return this.opening;
  }

  private async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await access(this.directory, constants.W_OK);
    this.size = await stat(this.path).then(
      (info) => info.size,
      () => 0,
    );
  }

  private fail(error: unknown): void {
    this.queue = [];
    this.failedWith = error instanceof Error ? error.message : String(error);
    this.options.onError?.(
      `Can't write log files in ${this.directory} (${this.failedWith}); logging to the console only.`,
    );
  }

  private async rotate(): Promise<void> {
    const rotated = (index: number) =>
      join(this.directory, `stashboard.${index}.txt`);
    if (this.keep === 0) {
      await unlink(this.path).catch(ignoreMissing);
    } else {
      await unlink(rotated(this.keep - 1)).catch(ignoreMissing);
      for (let index = this.keep - 2; index >= 0; index -= 1) {
        await rename(rotated(index), rotated(index + 1)).catch(ignoreMissing);
      }
      await rename(this.path, rotated(0)).catch(ignoreMissing);
    }
    this.size = 0;
  }
}

/** stashboard.txt first, then stashboard.0.txt, stashboard.1.txt … */
function fileOrder(name: string): number {
  const match = /^stashboard\.(\d+)\.txt$/.exec(name);
  return match ? Number(match[1]) + 1 : 0;
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}
