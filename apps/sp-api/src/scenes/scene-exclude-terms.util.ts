const MAX_EXCLUDE_TERMS = 25;
const MAX_TERM_LENGTH = 60;

/**
 * "trans, transgender" or "trans transgender" -> ['trans', 'transgender'].
 * A leading "-" is dropped, so "-trans" works here too.
 */
export function parseExcludeTerms(
  values: readonly string[],
  limit = MAX_EXCLUDE_TERMS,
): string[] {
  const terms = values
    .flatMap((value) => value.split(/[\s,]+/))
    .map((term) => term.replace(/^-+/, '').trim().toLowerCase())
    .filter((term) => term.length > 0)
    .map((term) => term.slice(0, MAX_TERM_LENGTH));

  return [...new Set(terms)].slice(0, limit);
}

/** Pulls "-word" tokens out of a text search: "anal -trans" -> text "anal", excluded ['trans']. */
export function splitNegatedTerms(text: string | undefined): {
  text: string;
  excluded: string[];
} {
  const kept: string[] = [];
  const negated: string[] = [];
  for (const token of (text ?? '').split(/\s+/)) {
    if (token.length > 1 && token.startsWith('-')) {
      negated.push(token);
    } else if (token.length > 0) {
      kept.push(token);
    }
  }

  return { text: kept.join(' '), excluded: parseExcludeTerms(negated) };
}

/**
 * Whole-word, case-insensitive matchers: "trans" matches "Trans" and
 * "trans-woman" but not "transfer".
 */
export function buildExcludeMatchers(terms: readonly string[]): RegExp[] {
  return terms.map(
    (term) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
        'iu',
      ),
  );
}

export function matchesAnyExcludeTerm(
  fields: ReadonlyArray<string | null | undefined>,
  matchers: readonly RegExp[],
): boolean {
  if (matchers.length === 0) {
    return false;
  }

  return fields.some(
    (field) => !!field && matchers.some((matcher) => matcher.test(field)),
  );
}

/** What a catalog scene card carries that exclude rules look at. */
export interface ExcludableScene {
  title: string | null;
  details: string | null;
  studioId: string | null;
  studioName: string | null;
  tagIds?: readonly string[];
  tagNames?: readonly string[];
  performers?: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Words, tags, studios and performers to leave out of a list. Tags and
 * studios also match by (lowercase) name, so a list saved while browsing
 * StashDB still works on FansDB, where the ids differ. Performers match by id
 * only: two different people can share a name.
 */
export interface SceneExcludeRules {
  matchers: readonly RegExp[];
  tagIds: ReadonlySet<string>;
  studioIds: ReadonlySet<string>;
  performerIds: ReadonlySet<string>;
  tagNames: ReadonlySet<string>;
  studioNames: ReadonlySet<string>;
}

export const EMPTY_EXCLUDE_RULES: SceneExcludeRules = {
  matchers: [],
  tagIds: new Set(),
  studioIds: new Set(),
  performerIds: new Set(),
  tagNames: new Set(),
  studioNames: new Set(),
};

export function hasExcludeRules(rules: SceneExcludeRules): boolean {
  return (
    rules.matchers.length > 0 ||
    rules.tagIds.size > 0 ||
    rules.studioIds.size > 0 ||
    rules.performerIds.size > 0 ||
    rules.tagNames.size > 0 ||
    rules.studioNames.size > 0
  );
}

/** True when the rules look at tags or performers, which lists fetch only on request. */
export function needsSceneTags(rules: SceneExcludeRules): boolean {
  return (
    rules.matchers.length > 0 ||
    rules.tagIds.size > 0 ||
    rules.tagNames.size > 0 ||
    rules.performerIds.size > 0
  );
}

/**
 * The same rules without the studios, tags or performer a list was asked
 * for: a studio's own page, or a filter on a hidden tag, shows them anyway.
 */
export function exceptRequested(
  rules: SceneExcludeRules,
  requested: {
    studioIds?: readonly string[];
    tagIds?: readonly string[];
    performerIds?: readonly string[];
  },
): SceneExcludeRules {
  const without = (set: ReadonlySet<string>, ids?: readonly string[]) =>
    ids && ids.some((id) => set.has(id))
      ? new Set([...set].filter((entry) => !ids.includes(entry)))
      : set;
  const studioIds = without(rules.studioIds, requested.studioIds);
  const tagIds = without(rules.tagIds, requested.tagIds);
  const performerIds = without(rules.performerIds, requested.performerIds);
  if (
    studioIds === rules.studioIds &&
    tagIds === rules.tagIds &&
    performerIds === rules.performerIds
  ) {
    return rules;
  }
  return { ...rules, studioIds, tagIds, performerIds };
}

const lower = (value: string | null | undefined) =>
  (value ?? '').trim().toLowerCase();

/**
 * True when the scene's title, details, studio or tags contain one of the
 * words, or it has one of the tags or performers, or comes from one of the
 * studios.
 */
export function isSceneExcluded(
  scene: ExcludableScene,
  rules: SceneExcludeRules,
): boolean {
  if (scene.studioId && rules.studioIds.has(scene.studioId)) {
    return true;
  }
  if (scene.studioName && rules.studioNames.has(lower(scene.studioName))) {
    return true;
  }
  if (scene.tagIds?.some((tagId) => rules.tagIds.has(tagId))) {
    return true;
  }
  if (
    rules.tagNames.size > 0 &&
    scene.tagNames?.some((name) => rules.tagNames.has(lower(name)))
  ) {
    return true;
  }
  if (
    scene.performers?.some((performer) => rules.performerIds.has(performer.id))
  ) {
    return true;
  }
  return matchesAnyExcludeTerm(
    [scene.title, scene.details, scene.studioName, ...(scene.tagNames ?? [])],
    rules.matchers,
  );
}

/**
 * Splits a list into the scenes to show and how many the hidden-content
 * rules took out. Scenes the search's own exclude words drop aren't counted:
 * you asked for those, so there's nothing to "show anyway".
 */
export function applyExcludeRules<T extends ExcludableScene>(
  scenes: readonly T[],
  search: SceneExcludeRules,
  hidden: SceneExcludeRules,
): { scenes: T[]; hidden: number } {
  const kept: T[] = [];
  let hiddenCount = 0;
  for (const scene of scenes) {
    if (isSceneExcluded(scene, search)) {
      continue;
    }
    if (isSceneExcluded(scene, hidden)) {
      hiddenCount += 1;
      continue;
    }
    kept.push(scene);
  }
  return { scenes: kept, hidden: hiddenCount };
}
