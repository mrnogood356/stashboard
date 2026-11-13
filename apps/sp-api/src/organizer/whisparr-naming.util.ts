// Whisparr's own file and folder naming, ported from its FileNameBuilder
// (src/NzbDrone.Core/Organizer/FileNameBuilder.cs), so a name built from a
// Whisparr format here is the name Whisparr itself would give the scene.

export type ColonReplacement =
  'delete' | 'dash' | 'spaceDash' | 'spaceDashSpace' | 'smart';

/** The parts of Whisparr's naming settings that change how names are written. */
export interface WhisparrNamingOptions {
  replaceIllegalCharacters: boolean;
  colonReplacement: ColonReplacement;
}

/** Whisparr's defaults. */
export const DEFAULT_WHISPARR_NAMING: WhisparrNamingOptions = {
  replaceIllegalCharacters: true,
  colonReplacement: 'smart',
};

export interface WhisparrSceneValues {
  title: string | null;
  studio: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  stashId: string | null;
  code?: string | null;
  performers?: Array<{ name: string; gender?: string | null }>;
  /** Whisparr's quality name, like "WEBDL-1080p". */
  quality?: string | null;
  qualityProper?: boolean;
  qualityReal?: boolean;
  releaseGroup?: string | null;
  /** The file's current name, without the extension. */
  originalName?: string | null;
}

const MAX_PATH_PART = 255;

const TITLE_TOKEN =
  /(?<tag>\{(?:imdb-|edition-))?\{(?<prefix>[- ._[(]*)(?<token>(?:[a-z0-9]+)(?:(?<separator>[- ._]+)(?:[a-z0-9]+))?)(?::(?<customFormat>[ ,a-z0-9|+-]+(?<![- ])))?(?<suffix>[-} ._)\]]*)\}/gi;
