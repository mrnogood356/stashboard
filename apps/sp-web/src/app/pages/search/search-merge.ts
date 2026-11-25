import { PerformerFeedItem, StudioFeedItem } from '../../core/api/discover.types';
import { LocalSearchResults } from '../../core/api/local-library.service';

/** A performer or studio from one source: your library or the catalog. */
export interface PersonResult {
  key: string;
  kind: 'performer' | 'studio';
  name: string;
  imageUrl: string | null;
  /** Its page: on the catalog (StashDB/FansDB) for a catalog entry, else in your library. */
  link: string[];
  /** In your library, with this many scenes there. */
  libraryScenes: number | null;
  /** On the catalog, with this many scenes there (performers only). */
  catalogScenes: number | null;
  favorite: boolean;
  /** Its name is exactly what you searched for. */
  exact: boolean;
}

type LocalPerformer = LocalSearchResults['performers'][number];
type LocalStudio = LocalSearchResults['studios'][number];

/** Names compared without case, accents, spaces or punctuation. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Catalog performers, in the catalog's order (an exact name first), each
 * marked with how many scenes you have of them: matched to your library by
 * its catalog id, or failing that the same name.
 */
export function catalogPerformers(
  local: LocalPerformer[],
  catalog: PerformerFeedItem[],
  query: string,
): PersonResult[] {
  const { matches } = matchLocal(local, catalog);
  return ranked(
    catalog.map((performer, index) => {
      const mine = matches[index];
      return {
        key: `catalog:${performer.id}`,
        kind: 'performer' as const,
        name: performer.name,
        imageUrl: performer.cardImageUrl ?? performer.imageUrl ?? mine?.imageUrl ?? null,
        link: ['/performer', performer.id],
        libraryScenes: mine ? mine.sceneCount : null,
        catalogScenes: performer.sceneCount,
        favorite: performer.isFavorite || (mine?.favorite ?? false),
        exact: false,
      };
    }),
    query,
  );
}

/** The same for catalog studios. */
export function catalogStudios(
  local: LocalStudio[],
  catalog: StudioFeedItem[],
  query: string,
): PersonResult[] {
  const { matches } = matchLocal(local, catalog);
  return ranked(
    catalog.map((studio, index) => {
      const mine = matches[index];
      return {
        key: `catalog:${studio.id}`,
        kind: 'studio' as const,
        name: studio.name,
        imageUrl: studio.cardImageUrl ?? studio.imageUrl ?? mine?.imageUrl ?? null,
        link: ['/studio', studio.id],
        libraryScenes: mine ? mine.sceneCount : null,
        catalogScenes: null,
        favorite: studio.isFavorite,
        exact: false,
      };
    }),
    query,
  );
}

/** Performers or studios in your library, each opening its library page; an exact name first. */
export function libraryPeople(
  local: Array<LocalPerformer | LocalStudio>,
  kind: 'performer' | 'studio',
  query: string,
): PersonResult[] {
  return ranked(
    local.map((entry) => ({
      key: `library:${entry.id}`,
      kind,
      name: entry.name,
      imageUrl: entry.imageUrl,
      link: [kind === 'performer' ? '/library/performer' : '/library/studio', entry.id],
      libraryScenes: entry.sceneCount,
      catalogScenes: null,
      favorite: 'favorite' in entry ? entry.favorite : false,
      exact: false,
    })),
    query,
  );
}

/**
 * The library entry for each catalog entry, in catalog order: first every
 * match by catalog id, then the rest by name, so a namesake can't take the
 * entry that's linked to someone else.
 */
function matchLocal<T extends { id: string; name: string; catalogIds?: string[] }>(
  local: T[],
  catalog: Array<{ id: string; name: string }>,
): { matches: Array<T | null>; used: Set<string> } {
  const used = new Set<string>();
  const matches: Array<T | null> = catalog.map(() => null);
  const claim = (index: number, entry: T | undefined) => {
    if (entry) {
      used.add(entry.id);
      matches[index] = entry;
    }
  };
  catalog.forEach((item, index) =>
    claim(
      index,
      local.find((entry) => !used.has(entry.id) && entry.catalogIds?.includes(item.id)),
    ),
  );
  catalog.forEach((item, index) => {
    if (!matches[index]) {
      const key = nameKey(item.name);
      claim(
        index,
        local.find((entry) => !used.has(entry.id) && nameKey(entry.name) === key),
      );
    }
  });
  return { matches, used };
}

/** An exact name first; otherwise as the source ranked them. */
function ranked(results: PersonResult[], query: string): PersonResult[] {
  const wanted = nameKey(query);
  return results
    .map((result, index) => ({
      result: { ...result, exact: wanted.length > 0 && nameKey(result.name) === wanted },
      index,
    }))
    .sort(
      (left, right) =>
        Number(right.result.exact) - Number(left.result.exact) || left.index - right.index,
    )
    .map((entry) => entry.result);
}

/**
 * Names in your library the catalog search didn't find, to ask it for by
 * their own name: "blackedraw" finds Blacked Raw in your library, but the
 * catalog only finds it as "Blacked Raw". At most `limit`, ones you have
 * the most of first.
 */
export function missedNames<
  T extends { id: string; name: string; sceneCount: number; catalogIds?: string[] },
>(local: T[], catalog: Array<{ id: string; name: string }>, query: string, limit = 2): string[] {
  const { used } = matchLocal(local, catalog);
  const asked = query.trim().toLowerCase();
  const names = local
    .filter((entry) => !used.has(entry.id) && entry.name.trim().toLowerCase() !== asked)
    .sort((left, right) => right.sceneCount - left.sceneCount)
    .map((entry) => entry.name.trim());
  return [...new Set(names)].slice(0, limit);
}

/**
 * Catalog entries from asking by a library name, kept when they're the
 * same one (linked by id, or the same name) and not already listed.
 */
export function addFound<T extends { id: string; name: string }>(
  listed: T[],
  found: T[],
  local: Array<{ name: string; catalogIds?: string[] }>,
): T[] {
  const ids = new Set(listed.map((entry) => entry.id));
  const linked = new Set(local.flatMap((entry) => entry.catalogIds ?? []));
  const names = new Set(local.map((entry) => nameKey(entry.name)));
  const extra = found.filter((entry) => {
    if (ids.has(entry.id) || !(linked.has(entry.id) || names.has(nameKey(entry.name)))) {
      return false;
    }
    ids.add(entry.id);
    return true;
  });
  return [...listed, ...extra];
}
