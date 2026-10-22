import {
  namesTheScene,
  tokensOnlyWhisparrKnows,
  unknownWhisparrTokens,
  whisparrQuality,
} from './whisparr-naming.util';
import { trimSeparators, trimTrailingSeparators } from '../path-separators';

/** Placeholders you can use in a rename pattern. */
export const RENAME_TOKENS = [
  'title',
  'studio',
  'date',
  'year',
  'performers',
  'code',
  'resolution',
  'stashdb',
  'studioslug',
  'quality',
  'group',
] as const;
export type RenameToken = (typeof RENAME_TOKENS)[number];
export type RenameValues = Partial<Record<RenameToken, string | null>>;

export const DEFAULT_RENAME_PATTERN = '{studio}/{date} - {title}';
const MAX_SEGMENT = 150;
const MAX_NAME = 180;
/**
 * Linux allows 255 bytes per file or folder name, and Japanese or Chinese
 * text takes 3 bytes a character; leave room for the extension and a
 * " (12)" copy number.
 */
const MAX_BYTES = 200;

/** Null when the pattern is fine, otherwise what's wrong in plain words. */
export function validatePattern(pattern: string): string | null {
  const value = pattern.trim();
  if (!value) {
    return 'Enter a pattern.';
  }
  if (value.length > 200) {
    return 'Keep the pattern under 200 characters.';
  }
  if (/^[\\/]/.test(value) || /^[a-z]:/i.test(value)) {
    return 'Use a pattern relative to your library folder, not a full path.';
  }
  if (
    value
      .split('/')
      .some((segment) => segment.trim() === '..' || segment.trim() === '.')
  ) {
    return 'The pattern can’t go up a folder.';
  }
  if (value.includes('\\')) {
    return 'Use / between folders.';
  }
  const unknown = unknownWhisparrTokens(value, RENAME_TOKENS);
  if (unknown.length > 0) {
    return `Unknown placeholder {${unknown[0]}}. Use ${RENAME_TOKENS.map((token) => `{${token}}`).join(', ')}, or Whisparr's own, like {Scene Title}.`;
  }
  const only = tokensOnlyWhisparrKnows(value);
  if (only.length > 0) {
    return `{${only[0]}} needs Whisparr's own data, so Stashboard can't fill it. Leave it out here.`;
  }
  const last = value.split('/').pop() ?? '';
  if (!/\{(title|stashdb|code)\}/.test(last) && !namesTheScene(last)) {
    return "The file name part (after the last /) needs {title}, {code} or {stashdb} (or Whisparr's {Scene Title}), so every file gets its own name.";
  }
  return null;
}

/**
 * Folders and file name (without extension) from a pattern. Empty folder
 * parts become "Unsorted"; an empty file name returns null.
 */
export function renderPattern(
  pattern: string,
  values: RenameValues,
): { folders: string[]; name: string } | null {
  const segments = pattern
    .trim()
    .split('/')
    .filter((segment) => segment.trim().length > 0);
  const rendered = segments.map((segment) => renderSegment(segment, values));
  const name = cleanSegment(shorten(rendered.pop() ?? '', MAX_NAME));
  if (!name) {
    return null;
  }
  return {
    folders: rendered.map(
      (segment) => cleanSegment(shorten(segment, MAX_SEGMENT)) || 'Unsorted',
    ),
    name,
  };
}

/**
 * Cuts to at most maxChars characters and MAX_BYTES bytes of UTF-8, only
 * between whole characters, so an emoji is never split in half.
 */
function shorten(value: string, maxChars: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (result.length + char.length > maxChars || bytes + size > MAX_BYTES) {
      break;
    }
    result += char;
    bytes += size;
  }
  return result;
}

const SEPARATOR_AT_END = /\s*[-–—_.,]?\s*$/;
const SEPARATOR_AT_START = /^\s*[-–—_.,]?\s*/;

/**
 * Fills one folder or file-name part. When a placeholder is empty, the
 * separator next to it goes too: "{studio} - {date} - {title}" with no date
 * gives "Studio - Title", and "({year})" with no year disappears.
 */
