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

/** Why two performers or studios are suggested as one, strongest first. */
export type MergeReason = 'catalog' | 'name' | 'alias';

/**
 * How an entry is tied into its group: its best match there, and whether it
 * reaches the one kept through the same catalog entry or the same name
 * (sure) rather than only through an alias.
 */
export interface MergeMatch {
  reason: MergeReason;
  with: string;
  sure: boolean;
}

interface MergeItem {
  id: string;
  name: string;
  aliases: string[];
  sceneCount: number;
  note: string | null;
  links: string[];
}

/** Two or more words: a full name, not a first name many people share. */
function isFullName(name: string): boolean {
  return (
    name
      .trim()
      .split(/[\s._-]+/)
      .filter(Boolean).length >= 2
  );
}

/**
 * Performers or studios that look like one entered twice, for Merge. Only
 * three things count:
 *   - linked to the same StashDB/FansDB entry;
 *   - the same name (case, accents, spacing and punctuation aside);
 *   - one's full name (two words or more) listed as the other's alias.
 * Two aliases that match never do: lots of people share "Melissa" or
 * "Julia". Each item says why it's there and with whom, and anything that
 * can't be one with the rest (cannotBeOne) is split off.
 */
export function groupMergeCandidates<T extends MergeItem>(
  items: T[],
): Array<{
  keepId: string;
  items: Array<T & { match: MergeMatch }>;
}> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const edges = new Map<
    string,
    Array<{ other: string; reason: MergeReason }>
  >();
  const link = (a: string, b: string, reason: MergeReason) => {
    if (a === b) {
      return;
    }
    edges.set(a, [...(edges.get(a) ?? []), { other: b, reason }]);
    edges.set(b, [...(edges.get(b) ?? []), { other: a, reason }]);
  };
  const index = (keyOf: (item: T) => string[]) => {
    const map = new Map<string, string[]>();
    for (const item of items) {
      for (const key of new Set(keyOf(item))) {
        if (key) {
          map.set(key, [...(map.get(key) ?? []), item.id]);
        }
      }
    }
    return map;
  };
  const byLink = index((item) => item.links);
  const byName = index((item) => [nameKey(item.name)]);
  for (const ids of byLink.values()) {
    ids.slice(1).forEach((id) => link(ids[0], id, 'catalog'));
  }
  for (const ids of byName.values()) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        link(ids[i], ids[j], 'name');
      }
    }
  }
  for (const item of items) {
    for (const alias of item.aliases) {
      if (!isFullName(alias)) {
        continue;
      }
      for (const other of byName.get(nameKey(alias)) ?? []) {
        link(item.id, other, 'alias');
      }
    }
  }

  // Connected entries, then split where two can't be one.
  const seen = new Set<string>();
  const result: Array<{
    keepId: string;
    items: Array<T & { match: MergeMatch }>;
  }> = [];
  const rank: Record<MergeReason, number> = { catalog: 0, name: 1, alias: 2 };
  /** Connected pieces of these entries, by their matches among themselves; most scenes first. */
  const connected = (entries: T[]): T[][] => {
    const inSet = new Set(entries.map((entry) => entry.id));
    const placed = new Set<string>();
    const pieces: T[][] = [];
    for (const start of entries) {
      if (placed.has(start.id)) {
        continue;
      }
      const piece: T[] = [];
      const queue = [start.id];
      placed.add(start.id);
      while (queue.length > 0) {
        const id = queue.shift()!;
        piece.push(byId.get(id)!);
        for (const { other } of edges.get(id) ?? []) {
          if (inSet.has(other) && !placed.has(other)) {
            placed.add(other);
            queue.push(other);
          }
        }
      }
      pieces.push(piece.sort((a, b) => b.sceneCount - a.sceneCount));
    }
    return pieces;
  };
  /** A piece with each entry's best match, and which reach the kept one surely. */
  const annotate = (piece: T[]) => {
    if (piece.length < 2) {
      return null;
    }
    const inSet = new Set(piece.map((entry) => entry.id));
    const keepId = piece[0].id;
    const sure = new Set([keepId]);
    const queue = [keepId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const { other, reason } of edges.get(id) ?? []) {
        if (reason !== 'alias' && inSet.has(other) && !sure.has(other)) {
          sure.add(other);
          queue.push(other);
        }
      }
    }
    const items = piece.map((entry) => {
      const best = (edges.get(entry.id) ?? [])
        .filter((edge) => inSet.has(edge.other))
        .sort((a, b) => rank[a.reason] - rank[b.reason])[0];
      return {
        ...entry,
        match: {
          reason: best.reason,
          with: byId.get(best.other)!.name,
          sure: sure.has(entry.id),
        },
      };
    });
    return { keepId, items };
  };
  for (const item of items) {
    if (seen.has(item.id) || !edges.has(item.id)) {
      continue;
    }
    const component: T[] = [];
    const queue = [item.id];
    seen.add(item.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      component.push(byId.get(id)!);
      for (const { other } of edges.get(id) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          queue.push(other);
        }
      }
    }
    for (const set of splitUnmergeable(component)) {
      // Taking out entries that can't be one can leave pieces no longer
      // joined to each other: each is a group of its own.
      for (const piece of connected(set.items)) {
        const group = annotate(piece);
        if (group) {
          result.push(group);
        }
      }
    }
  }
  return result.sort(
    (a, b) =>
      b.items.reduce((sum, entry) => sum + entry.sceneCount, 0) -
      a.items.reduce((sum, entry) => sum + entry.sceneCount, 0),
  );
}
