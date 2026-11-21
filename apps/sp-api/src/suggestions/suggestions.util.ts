/** A scene from your library you've watched, rated or marked, as the profile needs it. */
export interface WatchedScene {
  playCount: number;
  oCounter: number;
  /** 0–100, or null when unrated. */
  rating100: number | null;
  /** ISO time of the last play, when Stash knows it. */
  lastPlayedAt: string | null;
  /** This catalog's id for each performer Stash links to it. */
  performers: Array<{
    catalogId: string | null;
    name: string;
    favorite: boolean;
  }>;
  studio: { catalogId: string | null; name: string; favorite: boolean } | null;
  /** Its tags' names in Stash. */
  tags?: string[];
}

export interface TasteEntry {
  catalogId: string;
  name: string;
  weight: number;
}

/** A category you watch, keyed by its lowercase name (Stash and the catalog share names). */
export interface TagTaste {
  key: string;
  name: string;
  weight: number;
}

/** Someone you don't watch yet who keeps turning up with someone you do. */
export interface CostarTaste {
  catalogId: string;
  name: string;
  /** The performer you watch they appear with most. */
  partner: string;
  weight: number;
}

export interface TasteProfile {
  performers: TasteEntry[];
  studios: TasteEntry[];
  tags?: TagTaste[];
  costars?: CostarTaste[];
}

/** A catalog scene to consider, with its performers when known. */
export interface Candidate {
  id: string;
  studioId: string | null;
  releaseDate: string | null;
  performers?: Array<{ id: string; name: string }>;
  tagNames?: string[];
}

export interface SuggestionReason {
  /** "performer:<id>", "studio:<id>", "tag:<name>" or "costar:<id>", for weakening it after "Not interested". */
  key: string;
  text: string;
}

export interface Ranked<T extends Candidate> {
  scene: T;
  score: number;
  reason: SuggestionReason;
}

/** A play this old counts half as much as one today. */
const HALF_LIFE_DAYS = 120;
/** Each "Not interested" for a reason makes it count this much less. */
const DISMISS_FACTOR = 0.8;
/** Released this recently: a small boost, new things first. */
const NEW_DAYS = 60;
/** Matching categories count, at most this many per scene. */
const TAGS_PER_SCENE = 3;
/** Categories this common in what you watch say little about your taste. */
const TAG_MIN_SCENES = 2;

/**
 * Who and what you watch most: each watched scene adds weight to its
 * performers and studio. Plays count once, O counts twice, a high rating
 * adds a little, favourites add more, and older plays count less.
 */
export function buildTasteProfile(
  scenes: WatchedScene[],
  now = Date.now(),
): TasteProfile {
  const performers = new Map<string, TasteEntry>();
  const studios = new Map<string, TasteEntry>();
  const add = (
    map: Map<string, TasteEntry>,
    catalogId: string | null,
    name: string,
    weight: number,
  ) => {
    if (!catalogId || weight <= 0) {
      return;
    }
    const entry = map.get(catalogId) ?? { catalogId, name, weight: 0 };
    entry.weight += weight;
    map.set(catalogId, entry);
  };

  // How many watched scenes each category is on, to tell telling ones from
  // ones on nearly everything.
  const tagScenes = new Map<string, number>();
  for (const scene of scenes) {
    for (const key of new Set((scene.tags ?? []).map(tagKey))) {
      tagScenes.set(key, (tagScenes.get(key) ?? 0) + 1);
    }
  }
  const tags = new Map<string, TagTaste>();

  for (const scene of scenes) {
    const rating =
      scene.rating100 === null ? 0 : Math.max(0, scene.rating100 / 20 - 2);
    const base = scene.playCount + 2 * scene.oCounter + rating;
    if (base <= 0) {
      continue;
    }
    const played = scene.lastPlayedAt ? Date.parse(scene.lastPlayedAt) : NaN;
    const days = Number.isFinite(played)
      ? Math.max(0, (now - played) / 86_400_000)
      : HALF_LIFE_DAYS;
    const recency = Math.max(0.25, 0.5 ** (days / HALF_LIFE_DAYS));
    const weight = base * recency;
    for (const performer of scene.performers) {
      add(
        performers,
        performer.catalogId,
        performer.name,
        weight + (performer.favorite ? 2 : 0),
      );
    }
    if (scene.studio) {
      add(
        studios,
        scene.studio.catalogId,
        scene.studio.name,
        weight + (scene.studio.favorite ? 2 : 0),
      );
    }
    const seenTags = new Set<string>();
    for (const name of scene.tags ?? []) {
      const key = tagKey(name);
      const count = tagScenes.get(key) ?? 0;
      if (!key || seenTags.has(key) || count < TAG_MIN_SCENES) {
        continue;
      }
      seenTags.add(key);
      // Rarer across what you watch, more telling: one on nearly every
      // scene (like "HD") says little about what you like.
      const telling = Math.log((scenes.length + 1) / count);
      const entry = tags.get(key) ?? { key, name, weight: 0 };
      entry.weight += weight * telling;
      tags.set(key, entry);
    }
  }

  const byWeight = (left: TasteEntry, right: TasteEntry) =>
    right.weight - left.weight;
  return {
    performers: [...performers.values()].sort(byWeight),
    studios: [...studios.values()].sort(byWeight),
    tags: [...tags.values()].sort((left, right) => right.weight - left.weight),
  };
}

