import {
  PerformerFeedItem,
  SceneExplorerItem,
  StudioFeedItem,
} from '../../core/api/discover.types';
import { LibrarySceneItem } from '../../core/api/library.types';
import { LocalSearchResults } from '../../core/api/local-library.service';

/** A performer or studio, once, whether it's in your library, the catalog or both. */
export interface PersonResult {
  key: string;
  kind: 'performer' | 'studio';
  name: string;
  imageUrl: string | null;
  /** The catalog page (StashDB/FansDB) when it's on the catalog, else your library's. */
  link: string[];
  /** In your library, with this many scenes there. */
  libraryScenes: number | null;
  /** On the catalog, with this many scenes there (performers only). */
  catalogScenes: number | null;
  favorite: boolean;
  /** Its name is exactly what you searched for. */
  exact: boolean;
}

/** A scene once: the catalog's card (marked when you own it), or your library's when the catalog doesn't have it. */
export type SceneResult =
  { from: 'catalog'; item: SceneExplorerItem } | { from: 'library'; item: LibrarySceneItem };

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
 * Library and catalog performers as one list: someone you have is matched
 * to their catalog entry by its id (or, failing that, the same name) and
 * listed once. An exact name match comes first, then ones you have.
 */
export function mergePerformers(
  local: LocalPerformer[],
  catalog: PerformerFeedItem[],
  query: string,
): PersonResult[] {
  const { matches, used } = matchLocal(local, catalog);
  const results: PersonResult[] = catalog.map((performer, index) => {
    const mine = matches[index];
    return {
      key: `catalog:${performer.id}`,
      kind: 'performer',
      name: performer.name,
      imageUrl: performer.cardImageUrl ?? performer.imageUrl ?? mine?.imageUrl ?? null,
      link: ['/performer', performer.id],
      libraryScenes: mine ? mine.sceneCount : null,
      catalogScenes: performer.sceneCount,
      favorite: performer.isFavorite || (mine?.favorite ?? false),
      exact: false,
    };
  });
  for (const performer of local) {
    if (!used.has(performer.id)) {
      results.push({
        key: `library:${performer.id}`,
        kind: 'performer',
        name: performer.name,
        imageUrl: performer.imageUrl,
        link: ['/library/performer', performer.id],
        libraryScenes: performer.sceneCount,
        catalogScenes: null,
        favorite: performer.favorite,
        exact: false,
      });
    }
  }
  return ranked(results, query);
}

/** The same for studios. */
export function mergeStudios(
  local: LocalStudio[],
  catalog: StudioFeedItem[],
  query: string,
): PersonResult[] {
  const { matches, used } = matchLocal(local, catalog);
  const results: PersonResult[] = catalog.map((studio, index) => {
    const mine = matches[index];
    return {
      key: `catalog:${studio.id}`,
      kind: 'studio',
      name: studio.name,
      imageUrl: studio.cardImageUrl ?? studio.imageUrl ?? mine?.imageUrl ?? null,
      link: ['/studio', studio.id],
      libraryScenes: mine ? mine.sceneCount : null,
      catalogScenes: null,
      favorite: studio.isFavorite,
      exact: false,
    };
  });
  for (const studio of local) {
    if (!used.has(studio.id)) {
      results.push({
        key: `library:${studio.id}`,
        kind: 'studio',
        name: studio.name,
        imageUrl: studio.imageUrl,
        link: ['/library/studio', studio.id],
        libraryScenes: studio.sceneCount,
        catalogScenes: null,
        favorite: false,
        exact: false,
      });
    }
  }
  return ranked(results, query);
}

/**
 * Catalog and library scenes as one list: a library scene the catalog
 * results already have (you own it) isn't listed again; the rest of your
 * library's matches follow the catalog's.
 */
export function mergeScenes(
  catalog: SceneExplorerItem[],
  library: LibrarySceneItem[],
): SceneResult[] {
  const catalogIds = new Set(catalog.map((scene) => scene.id));
  const localIds = new Set(
    catalog.flatMap((scene) => (scene.localSceneId ? [scene.localSceneId] : [])),
  );
  return [
    ...catalog.map((item): SceneResult => ({ from: 'catalog', item })),
    ...library
      .filter(
        (item) =>
          !localIds.has(item.id) &&
          !(item.activeCatalogSceneId && catalogIds.has(item.activeCatalogSceneId)),
      )
      .map((item): SceneResult => ({ from: 'library', item })),
  ];
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

/** Exact name first, then ones in your library; otherwise as the sources ranked them. */
function ranked(results: PersonResult[], query: string): PersonResult[] {
  const wanted = nameKey(query);
  return results
    .map((result, index) => ({
      result: { ...result, exact: wanted.length > 0 && nameKey(result.name) === wanted },
      index,
    }))
    .sort(
      (left, right) =>
        Number(right.result.exact) - Number(left.result.exact) ||
        Number(right.result.libraryScenes !== null) - Number(left.result.libraryScenes !== null) ||
        left.index - right.index,
    )
    .map((entry) => entry.result);
}
