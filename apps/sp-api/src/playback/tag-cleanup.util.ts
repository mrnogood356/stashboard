import type { StashTagSummary } from '../providers/stash/stash.types';

export interface SimilarTagGroup {
  /** The tag to keep: the one most scenes use. */
  keepId: string;
  tags: StashTagSummary[];
}

/**
 * The same tag written more than one way: "Blonde", "blonde", "Blondes",
 * "Big-Tits" and "big tits", or a name another tag lists as an alias. Only
 * spelling, case, spacing and a plural ending; "Blonde" and "Blonde hair"
 * stay apart, since they can mean different things.
 */
export function groupSimilarTags(
  tags: StashTagSummary[],
  keyOf: (name: string) => string = tagKey,
): SimilarTagGroup[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) {
      parent.set(right, left);
    }
  };

  const byKey = new Map<string, string>();
  for (const tag of tags) {
    parent.set(tag.id, tag.id);
  }
  for (const tag of tags) {
    for (const name of [tag.name, ...tag.aliases]) {
      const key = keyOf(name);
      if (!key) {
        continue;
      }
      const seen = byKey.get(key);
      if (seen) {
        join(seen, tag.id);
      } else {
        byKey.set(key, tag.id);
      }
    }
  }

  const groups = new Map<string, StashTagSummary[]>();
  for (const tag of tags) {
    const root = find(tag.id);
    groups.set(root, [...(groups.get(root) ?? []), tag]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort(
        (a, b) => b.sceneCount - a.sceneCount || a.name.localeCompare(b.name),
      );
      return { keepId: sorted[0].id, tags: sorted };
    })
    .sort((a, b) => total(b) - total(a));
}

function total(group: SimilarTagGroup): number {
  return group.tags.reduce((sum, tag) => sum + tag.sceneCount, 0);
}

/** Lower case, letters and digits only, with a plural ending dropped. */
export function tagKey(name: string): string {
  const flat = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  if (flat.length <= 3) {
    return flat;
  }
  if (flat.endsWith('ies')) {
    return `${flat.slice(0, -3)}y`;
  }
  if (/(ss|sh|ch|x)es$/.test(flat)) {
    return flat.slice(0, -2);
  }
  if (flat.endsWith('s') && !flat.endsWith('ss')) {
    return flat.slice(0, -1);
  }
  return flat;
}

/**
 * For performer and studio names: case, accents, spacing and punctuation
 * only, no plural ending ("Alexis" isn't "Alexi").
 */
export function nameKey(name: string): string {
  // Latin accents go (é → e); other scripts keep their marks, so が and か
  // stay apart, and their letters stay in.
  return name
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/**
 * Two performers or studios that can't be one: linked to different entries
 * on the same catalog (StashDB says they're two), or told apart in Stash
 * (different disambiguations, or for studios different parents).
 */
export function cannotBeOne(
  a: { note: string | null; links: string[] },
  b: { note: string | null; links: string[] },
): boolean {
  // Every id on each catalog: one entry can carry two links to the same one.
  const ids = (links: string[]) => {
    const byEndpoint = new Map<string, Set<string>>();
    for (const link of links) {
      const cut = link.lastIndexOf('|');
      const endpoint = link.slice(0, cut);
      const set = byEndpoint.get(endpoint) ?? new Set<string>();
      set.add(link.slice(cut + 1));
      byEndpoint.set(endpoint, set);
    }
    return byEndpoint;
  };
  const left = ids(a.links);
  for (const [endpoint, right] of ids(b.links)) {
    const other = left.get(endpoint);
    if (
      other &&
      (other.size !== right.size || [...right].some((id) => !other.has(id)))
    ) {
      return true;
    }
  }
  const noteA = nameKey(a.note ?? '');
  const noteB = nameKey(b.note ?? '');
  return !!noteA && !!noteB && noteA !== noteB;
}

/**
 * A group of same-named entries, split so nothing in a set can't be one with
 * the rest: most scenes first, each joining the first set it fits. Only sets
 * of two or more are left, with the one with the most scenes to keep.
 */
export function splitUnmergeable<
  T extends {
    id: string;
    sceneCount: number;
    note: string | null;
    links: string[];
  },
>(items: T[]): Array<{ keepId: string; items: T[] }> {
  const sets: T[][] = [];
  for (const item of [...items].sort((a, b) => b.sceneCount - a.sceneCount)) {
    const home = sets.find((set) =>
      set.every((other) => !cannotBeOne(item, other)),
    );
    if (home) {
      home.push(item);
    } else {
      sets.push([item]);
    }
  }
  return sets
    .filter((set) => set.length > 1)
    .map((set) => ({ keepId: set[0].id, items: set }));
}
