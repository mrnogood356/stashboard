import { constants, type Dirent, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { VIDEO } from '../automation/folder-watch.util';
import { isJunk } from '../organizer/folder-cleanup.util';
import { isSamplePath } from '../playback/sample.util';
import { trimTrailingSeparators } from '../path-separators';

/** A finished download is one release: never walk deeper or wider than this. */
const MAX_DEPTH = 4;
const MAX_ENTRIES = 5_000;
/**
 * What a download leaves next to its video once that's moved out: release
 * notes, repair and check files, the NZB, screenshots. Only these (and
 * sample videos and system files) are removed with the folder.
 */
const LEFTOVER =
  /\.(nfo|par2|txt|sfv|srr|srs|nzb|md5|sha1|url|log|jpe?g|png|gif|webp)$/i;
/** SABnzbd's folders for a download it's still unpacking, or that failed. */
const SAB_WORK_FOLDER = /^_(UNPACK|FAILED)_/i;

/** Why a file was left where it is, in plain words. */
export class HandoffFileError extends Error {}

/**
 * The main video of a finished download: the largest video file in its
 * folder (or the file itself), leaving out samples. Symlinks are not
 * followed. Null when there's none.
 */
export async function findMainVideo(target: string): Promise<string | null> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) {
    return null;
  }
  if (stat.isFile()) {
    return isVideo(target) ? target : null;
  }
  if (!stat.isDirectory()) {
    return null;
  }
  let best: { file: string; size: number } | null = null;
  let seen = 0;
  const stack: Array<{ folder: string; depth: number }> = [
    { folder: target, depth: 0 },
  ];
  while (stack.length > 0 && seen < MAX_ENTRIES) {
    const { folder, depth } = stack.pop()!;
    const entries = await fs
      .readdir(folder, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      seen += 1;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) {
          stack.push({ folder: full, depth: depth + 1 });
        }
        continue;
      }
      // Samples are judged by their path inside the download only, so a
      // download folder with "sample" in its own name still counts.
      if (
        !entry.isFile() ||
        !VIDEO.test(entry.name) ||
        isSamplePath(path.relative(target, full))
      ) {
        continue;
      }
      const size = (await fs.stat(full).catch(() => null))?.size ?? 0;
      if (!best || size > best.size) {
        best = { file: full, size };
      }
    }
  }
  return best?.file ?? null;
}

/**
 * Makes the folder again when it's missing but the folder it sits in is
 * there; a missing parent means a wrong path or mount, so that's left to
 * fail with its own message.
 */
async function recreateFolder(folder: string): Promise<void> {
  if (await exists(folder)) {
    return;
  }
  const parent = path.dirname(folder);
  if (
    parent === folder ||
    !(await fs.stat(parent).catch(() => null))?.isDirectory()
  ) {
    return;
  }
  await fs.mkdir(folder).catch(() => undefined);
}

/**
 * Moves (or copies) one finished video into the destination folder, under
 * its own name. Before anything moves:
 *
 * - the source must be a video file that exists, inside `within` when given
 *   (SABnzbd's download folder as Stashboard sees it);
 * - the target must land directly in the destination folder, real paths
 *   resolved, so nothing can step outside it;
 * - nothing may already be at the target.
 *
 * It goes in under a hidden temporary name first, so nothing (the folder
 * watcher, Stash) picks up half a copy, and only takes its real name if that
 * is still free. Throws a HandoffFileError with the reason, leaving the
 * source where it was.
 *
 * Returns the new path, written with the destination as given (Stash's
 * view of it), not as the real path resolved on this machine.
 */
