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
export function groupSimilarTags(tags: StashTagSummary[]): SimilarTagGroup[] {
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
      const key = tagKey(name);
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
