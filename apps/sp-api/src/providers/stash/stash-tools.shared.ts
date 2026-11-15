import { type StashCheckScene } from './stash.types';

/**
 * Types and helpers shared by the Library tools layers of the Stash adapter:
 * jobs → files → checks → organizer → library tools, each extending the last.
 */

/** A chapter with no end and nothing after it plays this long. */
export const DEFAULT_CHAPTER_SECONDS = 60;

export interface StashChapter {
  id: string;
  title: string;
  seconds: number;
  endSeconds: number;
  tagName: string | null;
  sceneId: string;
  sceneTitle: string;
}

/** A performer or studio, for Library tools → Merge. */
export interface StashMergeCandidate {
  id: string;
  name: string;
  aliases: string[];
  sceneCount: number;
  /** A performer's disambiguation, or a studio's parent. */
  note: string | null;
  /** Performers: when they died, when Stash has it. */
  deathDate: string | null;
  /** Its StashDB/FansDB links, as "endpoint|id". */
  links: string[];
}

/** Stash jobs remembered for reuse; older ones are forgotten. */
export const MAX_REMEMBERED_JOBS = 200;

/** The kept one's aliases and links, plus the merged ones' names, aliases and links. */
export function mergedValues(
  keep: Record<string, unknown>,
  sources: Array<Record<string, unknown>>,
  aliasField: 'alias_list' | 'aliases',
): {
  aliases: string[];
  stashIds: Array<{ endpoint: string; stash_id: string }>;
} {
  const keepName = (typeof keep['name'] === 'string' ? keep['name'] : '')
    .trim()
    .toLowerCase();
  const aliases = new Map<string, string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      const key = value.trim().toLowerCase();
      if (key !== keepName && !aliases.has(key)) {
        aliases.set(key, value.trim());
      }
    }
  };
  const list = (row: Record<string, unknown>, field: string) =>
    Array.isArray(row[field]) ? (row[field] as unknown[]) : [];
  list(keep, aliasField).forEach(add);
  for (const source of sources) {
    add(source['name']);
    list(source, aliasField).forEach(add);
  }
  const links = new Map<string, { endpoint: string; stash_id: string }>();
  for (const row of [keep, ...sources]) {
    for (const link of list(row, 'stash_ids') as Array<
      Record<string, unknown>
    >) {
      const endpoint = link?.['endpoint'];
      const stashId = link?.['stash_id'];
      if (typeof endpoint === 'string' && typeof stashId === 'string') {
        links.set(`${endpoint} ${stashId}`, { endpoint, stash_id: stashId });
      }
    }
  }
  return { aliases: [...aliases.values()], stashIds: [...links.values()] };
}

/** What the duplicate and sample finders show for each scene. */
export const DUPLICATE_SCENE_FIELDS = `id title date play_count organized
  paths { screenshot }
  studio { name }
  files { path basename size width height duration video_codec bit_rate frame_rate }`;

export const STASH_ORGANIZER_SCENE_FIELDS = `
  id title code date organized created_at
  paths { screenshot }
  studio { id name }
  performers { name gender }
  tags { id }
  stash_ids { endpoint stash_id }
  files { id path basename duration size width height fingerprints { type value } }
`;

export const STASH_GENDERS = new Set([
  'MALE',
  'FEMALE',
  'TRANSGENDER_MALE',
  'TRANSGENDER_FEMALE',
  'INTERSEX',
  'NON_BINARY',
]);

/** Stash sends ids as strings; anything else reads as no id. */
/** A scene from the check list, or null when it has no id or no file. */
export function checkSceneOf(
  scene: Record<string, unknown>,
  normalize: (value: unknown) => string | null,
): StashCheckScene | null {
  const id = normalize(scene['id']);
  const files = Array.isArray(scene['files'])
    ? (scene['files'] as Array<Record<string, unknown>>)
    : [];
  if (!id || files.length === 0) {
    return null;
  }
  const text = (value: unknown) =>
    typeof value === 'string' && value ? value : null;
  const checkFiles = files.flatMap((file) => {
    const path = text(file['path']);
    if (!path) {
      return [];
    }
    const prints = Array.isArray(file['fingerprints'])
      ? (file['fingerprints'] as Array<Record<string, unknown>>)
      : [];
    const print = (type: string) =>
      text(prints.find((entry) => entry['type'] === type)?.['value']);
    const size = Number(file['size']);
    return [
      {
        id: idText(file['id']),
        path,
        size: Number.isFinite(size) ? size : null,
        modTime: text(file['mod_time']),
        oshash: print('oshash'),
        md5: print('md5'),
        phash: print('phash'),
      },
    ];
  });
  if (checkFiles.length === 0) {
    return null;
  }
  const markers = Array.isArray(scene['scene_markers'])
    ? (scene['scene_markers'] as Array<Record<string, unknown>>)
    : [];
  return {
    id,
    title:
      text(scene['title']) ?? text(files[0]?.['basename']) ?? `Scene ${id}`,
    files: checkFiles,
    markerIds: markers.flatMap((marker) => {
      const markerId = normalize(marker['id']);
      return markerId ? [markerId] : [];
    }),
  };
}

export function idText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

export function hostLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
