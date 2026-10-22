import { promises as fs } from 'node:fs';
import path from 'node:path';

/** System files: never count. */
const JUNK = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '._.ds_store',
  '.directory',
]);
const MAX_FOLDERS = 200_000;

/** Video files: a folder with one of these is never touched. */
const VIDEO = new Set([
  '3g2',
  '3gp',
  'asf',
  'avi',
  'divx',
  'f4v',
  'flv',
  'iso',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mts',
  'ogm',
  'ogv',
  'rm',
  'rmvb',
  'ts',
  'vob',
  'webm',
  'wmv',
  'xvid',
]);
/** Images and archives can be Stash galleries: kept unless they're only scene artwork. */
const IMAGE = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'avif',
]);
const ARCHIVE = new Set(['zip', 'cbz', 'rar', 'cbr', '7z']);
/** Downloads still in progress: tiny at first, so size alone wouldn't keep their folder. */
const PARTIAL = new Set([
  'part',
  'partial',
  'crdownload',
  '!qb',
  '!ut',
  'aria2',
  'download',
]);
/** Artwork Whisparr / Kodi / downloaders leave next to a video. */
const ARTWORK =
  /(^|[-._ ])(poster|fanart|folder|cover|thumb|thumbnail|banner|backdrop|landscape|clearart|clearlogo|logo|disc|screens?|sample)\.[a-z0-9]+$/i;
/** An unknown file bigger than this might matter, so its folder is kept. */
const LARGE_FILE = 50 * 1024 * 1024;

/** 'image': a picture; a leftover unless Stash has it as an image or gallery (checked by the caller). */
export type FileKind = 'junk' | 'leftover' | 'image' | 'keep';

export function isJunk(name: string): boolean {
  const lower = name.toLowerCase();
  return JUNK.has(lower) || lower.startsWith('._');
}

/** Whether a folder's files keep it: only videos, archives and large or unknown files do. */
export function keepsFolder(kinds: FileKind[]): boolean {
  return kinds.includes('keep');
}

/**
 * What a file means for its folder:
 * - keep: videos, downloads in progress, galleries (images/archives that aren't just artwork) and anything large
 * - leftover: what's left after the video moved (.nfo, .txt, subtitles, artwork, .url, .sfv…)
 * - junk: system files
 */
export function classifyFile(name: string, size: number): FileKind {
  if (isJunk(name)) {
    return 'junk';
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  if (VIDEO.has(ext) || ARCHIVE.has(ext) || PARTIAL.has(ext)) {
    return 'keep';
  }
  if (IMAGE.has(ext)) {
    if (size >= LARGE_FILE) {
      return 'keep';
    }
    return ARTWORK.test(name) ? 'leftover' : 'image';
  }
  return size >= LARGE_FILE ? 'keep' : 'leftover';
}

async function folderFileKinds(
  folder: string,
  entries: import('node:fs').Dirent[],
): Promise<FileKind[]> {
  const kinds: FileKind[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    if (!entry.isFile()) {
      // Links, sockets and the like: don't guess.
      kinds.push('keep');
      continue;
    }
    let size = Number.MAX_SAFE_INTEGER;
    try {
      size = (await fs.stat(path.join(folder, entry.name))).size;
    } catch {
      // Unknown size counts as large, so the folder is kept.
    }
    kinds.push(classifyFile(entry.name, size));
  }
  return kinds;
}

/** Whether Stashboard can see this folder itself (it's mounted into the container). */
export async function canSee(folder: string): Promise<boolean> {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Folders under root with no video (or gallery, or large file) left in them,
 * only leftovers like .nfo files, artwork and subtitles. Never includes root itself or anything protected.
 */
export async function findEmptyFolders(
  root: string,
  protectedPaths: string[] = [],
): Promise<string[]> {
  const keep = new Set([root, ...protectedPaths].map(normalize));
  const empty: string[] = [];
  let visited = 0;
  const walk = async (folder: string): Promise<boolean> => {
    visited += 1;
    if (visited > MAX_FOLDERS) {
      return false;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      return false;
    }
    let hasContent = keepsFolder(await folderFileKinds(folder, entries));
    for (const entry of entries) {
      if (entry.isDirectory() && !(await walk(path.join(folder, entry.name)))) {
        hasContent = true;
      }
    }
    const isEmpty = !hasContent;
    if (isEmpty && !keep.has(normalize(folder))) {
      empty.push(folder);
    }
    // A protected folder still counts as content for its parent.
    return isEmpty && !keep.has(normalize(folder));
  };
  await walk(root);
  return empty;
}

/**
 * Removes the given folders, deepest first, with the leftovers in them. Each
 * is checked again first: one that holds a video, gallery or large file now
 * is left alone, and so is one that still has a sub-folder.
 */
export async function removeEmptyFolders(
  folders: string[],
): Promise<{ removed: string[]; kept: string[] }> {
  const ordered = [...folders].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length,
  );
  const removed: string[] = [];
  const kept: string[] = [];
  for (const folder of ordered) {
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      if (keepsFolder(await folderFileKinds(folder, entries))) {
        kept.push(folder);
        continue;
      }
      if (entries.some((entry) => entry.isDirectory())) {
        kept.push(folder);
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile()) {
          await fs.unlink(path.join(folder, entry.name));
        }
      }
      // rmdir (not recursive) refuses to remove a folder that still has anything in it.
      await fs.rmdir(folder);
      removed.push(folder);
    } catch {
      kept.push(folder);
    }
  }
  return { removed, kept };
}

/** The folders a moved file left behind, from its old folder up to (not including) the library folder. */
export function foldersLeftBehind(
  oldPath: string,
  libraryRoot: string,
): string[] {
  const root = normalize(libraryRoot);
  const result: string[] = [];
  let folder = path.dirname(oldPath);
  while (
    normalize(folder).startsWith(`${root}/`) &&
    normalize(folder) !== root
  ) {
    result.push(folder);
    folder = path.dirname(folder);
  }
  return result;
}

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}
