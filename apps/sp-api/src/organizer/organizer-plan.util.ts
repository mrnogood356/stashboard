import type {
  StashOrganizerFile,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import type { StashdbMatchScene } from '../providers/stashdb/stashdb.adapter';
import {
  type MatchCandidateDto,
  type MatchSource,
  type RenamePlanDto,
  UNMATCHED_FOLDER,
} from './organizer.model';
import {
  findRoot,
  formatPerformers,
  formatResolution,
  joinPath,
  qualityTitle,
  RENAME_TOKENS,
  releaseGroup,
  renderPattern,
  splitPath,
  studioSlug,
} from './rename.util';
import {
  DEFAULT_WHISPARR_NAMING,
  hasWhisparrTokens,
  renderWhisparrFolders,
  renderWhisparrPattern,
  tokensOnlyWhisparrKnows,
  whisparrQuality,
  type WhisparrNamingOptions,
} from './whisparr-naming.util';

// The organizer's decisions that need no I/O: where a file goes, which
// matches are sure, and the small helpers both share.

/** Where a scene's file would go under the pattern, and whether it can be moved. */
export function planRename(
  scene: StashOrganizerScene,
  roots: string[],
  pattern: string,
  whisparrManaged: Set<string>,
  /** Library folder to put every file in; null keeps each file in the one it's in. */
  targetRoot: string | null = null,
  /** Whisparr's scene folders, as Stash sees them: files inside are Whisparr's. */
  whisparrFolders: string[] = [],
  /** Whisparr's naming settings, for patterns written in Whisparr's placeholders. */
  naming: WhisparrNamingOptions = DEFAULT_WHISPARR_NAMING,
): RenamePlanDto {
  const file = scene.files[0] ?? null;
  const base: RenamePlanDto = {
    sceneId: scene.id,
    fileId: file?.id ?? null,
    title: scene.title ?? file?.basename ?? `Scene #${scene.id}`,
    from: file?.path ?? null,
    to: null,
    state: 'ready',
  };
  if (!file) {
    return { ...base, state: 'no-file' };
  }
  if (scene.stashIds.some((entry) => whisparrManaged.has(entry.stashId))) {
    return { ...base, state: 'whisparr' };
  }
  // Inside one of Whisparr's scene folders, even if Stash links it to a
  // different StashDB scene (merged, say): moving it would lose it.
  if (
    scene.files.some((entry) =>
      whisparrFolders.some((folder) => isInside(entry.path, folder)),
    )
  ) {
    return { ...base, state: 'whisparr' };
  }
  const root = targetRoot ?? findRoot(file.path, roots);
  if (!root || !findRoot(file.path, roots)) {
    return { ...base, state: 'outside' };
  }
  const current = splitPath(file.path);
  const values = {
    title: scene.title,
    studio: scene.studio?.name ?? null,
    date: scene.date,
    year: scene.date?.slice(0, 4) ?? null,
    performers: formatPerformers(scene.performers),
    code: scene.code,
    resolution: formatResolution(file.width, file.height),
    stashdb: scene.stashIds[0]?.stashId ?? null,
    studioslug: studioSlug(scene.studio?.name),
    quality: qualityTitle(
      file.basename,
      formatResolution(file.width, file.height),
    ),
    group: releaseGroup(file.basename),
  };
  let rendered: { folders: string[]; name: string } | null;
  if (hasWhisparrTokens(pattern, RENAME_TOKENS)) {
    // Whisparr's placeholders: the name Whisparr itself would give it.
    const height =
      file.width && file.height ? Math.min(file.width, file.height) : null;
    const quality = whisparrQuality(file.basename, height);
    rendered = renderWhisparrPattern(
      pattern,
      {
        title: scene.title,
        studio: scene.studio?.name ?? null,
        date: scene.date,
        stashId: scene.stashIds[0]?.stashId ?? null,
        code: scene.code,
        performers:
          scene.performerDetails ?? scene.performers.map((name) => ({ name })),
        quality: quality.title,
        qualityProper: quality.proper,
        qualityReal: quality.real,
        releaseGroup: releaseGroup(file.basename),
        originalName: current.basename.slice(
          0,
          current.basename.length - current.extension.length,
        ),
      },
      naming,
      (token) =>
        (RENAME_TOKENS as readonly string[]).includes(token)
          ? (values[token as keyof typeof values] ?? '')
          : null,
    );
  } else {
    rendered = renderPattern(pattern, values);
  }
  if (
    !rendered ||
    (!scene.title &&
      /\{(title|scene[ ._-]*(clean)?title)/i.test(
        pattern.split('/').pop() ?? '',
      ))
  ) {
    return { ...base, state: 'missing' };
  }
  const { root: cleanRoot, folders } = withoutRepeatedPrefix(
    root,
    rendered.folders,
    staticPrefix(pattern),
  );
  // The file's own extension, as written (".MP4" stays ".MP4").
  const extension = current.basename.slice(
    current.basename.length - current.extension.length,
  );
  const to = joinPath(
    current.separator,
    cleanRoot,
    ...folders,
    `${rendered.name}${extension}`,
  );
  if (looksTheSame(to, file.path)) {
    return { ...base, to, state: 'same' };
  }
  // The scene already has another file with the new name (Stash put
  // Whisparr's copy in the same scene): this one is just an extra copy.
  const named = scene.files.find(
    (other) => other.id !== file.id && looksTheSame(to, other.path),
  );
  if (named) {
    return { ...base, to, state: 'copy', keepFileId: named.id };
  }
  return { ...base, to, state: 'ready' };
}

/**
 * Paths that differ only in letter case or in how accented letters are
 * encoded look identical, and many filesystems (and Stash) treat them as the
 * same file, so renaming between them never sticks.
 */
export function looksTheSame(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize('NFC').toLowerCase();
  return normalize(left) === normalize(right);
}

/**
 * Never add the pattern's fixed folders twice. If the library folder already
 * ends in them (or in repeats of them, from an earlier nested run), use it as
 * the start: "/data/x/scenes" + "scenes/Studio" → "/data/x/scenes/Studio",
 * and "/data/x/scenes/scenes" → "/data/x/scenes".
 */
export function withoutRepeatedPrefix(
  root: string,
  folders: string[],
  prefix: string[],
): { root: string; folders: string[] } {
  if (prefix.length === 0) {
    return { root, folders };
  }
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  let parts = root.replace(/[\\/]+$/, '').split(/[\\/]/);
  const endsWithPrefix = (list: string[]) =>
    list.length > prefix.length &&
    prefix.every(
      (segment, index) =>
        list[list.length - prefix.length + index].toLowerCase() ===
        segment.toLowerCase(),
    );
  let trimmed = false;
  while (endsWithPrefix(parts)) {
    parts = parts.slice(0, parts.length - prefix.length);
    trimmed = true;
  }
  return { root: trimmed ? parts.join(separator) || separator : root, folders };
}

/**
 * The folder a Whisparr scene belongs in, as Stash sees it: your pattern with
 * the scene's studio, date and title, e.g. /data/x/scenes/Studio/2020-01-02 - Title.
 */
export function whisparrFolderFor(
  pattern: string,
  base: string,
  movie: {
    title: string;
    studio?: string | null;
    date?: string | null;
    stashId: string | null;
  },
  naming: WhisparrNamingOptions = DEFAULT_WHISPARR_NAMING,
): string | null {
  // Without the studio, don't guess a folder ("Unsorted") — leave the scene alone.
  if (/\{[-. _[(]*studio/i.test(pattern) && !movie.studio) {
    return null;
  }
  if (hasWhisparrTokens(pattern, RENAME_TOKENS)) {
    // Something only Whisparr knows (the studio's network, say): can't tell.
    if (tokensOnlyWhisparrKnows(pattern).length > 0) {
      return null;
    }
    const components = renderWhisparrFolders(
      pattern,
      {
        title: movie.title,
        studio: movie.studio ?? null,
        date: movie.date ?? null,
        stashId: movie.stashId,
      },
      naming,
    );
    if (components.length === 0) {
      return null;
    }
    const { root, folders } = withoutRepeatedPrefix(
      base,
      components,
      staticPrefix(pattern),
    );
    return joinPath('/', root, ...folders);
  }
  const rendered = renderPattern(pattern, {
    title: movie.title,
    studio: movie.studio ?? null,
    date: movie.date ?? null,
    year: movie.date?.slice(0, 4) ?? null,
    stashdb: movie.stashId,
    studioslug: studioSlug(movie.studio),
  });
  if (!rendered) {
    return null;
  }
  const { root, folders } = withoutRepeatedPrefix(
    base,
    rendered.folders,
    staticPrefix(pattern),
  );
  return joinPath('/', root, ...folders, rendered.name);
}

/** Your pattern in Whisparr's Scene Folder Format tokens: "scenes/{studio}/{date} - {title}" → "scenes/{Studio Title}/{Release Date} - {Scene Title}". */
export function whisparrFolderFormat(pattern: string): string {
  const tokens: Record<string, string> = {
    studio: '{Studio Title}',
    date: '{Release Date}',
    year: '{Release Year}',
    title: '{Scene Title}',
    stashdb: '{StashId}',
    studioslug: '{Studio CleanTitleSlug}',
    quality: '{Quality Title}',
    group: '{Release Group}',
  };
  return pattern
    .trim()
    .replace(/\{([a-z]+)\}/g, (match, token: string) => tokens[token] ?? match);
}

/** The folders at the start of a pattern before any placeholder: "scenes/{studio}/…" → ["scenes"]. */
export function staticPrefix(pattern: string): string[] {
  const segments = pattern
    .trim()
    .split('/')
    .filter((segment) => segment.trim().length > 0);
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (segment.includes('{')) {
      break;
    }
    fixed.push(segment.trim());
  }
  return fixed;
}

/** Where an unmatched scene's file goes: "Unmatched" in its library folder, same file name. */
export function planUnmatchedMove(
  scene: StashOrganizerScene,
  roots: string[],
  targetRoot: string | null,
): RenamePlanDto {
  const file = scene.files[0] ?? null;
  const base: RenamePlanDto = {
    sceneId: scene.id,
    fileId: file?.id ?? null,
    title: file?.basename ?? scene.title ?? `Scene #${scene.id}`,
    from: file?.path ?? null,
    to: null,
    state: 'ready',
  };
  if (!file) {
    return { ...base, state: 'no-file' };
  }
  const ownRoot = findRoot(file.path, roots);
  if (!ownRoot) {
    return { ...base, state: 'outside' };
  }
  const current = splitPath(file.path);
  const to = joinPath(
    current.separator,
    targetRoot ?? ownRoot,
    UNMATCHED_FOLDER,
    current.basename,
  );
  return { ...base, to, state: to === file.path ? 'same' : 'ready' };
}

/** The chosen library folder, if Stash still has it as a library. */
export function pickTargetRoot(
  chosen: string | null | undefined,
  roots: string[],
): string | null {
  const wanted = (chosen ?? '').trim().replace(/[\\/]+$/, '');
  if (!wanted) {
    return null;
  }
  return (
    roots
      .map((root) => root.replace(/[\\/]+$/, ''))
      .find((root) => root === wanted) ?? null
  );
}

/** Two scenes landing on the same name get " (2)", " (3)"… */
export function dedupeTargets(plans: RenamePlanDto[]): RenamePlanDto[] {
  const taken = new Set(
    plans
      .filter((plan) => plan.state !== 'ready' && plan.from)
      .map((plan) => plan.from!.toLowerCase()),
  );
  return plans.map((plan) => {
    if (plan.state !== 'ready' || !plan.to) {
      return plan;
    }
    let target = plan.to;
    const split = splitPath(plan.to);
    const stem = split.basename.slice(
      0,
      split.basename.length - split.extension.length,
    );
    for (let copy = 2; taken.has(target.toLowerCase()); copy += 1) {
      target = joinPath(
        split.separator,
        split.folder,
        `${stem} (${copy})${split.extension}`,
      );
    }
    taken.add(target.toLowerCase());
    if (target === plan.to) {
      return plan;
    }
    // A second copy already renamed to "Title (2)" lands back on its own
    // name: nothing to do, or it would be "renamed" onto itself every time.
    return {
      ...plan,
      to: target,
      state: plan.from && looksTheSame(target, plan.from) ? 'same' : 'ready',
    };
  });
}

/** A sure enough match to save without asking. */
export function pickSure(
  candidates: MatchCandidateDto[],
): MatchCandidateDto | null {
  // Fingerprint matches all come from one source.
  const exact = candidates.filter(
    (candidate) => candidate.confidence === 'exact',
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return null;
  }
  // The same scene often appears on several sites; only rivals from the same site count.
  const best = candidates[0];
  const next = candidates
    .slice(1)
    .find((candidate) => candidate.source === best?.source);
  if (
    best?.confidence === 'strong' &&
    (!next || best.score - next.score >= 0.15)
  ) {
    return best;
  }
  return null;
}

export function fingerprintGroup(
  files: StashOrganizerFile[],
): Array<{ hash: string; algorithm: 'PHASH' | 'OSHASH' | 'MD5' }> {
  const file = files[0];
  if (!file) {
    return [];
  }
  return file.fingerprints.flatMap((print) => {
    const algorithm =
      print.type === 'phash'
        ? 'PHASH'
        : print.type === 'oshash'
          ? 'OSHASH'
          : print.type === 'md5'
            ? 'MD5'
            : null;
    return algorithm ? [{ hash: print.value, algorithm }] : [];
  });
}

export function lastFolderName(folder: string): string | null {
  const name = folder.split(/[\\/]/).filter(Boolean).pop();
  return name ?? null;
}

export function candidateId(
  source: MatchSource,
  match: StashdbMatchScene,
): string {
  return `${source.key}-${match.id}`.slice(0, 64);
}

export function labelFor(url: string): string {
  const host = hostOf(url) ?? url;
  if (host.includes('stashdb')) return 'StashDB';
  if (host.includes('fansdb')) return 'FansDB';
  if (host.includes('theporndb')) return 'ThePornDB';
  if (host.includes('pmvstash')) return 'PMV Stash';
  return host;
}

export function cacheKey(sceneId: string, candidateId: string): string {
  return `${sceneId}:${candidateId}`;
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'unknown error';
}

export function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/') === right.replace(/\\/g, '/');
}

export function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The path is in this folder or below it; slashes and letter case don't matter. */
function isInside(path: string, folder: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  const base = normalize(folder).replace(/\/+$/, '');
  return base.length > 0 && normalize(path).startsWith(`${base}/`);
}

/** Strictly below the folder, with no ".." anywhere on the way. */
export function isUnderFolder(path: string, folder: string): boolean {
  return (
    isInside(path, folder) &&
    !path.split(/[\\/]/).some((segment) => segment === '..')
  );
}

/** Placeholders that name one scene, not a group of them (a studio, a year). */
const SCENE_TOKEN =
  /\{[-. _[(]*(scene[ ._-]*)?(clean[ ._-]*)?(title|stashdb|stash[ ._-]*id|code)\b/i;

/**
 * A planned path with the scene in a folder of its own, the way Whisparr
 * keeps scenes: "…/Studio/2024-01-02 - Title.mp4" becomes
 * "…/Studio/2024-01-02 - Title/2024-01-02 - Title.mp4". When the pattern's
 * last folder already names the scene ("{studio}/{title}/{title} - {quality}"),
 * the path is kept as planned.
 */
export function inSceneFolder(planned: string, pattern: string): string {
  const segments = pattern
    .trim()
    .split('/')
    .filter((segment) => segment.trim().length > 0);
  const lastFolder = segments.length > 1 ? segments[segments.length - 2] : '';
  const ownFolder = (lastFolder.match(/\{[^}]*\}/g) ?? []).some(
    (token) => SCENE_TOKEN.test(token) && !/studio|site|network/i.test(token),
  );
  if (ownFolder) {
    return planned;
  }
  const { folder, basename, extension, separator } = splitPath(planned);
  const name = basename.slice(0, basename.length - extension.length).trim();
  return name ? joinPath(separator, folder, name, basename) : planned;
}

/** A file to remove from a scene that keeps another, identical one. */
export interface ExtraCopy {
  sceneId: string;
  keepFileId: string;
  removeFileId: string;
  path: string;
}

/**
 * Whisparr's imports that Stash attached to a scene that already had the
 * same video (a hardlink or copy left behind): the scene keeps Whisparr's
 * file and the others are extra copies. Only files with the very same
 * content (same oshash or md5) count, so two different versions of a scene
 * are never touched, and nothing is removed when the scene has more than
 * one of Whisparr's files.
 */
export function whisparrExtraCopies(
  scenes: StashOrganizerScene[],
  whisparrPaths: string[],
): ExtraCopy[] {
  const normalize = (value: string) =>
    value.replace(/\\/g, '/').normalize('NFC').toLowerCase();
  const whisparr = new Set(whisparrPaths.map(normalize));
  const hashes = (file: StashOrganizerFile) =>
    new Set(
      (file.fingerprints ?? [])
        .filter((entry) => ['oshash', 'md5'].includes(entry.type.toLowerCase()))
        .map((entry) => `${entry.type.toLowerCase()}:${entry.value}`),
    );
  const copies: ExtraCopy[] = [];
  for (const scene of scenes) {
    if (scene.files.length < 2) {
      continue;
    }
    const own = scene.files.filter((file) =>
      whisparr.has(normalize(file.path)),
    );
    if (own.length !== 1) {
      continue;
    }
    const keep = own[0];
    const keepHashes = hashes(keep);
    for (const file of scene.files) {
      if (
        file.id !== keep.id &&
        [...hashes(file)].some((hash) => keepHashes.has(hash))
      ) {
        copies.push({
          sceneId: scene.id,
          keepFileId: keep.id,
          removeFileId: file.id,
          path: file.path,
        });
      }
    }
  }
  return copies;
}

/** Headed lists for an activity entry's detail; empty lists are left out. */
export function listDetail(sections: Array<[string, string[]]>): string | null {
  const text = sections
    .filter(([, lines]) => lines.length > 0)
    .map(
      ([heading, lines]) =>
        `${heading} (${lines.length}):\n${lines.map((line) => `• ${line}`).join('\n')}`,
    )
    .join('\n\n');
  return text || null;
}
