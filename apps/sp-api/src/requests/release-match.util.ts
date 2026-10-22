/** What we know about the scene, to check a release's name against. */
export interface ReleaseMatchScene {
  title: string | null;
  studio: string | null;
  /** YYYY-MM-DD. */
  releaseDate: string | null;
  performers: string[];
}

/**
 * How well a release's name fits the scene. `strong`: two or more of studio,
 * date, a performer and the title. `partial`: one of them (studio alone
 * doesn't count, every scene from that studio has it). `weak`: none, or the
 * name has a different date, so it's almost surely another scene.
 */
export type ReleaseMatchStrength = 'strong' | 'partial' | 'weak';

export interface ReleaseMatch {
  strength: ReleaseMatchStrength;
  /** What the name has in common with the scene, e.g. "studio", "date". */
  matched: string[];
}

const TITLE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'her',
  'his',
  'she',
  'you',
  'are',
  'was',
  'its',
  'part',
]);
const STRENGTH_RANK: Record<ReleaseMatchStrength, number> = {
  strong: 0,
  partial: 1,
  weak: 2,
};

/** Null when we know nothing about the scene to compare with. */
export function matchRelease(
  releaseTitle: string,
  scene: ReleaseMatchScene,
): ReleaseMatch | null {
  const studio = compact(scene.studio ?? '');
  const date = parseDate(scene.releaseDate);
  const performers = scene.performers
    .map((name) => words(name).filter((word) => word.length >= 2))
    .filter((parts) => parts.length > 0);
  const titleWords = [
    ...new Set(
      words(scene.title ?? '').filter(
        (word) => word.length >= 3 && !TITLE_STOPWORDS.has(word),
      ),
    ),
  ];
  if (!studio && !date && performers.length === 0 && titleWords.length === 0) {
    return null;
  }

  const releaseWords = words(releaseTitle);
  const releaseWordSet = new Set(releaseWords);
  const releaseText = ` ${releaseWords.join(' ')} `;
  const releaseCompact = releaseWords.join('');
  const matched: string[] = [];

  const studioMatch = studio.length >= 3 && releaseCompact.includes(studio);
  if (studioMatch) {
    matched.push('studio');
  }

  const dates = datesIn(releaseWords);
  const dateMatch =
    date !== null && dates.some((found) => sameDate(found, date));
  const dateConflict = date !== null && dates.length > 0 && !dateMatch;
  if (dateMatch) {
    matched.push('date');
  }

  const performerHits = performers.filter(
    (parts) =>
      releaseText.includes(` ${parts.join(' ')} `) ||
      (parts.join('').length >= 6 && releaseCompact.includes(parts.join(''))),
  ).length;
  if (performerHits > 0) {
    matched.push(performerHits === 1 ? 'performer' : 'performers');
  }

  const titleHits = titleWords.filter((word) =>
    releaseWordSet.has(word),
  ).length;
  const titleMatch =
    titleWords.length > 0 &&
    titleHits / titleWords.length >= (titleWords.length <= 2 ? 1 : 0.6);
  if (titleMatch) {
    matched.push('title');
  }

  const signals = [studioMatch, dateMatch, performerHits > 0, titleMatch];
  const count = signals.filter(Boolean).length;
  const strength: ReleaseMatchStrength = dateConflict
    ? 'weak'
    : count >= 2
      ? 'strong'
      : count === 1 && !studioMatch
        ? 'partial'
        : 'weak';

  return { strength, matched };
}

/** Best match first; releases we couldn't check go with the strong ones. */
export function compareReleaseMatch(
  left: ReleaseMatch | null,
  right: ReleaseMatch | null,
): number {
  const rank = (match: ReleaseMatch | null) =>
    match ? STRENGTH_RANK[match.strength] : 0;
  return rank(left) - rank(right);
}

/** Lowercase words, accents dropped; dots, dashes and underscores split. */
function words(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compact(value: string): string {
  return words(value).join('');
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseDate(value: string | null): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value?.trim() ?? '');
  return match
    ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
    : null;
}

/**
 * Dates in a release name: "24.03.15", "2024.03.15", "15.03.2024" or
 * "20240315". Two-digit years are taken as 20xx.
 */
function datesIn(releaseWords: string[]): DateParts[] {
  const found: DateParts[] = [];
  const add = (year: number, month: number, day: number) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      found.push({ year: year < 100 ? 2000 + year : year, month, day });
    }
  };
  for (let i = 0; i < releaseWords.length; i += 1) {
    const [a, b, c] = releaseWords.slice(i, i + 3);
    if (/^\d{8}$/.test(a)) {
      add(Number(a.slice(0, 4)), Number(a.slice(4, 6)), Number(a.slice(6)));
    }
    if (!b || !c || !/^\d{2}$/.test(b)) {
      continue;
    }
    if (/^(\d{2}|\d{4})$/.test(a) && /^\d{2}$/.test(c)) {
      add(Number(a), Number(b), Number(c));
    } else if (/^\d{2}$/.test(a) && /^\d{4}$/.test(c)) {
      add(Number(c), Number(b), Number(a));
    }
  }
  return found;
}

function sameDate(left: DateParts, right: DateParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day
  );
}