export async function placeVideo(options: {
  source: string;
  destination: string;
  mode: 'move' | 'copy';
  /** Unique per download, for the temporary name. */
  tag: string;
  within?: string | null;
}): Promise<string> {
  const source = await realPath(
    options.source,
    'The finished file isn’t there any more.',
  );
  const sourceStat = await fs.lstat(source).catch(() => null);
  if (!sourceStat?.isFile() || !isVideo(source)) {
    throw new HandoffFileError(`${source} isn’t a video file; left it alone.`);
  }
  if (options.within) {
    const within = await realPath(
      options.within,
      `Stashboard can’t see SABnzbd’s download folder (${options.within}). Check the folder mapping.`,
    );
    if (!isInside(source, within)) {
      throw new HandoffFileError(
        `${source} is outside SABnzbd’s download folder; left it alone.`,
      );
    }
  }

  // Gone (an empty-folder clean-up, say) while its parent is still there:
  // put it back rather than stop every download.
  await recreateFolder(options.destination);
  const destination = await realPath(
    options.destination,
    `Stashboard can’t see the destination folder ${options.destination}.`,
  );
  if (!(await fs.stat(destination).catch(() => null))?.isDirectory()) {
    throw new HandoffFileError(
      `The destination ${options.destination} isn’t a folder.`,
    );
  }
  const name = path.basename(source);
  const target = path.resolve(destination, name);
  if (!isSafeName(name) || path.dirname(target) !== destination) {
    throw new HandoffFileError(
      `“${name}” would land outside the destination folder; left it alone.`,
    );
  }
  if (await exists(target)) {
    throw new HandoffFileError(
      `Something is already at ${path.join(options.destination, name)}; left the download alone.`,
    );
  }
  const temp = path.join(
    destination,
    `.stashboard-${options.tag.replace(/[^a-z0-9_-]/gi, '')}.partial`,
  );
  if (await exists(temp)) {
    throw new HandoffFileError(
      `A half-finished move is still at ${temp}; remove it and try again.`,
    );
  }

  // Into the temporary name: a rename when it's the same disk, else a copy.
  let renamed = false;
  if (options.mode === 'move') {
    try {
      await fs.rename(source, temp);
      renamed = true;
    } catch (error) {
      if (codeOf(error) !== 'EXDEV') {
        throw new HandoffFileError(
          `Couldn’t move the file: ${messageOf(error)}`,
        );
      }
    }
  }
  if (!renamed) {
    try {
      await fs.copyFile(source, temp, constants.COPYFILE_EXCL);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw new HandoffFileError(`Couldn’t copy the file: ${messageOf(error)}`);
    }
  }

  // Then its real name, only if that's still free.
  try {
    await claimName(temp, target);
  } catch (error) {
    if (renamed) {
      await fs.rename(temp, source).catch(() => undefined);
    } else {
      await fs.unlink(temp).catch(() => undefined);
    }
    throw error instanceof HandoffFileError
      ? error
      : new HandoffFileError(`Couldn’t move the file: ${messageOf(error)}`);
  }

  // A move across disks: the copy is in place, so the original can go.
  if (options.mode === 'move' && !renamed) {
    await fs.unlink(source).catch(() => undefined);
  }
  return path.join(options.destination, name);
}