export function tagKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Performers you don't watch yet who turn up most in the scenes of ones you
 * do, best first: a way to new people close to your taste. Each counts once
 * per scene, weighted by how much you watch the one they're with.
 */
export function findCostars(
  scenes: Candidate[],
  profile: TasteProfile,
  limit: number,
  minScenes = 2,
): CostarTaste[] {
  const watched = new Map(
    profile.performers.map((entry) => [entry.catalogId, entry]),
  );
  const found = new Map<
    string,
    { name: string; scenes: Set<string>; weight: number; partner: TasteEntry }
  >();
  for (const scene of scenes) {
    const people = scene.performers ?? [];
    const partner = people
      .map((performer) => watched.get(performer.id))
      .filter((entry): entry is TasteEntry => entry !== undefined)
      .sort((left, right) => right.weight - left.weight)[0];
    if (!partner) {
      continue;
    }
    for (const performer of people) {
      if (watched.has(performer.id)) {
        continue;
      }
      const entry = found.get(performer.id) ?? {
        name: performer.name,
        scenes: new Set<string>(),
        weight: 0,
        partner,
      };
      if (!entry.scenes.has(scene.id)) {
        entry.scenes.add(scene.id);
        entry.weight += partner.weight;
        if (partner.weight > entry.partner.weight) {
          entry.partner = partner;
        }
      }
      found.set(performer.id, entry);
    }
  }
  return [...found.entries()]
    .filter(([, entry]) => entry.scenes.size >= minScenes)
    .map(([catalogId, entry]) => ({
      catalogId,
      name: entry.name,
      partner: entry.partner.name,
      weight: entry.weight,
    }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
}

/**
 * Candidates in the order they're worth showing, each once, with the reason
 * that counted most. Performers you watch count most, then the studio; a
 * recent release gets a small boost. Reasons you've said "Not interested"
 * to count less each time.
 */
export function rankCandidates<T extends Candidate>(
  candidates: T[],
  profile: TasteProfile,
  dismissals: ReadonlyMap<string, number> = new Map(),
  now = Date.now(),
): Array<Ranked<T>> {
  const topPerformer = profile.performers[0]?.weight ?? 1;
  const topStudio = profile.studios[0]?.weight ?? 1;
  const topTag = profile.tags?.[0]?.weight ?? 1;
  const topCostar = profile.costars?.[0]?.weight ?? 1;
  const tags = new Map((profile.tags ?? []).map((entry) => [entry.key, entry]));
  const costars = new Map(
    (profile.costars ?? []).map((entry) => [entry.catalogId, entry]),
  );
  const performers = new Map(
    profile.performers.map((entry) => [entry.catalogId, entry]),
  );
  const studios = new Map(
    profile.studios.map((entry) => [entry.catalogId, entry]),
  );
  const damp = (key: string) => DISMISS_FACTOR ** (dismissals.get(key) ?? 0);

  const seen = new Set<string>();
  const ranked: Array<Ranked<T>> = [];
  for (const scene of candidates) {
    if (seen.has(scene.id)) {
      continue;
    }
    seen.add(scene.id);
    const parts: Array<{ score: number; reason: SuggestionReason }> = [];
    for (const performer of scene.performers ?? []) {
      const entry = performers.get(performer.id);
      if (entry) {
        const key = `performer:${entry.catalogId}`;
        parts.push({
          score: (entry.weight / topPerformer) * damp(key),
          reason: { key, text: `Because you watch ${entry.name}` },
        });
      }
    }
    const studio = scene.studioId ? studios.get(scene.studioId) : undefined;
    if (studio) {
      const key = `studio:${studio.catalogId}`;
      parts.push({
        score: 0.8 * (studio.weight / topStudio) * damp(key),
        reason: { key, text: `From ${studio.name}, a studio you watch a lot` },
      });
    }
    for (const performer of scene.performers ?? []) {
      const entry = costars.get(performer.id);
      if (entry) {
        const key = `costar:${entry.catalogId}`;
        parts.push({
          score: 0.6 * (entry.weight / topCostar) * damp(key),
          reason: {
            key,
            text: `With ${entry.name}, often seen with ${entry.partner}`,
          },
        });
      }
    }
    // Its categories you watch most: up to a few, together worth about
    // half a favourite performer.
    const matched = [
      ...new Map(
        (scene.tagNames ?? [])
          .map((name) => tags.get(tagKey(name)))
          .filter((entry): entry is TagTaste => entry !== undefined)
          .map((entry) => [entry.key, entry]),
      ).values(),
    ]
      .sort((left, right) => right.weight - left.weight)
      .slice(0, TAGS_PER_SCENE);
    if (matched.length > 0) {
      const key = `tag:${matched[0].key}`;
      const score =
        (0.5 / TAGS_PER_SCENE) *
        matched.reduce((sum, entry) => sum + entry.weight / topTag, 0) *
        damp(key);
      parts.push({
        score,
        reason: {
          key,
          text:
            matched.length > 1
              ? `${matched[0].name} and ${matched[1].name}, which you watch a lot`
              : `${matched[0].name}, which you watch a lot`,
        },
      });
    }
    if (parts.length === 0) {
      continue;
    }
    const released = scene.releaseDate ? Date.parse(scene.releaseDate) : NaN;
    const fresh =
      Number.isFinite(released) &&
      now - released <= NEW_DAYS * 86_400_000 &&
      released <= now
        ? 0.25
        : 0;
    const best = parts.reduce((top, part) =>
      part.score > top.score ? part : top,
    );
    ranked.push({
      scene,
      score: parts.reduce((sum, part) => sum + part.score, 0) + fresh,
      reason: best.reason,
    });
  }
  return ranked.sort((left, right) => right.score - left.score);
}

/**
 * Up to `count` entries, the strongest `keep` always and the rest drawn at
 * random by weight from the next `pool`, so a fresh pick reaches people and
 * studios you watch a little less too.
 */
export function pickSources(
  entries: TasteEntry[],
  keep: number,
  extra: number,
  pool: number,
  random: () => number = Math.random,
): TasteEntry[] {
  const kept = entries.slice(0, keep);
  const rest = entries.slice(keep, keep + pool);
  const drawn: TasteEntry[] = [];
  while (drawn.length < extra && rest.length > 0) {
    const total = rest.reduce(
      (sum, entry) => sum + Math.max(entry.weight, 0.01),
      0,
    );
    let roll = random() * total;
    let index = 0;
    for (; index < rest.length - 1; index++) {
      roll -= Math.max(rest[index].weight, 0.01);
      if (roll <= 0) {
        break;
      }
    }
    drawn.push(rest.splice(index, 1)[0]);
  }
  return [...kept, ...drawn];
}

/**
 * A fresh order for a shuffle: each score nudged at random, and scenes just
 * shown pushed well down, so the next screenful is mostly new.
 */
export function reshuffle<T extends Candidate>(
  ranked: Array<Ranked<T>>,
  recentlyShown: ReadonlySet<string>,
  random: () => number = Math.random,
): Array<Ranked<T>> {
  return ranked
    .map((entry) => ({
      entry,
      score:
        entry.score *
        (0.6 + random() * 0.8) *
        (recentlyShown.has(entry.scene.id) ? 0.25 : 1),
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ entry }) => entry);
}

/**
 * The same order, spread out: no reason and no studio more than `perWindow`
 * times in any `window` in a row, so a screenful isn't one studio's
 * newest. Scores still lead; a scene held back comes in as soon as it fits.
 */
export function diversify<T extends Candidate>(
  ranked: Array<Ranked<T>>,
  window = 6,
  perWindow = 2,
): Array<Ranked<T>> {
  const rest = [...ranked];
  const out: Array<Ranked<T>> = [];
  while (rest.length > 0) {
    const recent = out.slice(-window + 1);
    const fits = (entry: Ranked<T>) =>
      recent.filter((other) => other.reason.key === entry.reason.key).length <
        perWindow &&
      (!entry.scene.studioId ||
        recent.filter((other) => other.scene.studioId === entry.scene.studioId)
          .length < perWindow);
    const index = rest.findIndex(fits);
    out.push(...rest.splice(index === -1 ? 0 : index, 1));
  }
  return out;
}
