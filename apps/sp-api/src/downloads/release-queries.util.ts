import type { ReleaseMatchScene } from '../requests/release-match.util';

/** Indexers search badly with long titles; the first few words do better. */
const MAX_TITLE_WORDS = 6;
const MAX_QUERIES = 4;

/**
 * What to type into Prowlarr's search for a scene. Release names usually
 * carry the studio (on FansDB, the creator) and the date as yy.mm.dd, or the
 * studio or a performer next to the title, so a couple of those are tried:
 *
 *   "Sunny Studio 24.03.15", "Sunny Studio Beach Day", "Jane Doe Beach Day",
 *   "Jane Doe 24.03.15"
 *
 * Duplicates are dropped. With too little to go on, the title alone is used.
 */
export function buildReleaseQueries(scene: ReleaseMatchScene): string[] {
  const studio = cleanName(scene.studio);
  const title = shortTitle(scene.title);
  const date = shortDate(scene.releaseDate);
  const performer = scene.performers.map(cleanName).find(Boolean) ?? '';

  const candidates = [
    studio && date ? `${studio} ${date}` : '',
    studio && title ? `${studio} ${title}` : '',
    performer && title ? `${performer} ${title}` : '',
    performer && date ? `${performer} ${date}` : '',
  ];
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const query of candidates) {
    const key = query.toLowerCase();
    if (query && !seen.has(key)) {
      seen.add(key);
      queries.push(query);
    }
  }
  if (queries.length === 0) {
    const fallback = title || studio || performer;
    return fallback ? [fallback] : [];
  }
  return queries.slice(0, MAX_QUERIES);
}

/** "2024-03-15" → "24.03.15", the way most release names write it. */
export function shortDate(value: string | null): string {
  const match = /^\d{2}(\d{2})-(\d{2})-(\d{2})/.exec(value?.trim() ?? '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

/**
 * Letters and digits only, with anything in brackets dropped:
 * "Jane Doe (OnlyFans)" → "Jane Doe".
 */
function cleanName(value: string | null): string {
  return (value ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function shortTitle(value: string | null): string {
  return cleanName(value).split(' ').slice(0, MAX_TITLE_WORDS).join(' ');
}