/** True when inner is folder itself or inside it. */
export function isInside(inner: string, folder: string): boolean {
  const relative = path.relative(folder, inner);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/** What happened to a download's own folder once its video was moved out. */
export type JobFolderCleanup =
  | { result: 'removed'; folder: string }
  /** Nothing there any more. */
  | { result: 'gone'; folder: string }
  | {
      result: 'kept';
      folder: string;
      /** Why it was left, in plain words. */
      reason: string;
      /** Other (non-sample) videos still in it. */
      videos: string[];
    };

/**
 * Removes a download's own folder in SABnzbd's category folder once its
 * video has been moved out, with what's left in it. Only when:
 *
 * - it's a real folder (not a link) strictly inside the category folder,
 *   real paths resolved: never the category folder itself, never SABnzbd's
 *   completed folder or anything holding it;
 * - all that's left are leftovers (release notes, par2 and check files,
 *   samples, screenshots, system files) and empty folders, nothing linked.
 *
 * Files go one by one, then the folders from the deepest up, each only if
 * it's empty by then, so whatever turns up meanwhile stays. Anything else
 * leaves the folder as it is, with the reason.
 */
export async function removeJobFolder(options: {
  folder: string;
  categoryFolder: string;
  completedFolder?: string | null;
}): Promise<JobFolderCleanup> {
  const folder = trimTrailingSeparators(options.folder) || options.folder;
  const kept = (reason: string, videos: string[] = []): JobFolderCleanup => ({
    result: 'kept',
    folder,
    reason,
    videos,
  });
  const stat = await fs.lstat(folder).catch(() => null);
  if (!stat) {
    return { result: 'gone', folder };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return kept(`${folder} isn’t a plain folder.`);
  }
  const real = await fs.realpath(folder).catch(() => null);
  const category = await fs.realpath(options.categoryFolder).catch(() => null);
  if (!real || !category) {
    return kept(
      `Stashboard can’t see SABnzbd’s category folder (${options.categoryFolder}).`,
    );
  }
  const completed = options.completedFolder
    ? await fs.realpath(options.completedFolder).catch(() => null)
    : null;
  if (
    real === category ||
    !isInside(real, category) ||
    (completed && isInside(completed, real))
  ) {
    return kept(
      `${folder} isn’t a download’s own folder inside SABnzbd’s category folder (${options.categoryFolder}).`,
    );
  }

  const files: string[] = [];
  const folders: string[] = [];
  const videos: string[] = [];
  const others: string[] = [];
  let seen = 0;
  const stack: Array<{ folder: string; depth: number }> = [
    { folder: real, depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.folder, { withFileTypes: true });
    } catch (error) {
      return kept(
        `Couldn’t look inside ${current.folder}: ${messageOf(error)}`,
      );
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > MAX_ENTRIES) {
        return kept(`${folder} holds too many files to check.`);
      }
      const full = path.join(current.folder, entry.name);
      const inside = path.relative(real, full);
      if (entry.isDirectory()) {
        if (current.depth >= MAX_DEPTH) {
          return kept(`${folder} has folders nested too deep to check.`);
        }
        folders.push(full);
        stack.push({ folder: full, depth: current.depth + 1 });
      } else if (!entry.isFile()) {
        // A link (or anything odd) could point anywhere: leave it all.
        others.push(inside);
      } else if (VIDEO.test(entry.name)) {
        if (isSamplePath(inside)) {
          files.push(full);
        } else {
          videos.push(inside);
        }
      } else if (isJunk(entry.name) || LEFTOVER.test(entry.name)) {
        files.push(full);
      } else {
        others.push(inside);
      }
    }
  }
  if (videos.length > 0) {
    return kept(
      `${folder} still has other videos (${listNames(videos)}), so it was left.`,
      videos,
    );
  }
  if (others.length > 0) {
    return kept(
      `${folder} still has other files (${listNames(others)}), so it was left.`,
    );
  }

  try {
    for (const file of files) {
      await fs.unlink(file);
    }
    // Deepest first; rmdir only removes a folder that's empty.
    for (const inner of folders.sort((a, b) => b.length - a.length)) {
      await fs.rmdir(inner);
    }
    await fs.rmdir(real);
  } catch (error) {
    return kept(`Couldn’t remove all of ${folder}: ${messageOf(error)}`);
  }
  return { result: 'removed', folder };
}

/**
 * Video files put straight into SABnzbd's category folder: everything but
 * samples, hidden files, links, SABnzbd's own unpacking and failed folders,
 * and whatever is inside `skip`. Paths as given (Stashboard's view).
 */
export async function findLooseVideos(
  categoryFolder: string,
  skip: string[] = [],
): Promise<string[]> {
  return (await scanDropInFolder(categoryFolder, skip)).videos;
}

/** Why something in the drop-in folder was left alone. */
export type DropInSkipReason =
  | 'sab-job'
  | 'sab-working'
  | 'sample'
  | 'not-video'
  | 'hidden'
  | 'link'
  | 'too-deep';

