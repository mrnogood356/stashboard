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
}

export interface TasteEntry {
  catalogId: string;
  name: string;
  weight: number;
}

export interface TasteProfile {
  performers: TasteEntry[];
  studios: TasteEntry[];
}

/** A catalog scene to consider, with its performers when known. */
export interface Candidate {
  id: string;
  studioId: string | null;
  releaseDate: string | null;
  performers?: Array<{ id: string; name: string }>;
}

export interface SuggestionReason {
  /** "performer:<id>" or "studio:<id>", for weakening it after "Not interested". */
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
  }

  const byWeight = (left: TasteEntry, right: TasteEntry) =>
    right.weight - left.weight;
  return {
    performers: [...performers.values()].sort(byWeight),
    studios: [...studios.values()].sort(byWeight),
  };
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
