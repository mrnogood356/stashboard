import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** The video types Stash scans by default. */
export const VIDEO =
  /\.(mp4|m4v|mkv|avi|wmv|flv|mov|mpe?g|webm|ts|m2ts|mts|vob|3gp|divx|xvid|asf|f4v|ogv|rm|rmvb)$/i;
/** A file still being copied keeps changing; wait until it has been still this long. */
export const SETTLE_MS = 60_000;
/** Big libraries: stop walking after this many folders in one check. */
const MAX_FOLDERS = 50_000;

type Stat = { mtimeMs: number; ctimeMs: number; size: number };

export interface FolderWatchFs {
  readdir(
    folder: string,
  ): Promise<
    Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  >;
  stat(target: string): Promise<Stat>;
}

const nodeFs: FolderWatchFs = {
  readdir: (folder) => fs.readdir(folder, { withFileTypes: true }),
  stat: (target) => fs.stat(target),
};

interface FolderEntry {
  /** The folder's modified time when it was last read. */
  mtimeMs: number;
  folders: string[];
  videos: Set<string>;
}

/**
 * Notices video files put straight into the library folders (copied or
 * moved in by hand, or by anything but Whisparr), so Stash can be asked to
 * scan them.
 *
 * It remembers what each folder held and reads a folder again only when its
 * modified time changes (adding, removing or renaming anything in it does
 * that), so a check is mostly one stat per folder. A new file is reported
 * once it has stopped changing, so a copy in progress isn't scanned half
 * done. The first check only takes stock.
 */
export class LibraryFolderWatcher {
  private folders = new Map<string, FolderEntry>();
  private ready = false;
  /** New files still being written. */
  private readonly settling: SettleTracker;

  constructor(private readonly files: FolderWatchFs = nodeFs) {
    this.settling = new SettleTracker(files);
  }

  /** Video files that are new and settled since the last check. */
  async check(roots: string[], now = Date.now()): Promise<string[]> {
    const firstLook = !this.ready;
    const seen = new Set<string>();
    const stack = roots.map((root) => root.replace(/[\\/]+$/, '') || root);
    while (stack.length > 0 && seen.size < MAX_FOLDERS) {
      const folder = stack.pop()!;
      if (seen.has(folder)) {
        continue;
      }
      seen.add(folder);
      const entry = await this.look(folder, firstLook);
      if (entry) {
        stack.push(...entry.folders);
      }
    }
    // Forget folders that are gone, so they count as new if they come back.
    if (seen.size < MAX_FOLDERS) {
      for (const folder of [...this.folders.keys()]) {
        if (!seen.has(folder)) {
          this.folders.delete(folder);
        }
      }
    }
    this.ready = true;
    return this.settled(now);
  }

  private async look(
    folder: string,
    firstLook: boolean,
  ): Promise<FolderEntry | null> {
    const stat = await this.files.stat(folder).catch(() => null);
    if (!stat) {
      return null;
    }
    const known = this.folders.get(folder);
    if (known && known.mtimeMs === stat.mtimeMs) {
      return known;
    }
    const entries = await this.files.readdir(folder).catch(() => null);
    if (!entries) {
      return known ?? null;
    }
    const next: FolderEntry = {
      mtimeMs: stat.mtimeMs,
      folders: [],
      videos: new Set(),
    };
    for (const item of entries) {
      if (item.name.startsWith('.')) {
        continue;
      }
      const full = path.join(folder, item.name);
      if (item.isDirectory()) {
        next.folders.push(full);
      } else if (item.isFile() && VIDEO.test(item.name)) {
        next.videos.add(full);
        if (!firstLook && !known?.videos.has(full)) {
          this.settling.add(full);
        }
      }
    }
    this.folders.set(folder, next);
    return next;
  }

  private settled(now: number): Promise<string[]> {
    return this.settling.settled(now);
  }
}

/** A file being watched until it stops changing. */
export interface SettlingFile {
  path: string;
  /** Its size last time it was looked at; null before the first look. */
  size: number | null;
  /** When it was first noticed. */
  firstSeen: number;
  /** Since when its size and modified time haven't changed; null before the first look. */
  stableSince: number | null;
}

interface SettleState {
  size: number;
  mtimeMs: number;
  firstSeen: number;
  /** Null until it has been looked at once. */
  stableSince: number | null;
}

/**
 * Waits for files to stop changing, so a copy in progress is never picked up
 * half done. A file counts as settled once its size and modified time are
 * the same as on the look before, and either it was last changed at least
 * `settleMs` ago or it has looked the same for at least `settleMs`.
 *
 * The second rule matters when a file's times can't be trusted: one copied
 * with its times kept from a machine whose clock is ahead (or from a share
 * that reports another time zone) has a modified time in the future, and
 * would otherwise never count as settled. Files that disappear are
 * forgotten.
 */
export class SettleTracker {
  private readonly states = new Map<string, SettleState>();

  constructor(
    private readonly files: Pick<FolderWatchFs, 'stat'> = nodeFs,
    private readonly settleMs = SETTLE_MS,
  ) {}

  /** Starts watching a file, unless it's watched already. True when it's new. */
  add(file: string, now = Date.now()): boolean {
    if (this.states.has(file)) {
      return false;
    }
    this.states.set(file, {
      size: -1,
      mtimeMs: -1,
      firstSeen: now,
      stableSince: null,
    });
    return true;
  }

  /** Stops watching files that aren't in the list any more. */
  keepOnly(files: Set<string>): void {
    for (const file of [...this.states.keys()]) {
      if (!files.has(file)) {
        this.states.delete(file);
      }
    }
  }

  /** How many files are still being watched. */
  get size(): number {
    return this.states.size;
  }

  /** The files still being watched, first noticed first. */
  list(): SettlingFile[] {
    return [...this.states.entries()]
      .map(([file, state]) => ({
        path: file,
        size: state.stableSince === null ? null : state.size,
        firstSeen: state.firstSeen,
        stableSince: state.stableSince,
      }))
      .sort(
        (a, b) => a.firstSeen - b.firstSeen || a.path.localeCompare(b.path),
      );
  }

  /** The watched files that have settled, sorted; they're no longer watched. */
  async settled(now = Date.now()): Promise<string[]> {
    const ready: string[] = [];
    for (const [file, state] of [...this.states]) {
      const stat = await this.files.stat(file).catch(() => null);
      if (!stat) {
        this.states.delete(file);
        continue;
      }
      const unchanged =
        state.stableSince !== null &&
        stat.size === state.size &&
        stat.mtimeMs === state.mtimeMs;
      if (!unchanged) {
        this.states.set(file, {
          ...state,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          stableSince: now,
        });
        continue;
      }
      const changed = Math.max(stat.mtimeMs, stat.ctimeMs);
      if (
        now - changed >= this.settleMs ||
        now - (state.stableSince ?? now) >= this.settleMs
      ) {
        this.states.delete(file);
        ready.push(file);
      }
    }
    return ready.sort();
  }
}