function renderSegment(segment: string, values: RenameValues): string {
  const pieces = segment.split(/(\{[a-z]+\})/);
  // "{studioslug}.{title}.{date}" is a dotted name, like Whisparr's
  // {Scene.CleanTitle}: words in the values are joined with dots too.
  const literals = pieces.filter((piece, index) => index % 2 === 0 && piece);
  const dotted =
    literals.length > 0 &&
    literals.some((piece) => piece.includes('.')) &&
    literals.every((piece) => !/\s/.test(piece));
  const parts = pieces.map((part) =>
    /^\{[a-z]+\}$/.test(part)
      ? {
          literal: false,
          text: (dotted ? dotWords : sanitize)(
            values[part.slice(1, -1) as RenameToken] ?? '',
          ),
        }
      : { literal: true, text: part },
  );
  const hasContent = (text: string) =>
    text.replace(/[\s\-–—_.,()[\]]/g, '').length > 0;
  parts.forEach((part, index) => {
    if (part.literal || part.text) {
      return;
    }
    const previous = parts[index - 1];
    const next = parts[index + 1];
    if (
      previous?.literal &&
      next?.literal &&
      /[([]\s*$/.test(previous.text) &&
      /^\s*[)\]]/.test(next.text)
    ) {
      previous.text = previous.text.replace(/\s*[([]\s*$/, '');
      next.text = next.text.replace(/^\s*[)\]]/, '');
    }
    const contentBefore = parts
      .slice(0, index)
      .some((earlier) => hasContent(earlier.text));
    if (contentBefore && previous?.literal) {
      previous.text = previous.text.replace(SEPARATOR_AT_END, '');
    } else if (next?.literal) {
      next.text = next.text.replace(SEPARATOR_AT_START, '');
    }
  });
  return cleanSegment(parts.map((part) => part.text).join(''));
}

/** Removes characters that aren't allowed in file names on Linux, macOS or Windows. */
export function sanitize(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/:/g, ' -')
      .replace(/[\\/*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** "Mr. Smith's Day: Part 2" → "Mr.Smiths.Day.Part.2", as Whisparr's CleanTitle. */
function dotWords(value: string): string {
  return sanitize(value)
    .replace(/\s+-+\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.&+-]/gu, '')
    .replace(/&/g, 'and')
    .replace(/[\s.]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

/** "Bright Studio" → "BrightStudio", as Whisparr's Studio CleanTitleSlug. */
export function studioSlug(name: string | null | undefined): string {
  return (name ?? '').replace(/[^\p{L}\p{N}]/gu, '');
}

/** "WEBDL-1080p" from the file name and the video's resolution, as Whisparr's Quality Title. */
export function qualityTitle(fileName: string, resolution: string): string {
  const height = Number.parseInt(resolution, 10) || null;
  const { title } = whisparrQuality(fileName, height);
  return title === 'Unknown' ? '' : title;
}

/** The release group at the end of a scene-style name: "Studio.Title.1080p-GRP.mp4" → "GRP". */
export function releaseGroup(fileName: string): string {
  const name = fileName.replace(/\.[a-z0-9]{2,4}$/i, '');
  const group = /\.[^.\s]*-([A-Za-z0-9]{2,20})$/.exec(name)?.[1] ?? '';
  return /^(dl|rip|hd|sd|\d{3,4}p)$/i.test(group) ? '' : group;
}

/** Final tidy: single spaces, no stray separators at the ends, no trailing dots (Windows). */
export function cleanSegment(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_,]+|[\s\-–—_,]+$/g, '')
    .replace(/[.\s]+$/g, '')
    .trim();
}

export function formatPerformers(names: string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length <= 1) {
    return unique[0] ?? '';
  }
  if (unique.length <= 3) {
    return `${unique.slice(0, -1).join(', ')} & ${unique[unique.length - 1]}`;
  }
  return `${unique.slice(0, 3).join(', ')} +${unique.length - 3}`;
}

export function formatResolution(
  width: number | null,
  height: number | null,
): string {
  const short =
    width && height ? Math.min(width, height) : (height ?? width ?? 0);
  if (!short) {
    return '';
  }
  const standard = [4320, 2160, 1440, 1080, 720, 576, 480, 360, 240];
  const match = standard.find((size) => short >= size * 0.9);
  return `${match ?? short}p`;
}

export interface SplitPath {
  folder: string;
  basename: string;
  extension: string;
  separator: '/' | '\\';
}

export function splitPath(path: string): SplitPath {
  const separator: '/' | '\\' =
    path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const index = path.lastIndexOf(separator);
  const folder = index >= 0 ? path.slice(0, index) : '';
  const basename = index >= 0 ? path.slice(index + 1) : path;
  const dot = basename.lastIndexOf('.');
  const extension = dot > 0 ? basename.slice(dot).toLowerCase() : '';
  return { folder, basename, extension, separator };
}

/** The library folder a file lives in (the deepest one, when they nest). */
export function findRoot(path: string, roots: string[]): string | null {
  const matches = roots
    .map((root) => trimTrailingSeparators(root))
    .filter(
      (root) =>
        root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)),
    );
  return matches.sort((left, right) => right.length - left.length)[0] ?? null;
}

export function joinPath(separator: '/' | '\\', ...parts: string[]): string {
  return parts
    .filter((part, index) => part.length > 0 || index === 0)
    .map((part, index) =>
      index === 0 ? trimTrailingSeparators(part) : trimSeparators(part),
    )
    .join(separator);
}