const FILE_NAME_CLEANUP = /([- ._])(\1)+/g;
const TRIM_SEPARATORS = /[- ._]+$/;
const SCENIFY_REMOVE =
  /(?<=\s)(,|<|>|\/|\\|;|:|'|"|\||`|’|~|!|\?|@|$|%|^|\*|-|_|=){1}(?=\s)|('|`|’|:|\?|,)(?=(?:(?:s|m|t|ve|ll|d|re)\s)|\s|$)|(\(|\)|\[|\]|\{|\})/gi;
const SCENIFY_REPLACE = /[/]/gi;
// .NET strings are UTF-16: each half of an emoji becomes a space.
const SURROGATE = /[\uD800-\uDFFF]/g;
const TITLE_PREFIX = /^(The|An|A) (.*?)((?: *\([^)]+\))*)$/i;
const RESERVED_DEVICE_NAMES = /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)\./i;
const BAD_CHARACTERS = ['\\', '/', '<', '>', '?', '*', '|', '"'];
const GOOD_CHARACTERS = ['+', '+', '', '', '!', '-', '', ''];

/** Whisparr's token names compare without spaces, punctuation or case. */
function simplify(token: string): string {
  return token.replace(/[\s_\W]/g, '').toLowerCase();
}

/** Tokens Stashboard can't know (they need Whisparr's own data): never filled. */
const UNKNOWN_HERE = [
  'studionetwork',
  'studiocleannetwork',
  'studiocleannetworkslug',
  'imdbid',
  'tmdbid',
  'edition',
  'customformats',
  'customformat',
];

/** True when a pattern uses any of Whisparr's own placeholders. */
export function hasWhisparrTokens(
  pattern: string,
  stashboardTokens: readonly string[],
): boolean {
  return [...pattern.matchAll(TITLE_TOKEN)].some(
    (match) => !stashboardTokens.includes(match[0].slice(1, -1)),
  );
}

/** Whisparr placeholders in the pattern that only Whisparr can fill, by name. */
export function tokensOnlyWhisparrKnows(pattern: string): string[] {
  return [...pattern.matchAll(TITLE_TOKEN)]
    .map((match) => match.groups?.token ?? '')
    .filter((token) => {
      const key = simplify(token);
      return (
        UNKNOWN_HERE.some((unknown) => key.startsWith(unknown)) ||
        key.startsWith('mediainfo')
      );
    });
}

/** Every placeholder Whisparr understands for scenes, simplified. */
const KNOWN = new Set([
  'studiotitle',
  'studiotitleslug',
  'studiocleantitle',
  'studiocleantitleslug',
  'studiotitlethe',
  'studiotitlefirstcharacter',
  'studionetwork',
  'studiocleannetwork',
  'studiocleannetworkslug',
  'releasedate',
  'releaseshortdate',
  'releaseyear',
  'scenetitle',
  'scenecleantitle',
  'scenetitlethe',
  'scenetitlefirstcharacter',
  'scenecleantitlenoseasonepisode',
  'scenecode',
  'stashid',
  'imdbid',
  'tmdbid',
  'qualityfull',
  'qualitytitle',
  'qualityproper',
  'qualityreal',
  'originaltitle',
  'originalfilename',
  'releasegroup',
  'edition',
  'editiontags',
  'customformats',
  ...[
    '',
    'female',
    'male',
    'other',
    'alias',
    'femalealias',
    'malealias',
    'otheralias',
  ].flatMap((kind) => [
    `sceneperformers${kind}`,
    `scenecleanperformers${kind}`,
  ]),
]);

/** Whisparr's placeholders in the pattern that Whisparr doesn't know, as written. */
export function unknownWhisparrTokens(
  pattern: string,
  stashboardTokens: readonly string[],
): string[] {
  return [...pattern.matchAll(TITLE_TOKEN)]
    .filter((match) => !stashboardTokens.includes(match[0].slice(1, -1)))
    .map((match) => match.groups?.token ?? '')
    .filter(
      (token) =>
        !KNOWN.has(simplify(token)) && !simplify(token).startsWith('mediainfo'),
    );
}

/** Whether a scene placeholder that names the scene is in this part. */
export function namesTheScene(segment: string): boolean {
  return [...segment.matchAll(TITLE_TOKEN)].some((match) =>
    [
      'scenetitle',
      'scenecleantitle',
      'scenetitlethe',
      'scenecleantitlenoseasonepisode',
      'stashid',
      'scenecode',
      'originaltitle',
      'originalfilename',
    ].includes(simplify(match.groups?.token ?? '')),
  );
}

// ---------- Whisparr's text helpers ----------

export function removeDiacritics(text: string): string {
  return text
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'AE')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE')
    .replace(/[øØ]/g, (char) => (char === 'ø' ? 'o' : 'O'))
    .replace(/[łŁ]/g, (char) => (char === 'ł' ? 'l' : 'L'))
    .replace(/[đĐ]/g, (char) => (char === 'đ' ? 'd' : 'D'))
    .replace(/þ/g, 'th')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .normalize('NFC');
}

/** Whisparr's CleanTitle. */
export function cleanTitle(title: string | null | undefined): string {
  if (!title?.trim()) {
    return '';
  }
  return removeDiacritics(
    title
      .replace(/&/g, 'and')
      .replace(SCENIFY_REPLACE, ' ')
      .replace(SURROGATE, ' ')
      .replace(SCENIFY_REMOVE, ''),
  );
}

/** Whisparr's SlugTitle. */
export function slugTitle(title: string): string {
  return title
    .replace(/ /g, '')
    .replace(SCENIFY_REMOVE, '')
    .replace(SCENIFY_REPLACE, ' ');
}

function titleThe(title: string): string {
  return title.replace(TITLE_PREFIX, '$2, $1$3');
}

function titleFirstCharacter(title: string): string {
  const letterOrDigit = (char: string | undefined) =>
    !!char && /[\p{L}\p{N}]/u.test(char);
  if (letterOrDigit(title[0])) {
    return removeDiacritics(title.slice(0, 1).toUpperCase())[0] ?? '_';
  }
  if (letterOrDigit(title[1])) {
    return removeDiacritics(title.slice(1, 2).toUpperCase())[0] ?? '_';
  }
  return '_';
}

/** Whisparr's CleanPerformer. */
function cleanPerformer(name: string): string {
  if (!name.trim()) {
    return '';
  }
  if (/^-?\d+$/.test(name)) {
    return name;
  }
  return name
    .replace(/[^\p{L}\p{N}_\s]/gu, '')
    .replace(/^(a|an|the)\s/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(&|:|\\|\/)+/g, '')
    .trim();
}

function cleanFileName(name: string, options: WhisparrNamingOptions): string {
  let result = name;
  if (options.replaceIllegalCharacters) {
    if (options.colonReplacement === 'smart') {
      result = result.replace(/: /g, ' - ').replace(/:/g, '-');
    } else {
      const replacement = {
        delete: '',
        dash: '-',
        spaceDash: ' -',
        spaceDashSpace: ' - ',
      }[options.colonReplacement];
      result = result.replace(/:/g, replacement);
    }
  } else {
    result = result.replace(/:/g, '');
  }
  BAD_CHARACTERS.forEach((bad, index) => {
    result = result
      .split(bad)
      .join(options.replaceIllegalCharacters ? GOOD_CHARACTERS[index] : '');
  });
  return result.replace(/^[ .]+/, '').replace(/ +$/, '');
}

function cleanFolderName(name: string): string {
  return name
    .replace(FILE_NAME_CLEANUP, (match) => match[0])
    .replace(/^[ .]+|[ .]+$/g, '');
}

function replaceReservedDeviceNames(input: string): string {
  return input.replace(RESERVED_DEVICE_NAMES, (match) =>
    match.replace('.', '_'),
  );
}

// ---------- tokens ----------

type Handler = (match: {
  prefix: string;
  suffix: string;
  customFormat: string | null;
}) => string;

function truncate(input: string, customFormat: string | null): string {
  if (!input.trim()) {
    return '';
  }
  const maxLength = Number.parseInt(customFormat ?? '', 10) || 0;
  if (maxLength === 0 || input.length <= Math.abs(maxLength)) {
    return input;
  }
  if (maxLength < 0) {
    const kept = [...input]
      .reverse()
      .slice(0, Math.abs(maxLength) - 3)
      .join('')
      .replace(/[ .]+$/, '');
    return `{ellipsis}${[...kept].reverse().join('')}`;
  }
  return `${input.slice(0, maxLength - 3).replace(/[ .]+$/, '')}{ellipsis}`;
}

function handlers(
  values: WhisparrSceneValues,
  trimEnd: number,
  multipleTokens: boolean,
): Map<string, Handler> {
  const map = new Map<string, Handler>();
  const set = (token: string, handler: Handler) =>
    map.set(simplify(token), handler);
  const cut = (text: string) =>
    trimEnd > 0 ? text.slice(0, Math.max(0, text.length - trimEnd)) : text;

  const studio = values.studio?.trim() ?? '';
  if (studio) {
    set('Studio Title', () => studio);
    set('Studio TitleSlug', () => slugTitle(studio));
    set('Studio CleanTitle', () => cleanTitle(studio));
    set('Studio CleanTitleSlug', () => slugTitle(cleanTitle(studio)));
    set('Studio TitleThe', () => titleThe(studio));
    set('Studio TitleFirstCharacter', () => {
      const first = titleThe(studio).slice(0, 1);
      return first.toUpperCase();
    });
  }

  const date = values.date?.trim() ?? '';
  if (date) {
    set('Release Date', () => date);
    set('Release ShortDate', () => date.replace(/-/g, ' ').slice(2));
  } else {
    set('Release Date', () => 'Unknown');
  }
  const year = /^\d{4}/.exec(date)?.[0] ?? '';
  set('Release Year', () => year);

  const performers = [...(values.performers ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const genders: Record<string, (gender: string) => boolean> = {
    '': () => true,
    Female: (gender) => gender === 'FEMALE',
    Male: (gender) => gender === 'MALE',
    Other: (gender) =>
      [
        'TRANSGENDER_MALE',
        'TRANSGENDER_FEMALE',
        'NON_BINARY',
        'INTERSEX',
      ].includes(gender),
  };
  for (const [kind, matches] of Object.entries(genders)) {
    const picked = () =>
      performers
        .filter((performer) => matches((performer.gender ?? '').toUpperCase()))
        .slice(0, 4)
        .map((performer) => performer.name);
    // Stashboard has no character names: the alias forms use the names.
    for (const alias of ['', 'Alias']) {
      set(`Scene Performers${kind}${alias}`, () => picked().join(' '));
      set(`Scene CleanPerformers${kind}${alias}`, () =>
        picked().map(cleanPerformer).join(' '),
      );
    }
  }
  set('Scene Code', () => values.code?.trim() ?? '');

  const title = values.title ?? '';
  set('Scene Title', () => cut(title));
  set('Scene CleanTitle', () => cut(cleanTitle(title)));
  set('Scene TitleThe', () => cut(titleThe(title)));
  set('Scene TitleFirstCharacter', () =>
    title ? cut(titleFirstCharacter(titleThe(title))) : '',
  );
  set('Scene CleanTitleNoSeasonEpisode', () =>
    cut(
      cleanTitle(title)
        .replace(/\s*-?\s*S\d+:E\d+\s*/gi, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );

  set('StashId', () => values.stashId ?? '');

  const quality = values.quality?.trim() ?? '';
  if (quality) {
    const proper = values.qualityProper ? 'Proper' : '';
    const real = values.qualityReal ? 'REAL' : '';
    set('Quality Full', () => `${quality} ${proper} ${real}`);
    set('Quality Title', () => quality);
    set('Quality Proper', () => proper);
    set('Quality Real', () => real);
  }

  const original = values.originalName ?? '';
  set('Original Title', () =>
    multipleTokens ? '' : cleanFileName(original, DEFAULT_WHISPARR_NAMING),
  );
  set('Original Filename', () => (multipleTokens ? '' : original));
  set('Release Group', (match) =>
    values.releaseGroup?.trim()
      ? truncate(values.releaseGroup.trim(), match.customFormat)
      : !match.prefix && !match.suffix
        ? 'Whisparr'
        : '',
  );
  return map;
}

function replaceTokens(
  pattern: string,
  map: Map<string, Handler>,
  options: WhisparrNamingOptions,
  fallback?: (token: string) => string | null,
): string {
  return pattern.replace(TITLE_TOKEN, (...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const tag = groups.tag ?? '';
    const prefix = groups.prefix ?? '';
    const separator = groups.separator ?? '';
    const suffix = groups.suffix ?? '';
    const token = groups.token ?? '';
    const customFormat = groups.customFormat?.trim()
      ? groups.customFormat
      : null;
    const handler = map.get(simplify(token));
    const own = handler ? null : (fallback?.(token) ?? null);
    let replacement = (
      handler ? handler({ prefix, suffix, customFormat }) : (own ?? '')
    ).trim();
    if (!own) {
      if (
        [...token].every(
          (char) =>
            !/\p{L}/u.test(char) ||
            (char === char.toLowerCase() && char !== char.toUpperCase()),
        )
      ) {
        replacement = replacement.toLowerCase();
      } else if (
        [...token].every(
          (char) =>
            !/\p{L}/u.test(char) ||
            (char === char.toUpperCase() && char !== char.toLowerCase()),
        )
      ) {
        replacement = replacement.toUpperCase();
      }
    }
    if (separator.trim()) {
      replacement = replacement.split(' ').join(separator);
    }
    replacement = cleanFileName(replacement, options);
    return replacement.trim()
      ? tag + prefix + replacement + suffix
      : replacement;
  });
}

/**
 * Folders and file name (without extension) from a Whisparr format, as
 * Whisparr builds them: every part but the last is a folder (its Scene
 * Folder Format), the last is the file name (its Standard Scene Format).
 * Empty folders are left out, as Whisparr does. Null when there's no name.
 *
 * `own` fills Stashboard's own placeholders ({title}…) when a pattern mixes
 * them in; Whisparr's case rules don't apply to those.
 */
export function renderWhisparrPattern(
  pattern: string,
  values: WhisparrSceneValues,
  options: WhisparrNamingOptions = DEFAULT_WHISPARR_NAMING,
  own?: (token: string) => string | null,
): { folders: string[]; name: string } | null {
  const parts = pattern.split(/[\\/]/).filter((part) => part.length > 0);
  const filePart = parts.pop();
  if (filePart === undefined) {
    return null;
  }
  const folderHandlers = handlers(values, 0, false);
  const folders = parts.flatMap((part) => {
    let component = cleanFolderName(
      replaceTokens(part, folderHandlers, options, own),
    );
    component = replaceReservedDeviceNames(
      component.replace(/\{ellipsis\}/g, '...'),
    ).slice(0, MAX_PATH_PART);
    return component.trim() ? [component] : [];
  });

  const multipleTokens = [...filePart.matchAll(TITLE_TOKEN)].length > 1;
  let trimEnd = 0;
  let name = replaceTokens(
    filePart,
    handlers(values, trimEnd, multipleTokens),
    options,
    own,
  ).trim();
  while (name.length > MAX_PATH_PART && trimEnd < MAX_PATH_PART) {
    trimEnd += 1;
    name = replaceTokens(
      filePart,
      handlers(values, trimEnd, multipleTokens),
      options,
      own,
    ).trim();
  }
  name = name
    .replace(FILE_NAME_CLEANUP, (match) => match[0])
    .replace(TRIM_SEPARATORS, '')
    .replace(/\{ellipsis\}/g, '...');
  name = replaceReservedDeviceNames(name);
  return name.trim() ? { folders, name } : null;
}

/**
 * A scene's folder from Whisparr's Scene Folder Format, as Whisparr builds
 * it: every part is a folder, and empty ones are left out.
 */
export function renderWhisparrFolders(
  pattern: string,
  values: WhisparrSceneValues,
  options: WhisparrNamingOptions = DEFAULT_WHISPARR_NAMING,
): string[] {
  const map = handlers(values, 0, false);
  return pattern
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .flatMap((part) => {
      const component = replaceReservedDeviceNames(
        cleanFolderName(replaceTokens(part, map, options)).replace(
          /\{ellipsis\}/g,
          '...',
        ),
      ).slice(0, MAX_PATH_PART);
      return component.trim() ? [component] : [];
    });
}

// ---------- quality ----------

const SOURCES: Array<[string, RegExp]> = [
  ['Remux', /\b(?:BD|UHD)?[-_. ]?Remux\b/i],
  [
    'WEBDL',
    /\b(?:WEB[-_. ]?DL(?:mux)?|AmazonHD|AmazonSD|iTunesHD|NetflixU?HD|WebHD)\b|[. ]WEB[. ]|[-. ]WEB$/i,
  ],
  ['WEBRip', /\b(?:WebRip|Web-Rip|WEBMux)\b/i],
  ['Bluray', /\b(?:Blu[-_. ]?ray|BDRip|BRRip|BDLight|UHDBDRip)\b/i],
  ['HDTV', /\bHDTV\b/i],
  ['DVD', /\b(?:DVD(?!-R)|DVDRip|xvidvd)\b/i],
  ['SDTV', /\b(?:SDTV|PDTV|TVRip|DSR)\b/i],
];

const RESOLUTIONS: Array<[number, RegExp]> = [
  [4320, /\b(?:4320p|7680x4320|8k)\b/i],
  [3384, /\b(?:3384p|6016x3384)\b/i],
  [3160, /\b(?:3160p|6144x3160|6k)\b/i],
  [2880, /\b(?:2880p|5120x2880|5k)\b/i],
  [2160, /\b(?:2160p|3840x2160|4096x2160|4k|UHD)\b/i],
  [1080, /\b(?:1080p|1920x1080|1440p|FHD|1080i)\b/i],
  [720, /\b(?:720p|1280x720|960p)\b/i],
  [576, /\b576p\b/i],
  [480, /\b(?:480p|480i|640x480|848x480|540p|360p)\b/i],
];

/** The resolution Whisparr would put a video in, from its height (or shorter side). */
function bucket(height: number): number {
  for (const size of [4320, 3384, 3160, 2880, 2160, 1080, 720, 576, 480]) {
    if (height >= size * 0.9) {
      return size;
    }
  }
  return height > 0 ? 480 : 0;
}

/**
 * Whisparr's quality name for a file, as its parser decides it: the source in
 * the name (WEB-DL, Blu-ray…) and the resolution in the name, else the
 * video's. A name with only a resolution counts as WEB-DL, as Whisparr does.
 */
export function whisparrQuality(
  fileName: string,
  videoHeight: number | null,
): { title: string; proper: boolean; real: boolean } {
  const name = fileName.replace(/_/g, ' ');
  const source = SOURCES.find(([, pattern]) => pattern.test(name))?.[0];
  const fromName = RESOLUTIONS.find(([, pattern]) => pattern.test(name))?.[0];
  let resolution = fromName ?? (videoHeight ? bucket(videoHeight) : 0);
  const proper = /\b(?:proper|repack\d?|rerip\d?)\b/i.test(name);
  const real = /\bREAL\b/.test(name);
  if (!resolution) {
    const title =
      source === 'DVD'
        ? 'DVD'
        : source === 'SDTV' || source === 'HDTV'
          ? 'SDTV'
          : 'Unknown';
    return { title, proper, real };
  }
  if (source === 'DVD' || (source === 'SDTV' && resolution <= 576)) {
    return { title: source === 'DVD' ? 'DVD' : 'SDTV', proper, real };
  }
  const kind =
    source === 'SDTV'
      ? 'HDTV'
      : source === 'Remux'
        ? 'Remux'
        : (source ?? 'WEBDL');
  // Only WEB-DL goes past 2160p; Blu-ray, WEBRip and HDTV stop there.
  if (resolution > 2160 && kind !== 'WEBDL') {
    resolution = 2160;
  }
  if (kind === 'Remux') {
    return {
      title: `Remux-${resolution >= 2160 ? 2160 : 1080}p`,
      proper,
      real,
    };
  }
  if (kind === 'HDTV' && resolution < 720) {
    return { title: 'SDTV', proper, real };
  }
  if (resolution === 576 && kind !== 'Bluray') {
    resolution = 480;
  }
  if (resolution === 480 && kind === 'HDTV') {
    return { title: 'SDTV', proper, real };
  }
  return { title: `${kind}-${resolution}p`, proper, real };
}
