import type { StashdbMatchScene } from '../providers/stashdb/stashdb.adapter';

/** Words that say nothing about which scene a file is. */
const JUNK = new Set([
  'xxx',
  'mp4',
  'mkv',
  'wmv',
  'avi',
  'mov',
  'm4v',
  'webm',
  'flv',
  'ts',
  '4k',
  'uhd',
  'fhd',
  'hd',
  'sd',
  'hq',
  'hevc',
  'avc',
  'aac',
  'ac3',
  'x264',
  'x265',
  'h264',
  'h265',
  'web',
  'webdl',
  'webrip',
  'hdrip',
  'bluray',
  'bdrip',
  'dvdrip',
  'repack',
  'proper',
  'internal',
  'split',
  'scenes',
  'scene',
  'hdr',
  'hdr10',
  'sdr',
  'vr',
  'sbs',
  'lr',
  'tb',
  'oculus',
  'gear',
  'rarbg',
  'ktr',
  'xc',
  'iak',
  'gush',
  'wrb',
  'p2p',
  'yapg',
  'nbq',
  'gagball',
  'prt',
  'xleech',
  'full',
  'new',
  'final',
  'video',
  'clip',
  'part',
  'cd1',
  'cd2',
  'sample',
  'trailer',
  'www',
  'com',
]);
const STOP = new Set([
  'the',
  'and',
  'a',
  'an',
  'with',
  'in',
  'on',
  'of',
  'to',
  'for',
  'at',
  'by',
  'is',
  'my',
  'her',
  'his',
  'it',
]);

export interface ParsedFileName {
  /** Cleaned words, good as a search term. */
  text: string;
  tokens: string[];
  /** YYYY-MM-DD when the name contains a date. */
  date: string | null;
  /** Lower-case letters (any script) and digits only, for "is this name in the file name" checks. */
  compact: string;
}

export function parseFileName(
  basename: string,
  folder?: string | null,
): ParsedFileName {
  const withoutExt = basename.replace(/\.[a-z0-9]{2,4}$/i, '');
  const extracted = extractDate(withoutExt);
  let date = extracted.date;
  let words = tokenize(extracted.rest);
  // "video.mp4" or a hash-like name says nothing; use the folder name too.
  if (words.filter((word) => /[a-z]/.test(word)).length < 2 && folder) {
    const fromFolder = extractDate(folder);
    date = date ?? fromFolder.date;
    words = [...tokenize(fromFolder.rest), ...words];
  }
  const text = words.join(' ');
  return {
    text,
    tokens: words,
    date,
    compact: compact(`${withoutExt} ${folder ?? ''}`),
  };
}

function extractDate(value: string): { date: string | null; rest: string } {
  const long =
    /(?:^|[^0-9])((?:19|20)\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})(?![0-9])/.exec(
      value,
    );
  if (long && isValidDate(+long[1], +long[2], +long[3])) {
    return {
      date: `${long[1]}-${long[2]}-${long[3]}`,
      rest: value.replace(long[0], ' '),
    };
  }
  const short = /(?:^|[^0-9])(\d{2})[.\-_ ](\d{2})[.\-_ ](\d{2})(?![0-9])/.exec(
    value,
  );
  if (short && isValidDate(2000 + +short[1], +short[2], +short[3])) {
    return {
      date: `20${short[1]}-${short[2]}-${short[3]}`,
      rest: value.replace(short[0], ' '),
    };
  }
  return { date: null, rest: value };
}

function isValidDate(year: number, month: number, day: number): boolean {
  return (
    year >= 1990 &&
    year <= 2099 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

function tokenize(value: string): string[] {
  return (
    value
      // Release group at the end: "...-GROUP"
      .replace(/-[A-Za-z0-9]{2,12}$/, ' ')
      .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .map((word) => word.replace(/^'+|'+$/g, ''))
      .filter(
        (word) =>
          word.length >= 2 &&
          !JUNK.has(word) &&
          !/^\d{3,4}p$/.test(word) &&
          !/^\d+fps$/.test(word) &&
          !/^\d+bit$/.test(word) &&
          !/^[0-9a-f]{12,}$/.test(word),
      )
  );
}

export function compact(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Any script's letters, so a Japanese or Cyrillic studio name can match too.
      .replace(/[^\p{L}\p{N}]/gu, '')
  );
}

export type MatchConfidence = 'exact' | 'strong' | 'likely' | 'weak';

export interface CandidateScore {
  score: number;
  confidence: MatchConfidence;
  reasons: string[];
}

/** How well a StashDB scene fits a local file found by name. */
export function scoreByName(
  parsed: ParsedFileName,
  fileDuration: number | null,
  candidate: StashdbMatchScene,
): CandidateScore {
  const reasons: string[] = [];
  let score = 0;

  if (fileDuration && candidate.duration) {
    const diff = Math.abs(fileDuration - candidate.duration);
    if (diff <= 3) {
      score += 0.35;
      reasons.push('Same length');
    } else if (diff <= 15) {
      score += 0.2;
      reasons.push('Almost the same length');
    } else if (diff > 60) {
      score -= 0.25;
      reasons.push('Different length');
    }
  }

  const fileWords = new Set(parsed.tokens);
  const titleWords = tokenize(candidate.title ?? '').filter(
    (word) => !STOP.has(word),
  );
  if (titleWords.length > 0) {
    const found =
      titleWords.filter((word) => fileWords.has(word)).length /
      titleWords.length;
    score += 0.35 * found;
    if (found >= 0.6) {
      reasons.push('Title in file name');
    }
  }

  const studio = candidate.studio ? compact(candidate.studio.name) : '';
  if (studio.length >= 3 && parsed.compact.includes(studio)) {
    score += 0.15;
    reasons.push('Studio in file name');
  }

  if (parsed.date && candidate.date && candidate.date.startsWith(parsed.date)) {
    score += 0.2;
    reasons.push('Same date');
  }

  const performersFound = candidate.performers.filter((performer) => {
    const name = compact(performer.name);
    return name.length >= 4 && parsed.compact.includes(name);
  }).length;
  if (performersFound > 0) {
    score += Math.min(0.2, performersFound * 0.1);
    reasons.push(
      performersFound === 1
        ? 'Performer in file name'
        : 'Performers in file name',
    );
  }

  const clamped = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
  return {
    score: clamped,
    confidence: clamped >= 0.7 ? 'strong' : clamped >= 0.45 ? 'likely' : 'weak',
    reasons,
  };
}