/** What a look at the drop-in folder found. */
export interface DropInScan {
  /** Videos that may be brought in, sorted. */
  videos: string[];
  /** What was left alone and why (leftovers like .nfo files aren't listed). */
  skipped: Array<{ path: string; reason: DropInSkipReason }>;
  /** Stopped early: the folder holds more than one look covers. */
  truncated: boolean;
}

/** Skipped entries remembered per look; enough to explain, not to flood. */
const MAX_SKIPPED = 50;

/**
 * findLooseVideos, saying what was left alone and why: SABnzbd's own jobs
 * (`skip`) and its unpacking or failed folders, samples, hidden files, links,
 * files that aren't videos (release leftovers aside) and folders nested too
 * deep.
 */
export async function scanDropInFolder(
  categoryFolder: string,
  skip: string[] = [],
): Promise<DropInScan> {
  const base = trimTrailingSeparators(categoryFolder) || categoryFolder;
  const videos: string[] = [];
  const skipped: DropInScan['skipped'] = [];
  const leave = (full: string, reason: DropInSkipReason) => {
    if (skipped.length < MAX_SKIPPED) {
      skipped.push({ path: full, reason });
    }
  };
  let seen = 0;
  const stack: Array<{ folder: string; depth: number }> = [
    { folder: base, depth: 0 },
  ];
  while (stack.length > 0 && seen < MAX_ENTRIES) {
    const { folder, depth } = stack.pop()!;
    const entries = await fs
      .readdir(folder, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      seen += 1;
      const full = path.join(folder, entry.name);
      if (entry.name.startsWith('.')) {
        // System files and half-written copies (".partial", rsync's temp
        // names): only videos are worth a mention.
        if (VIDEO.test(entry.name)) {
          leave(full, 'hidden');
        }
        continue;
      }
      if (skip.some((excluded) => isInside(full, excluded))) {
        // Not walked into, so only the job itself is listed.
        leave(full, 'sab-job');
        continue;
      }
      if (entry.isDirectory()) {
        if (SAB_WORK_FOLDER.test(entry.name)) {
          leave(full, 'sab-working');
        } else if (depth < MAX_DEPTH) {
          stack.push({ folder: full, depth: depth + 1 });
        } else {
          leave(full, 'too-deep');
        }
      } else if (!entry.isFile()) {
        if (entry.isSymbolicLink() && VIDEO.test(entry.name)) {
          leave(full, 'link');
        }
      } else if (!VIDEO.test(entry.name)) {
        if (!isJunk(entry.name) && !LEFTOVER.test(entry.name)) {
          leave(full, 'not-video');
        }
      } else if (isSamplePath(path.relative(base, full))) {
        leave(full, 'sample');
      } else {
        videos.push(full);
      }
    }
  }
  return { videos: videos.sort(), skipped, truncated: seen >= MAX_ENTRIES };
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/**
 * Gives the temporary file its real name without ever replacing a file: a
 * hard link fails if the name is taken. Where links aren't possible (some
 * network shares), the name is checked and the file renamed.
 */
async function claimName(temp: string, target: string): Promise<void> {
  try {
    await fs.link(temp, target);
    await fs.unlink(temp);
    return;
  } catch (error) {
    if (codeOf(error) === 'EEXIST') {
      throw new HandoffFileError(
        `Something appeared at ${target} meanwhile; left the download alone.`,
      );
    }
  }
  if (await exists(target)) {
    throw new HandoffFileError(
      `Something appeared at ${target} meanwhile; left the download alone.`,
    );
  }
  await fs.rename(temp, target);
}

async function realPath(target: string, missing: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    throw new HandoffFileError(missing);
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ENOENT';
  }
}

function isVideo(file: string): boolean {
  return VIDEO.test(path.basename(file));
}

function isSafeName(name: string): boolean {
  return (
    !!name &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'unknown error';
}
