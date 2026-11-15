/**
 * The categories and studios you picked lately, kept in this browser, so a
 * list the catalog can't fill without a word typed still opens with your
 * usual ones. Storage can be off (a private window): then there are none.
 */
export interface RecentPick {
  id: string;
  name: string;
}

const LIMIT = 12;

export function readRecentPicks(key: string): RecentPick[] {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(key));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (pick): pick is RecentPick =>
              !!pick &&
              typeof (pick as RecentPick).id === 'string' &&
              typeof (pick as RecentPick).name === 'string',
          )
          .slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

/** Puts these first, newest at the front, dropping the oldest past the limit. */
export function rememberRecentPicks(key: string, picks: RecentPick[]): RecentPick[] {
  const fresh = picks.filter((pick) => pick.id && pick.name);
  const ids = new Set(fresh.map((pick) => pick.id));
  const next = [...fresh, ...readRecentPicks(key).filter((pick) => !ids.has(pick.id))].slice(
    0,
    LIMIT,
  );
  try {
    globalThis.localStorage?.setItem(storageKey(key), JSON.stringify(next));
  } catch {
    // Not kept this time; nothing else depends on it.
  }
  return next;
}

function storageKey(key: string): string {
  return `stashboard.recent.${key}`;
}
