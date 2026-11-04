import { describe, expect, it } from 'vitest';
import { PerformerFeedItem, SceneExplorerItem } from '../../core/api/discover.types';
import { LibrarySceneItem } from '../../core/api/library.types';
import { addFound, mergePerformers, mergeScenes, missedNames, nameKey } from './search-merge';

const catalogPerformer = (id: string, name: string): PerformerFeedItem => ({
  id,
  name,
  gender: null,
  sceneCount: 5,
  isFavorite: false,
  imageUrl: null,
  cardImageUrl: null,
});

describe('search merge', () => {
  it('compares names without case, accents or punctuation', () => {
    expect(nameKey('Zoë O’Neil')).toBe(nameKey('zoe oneil'));
  });

  it('matches by catalog id first, then by name, and lists each person once', () => {
    const merged = mergePerformers(
      [
        {
          id: 'l1',
          name: 'Different Name',
          imageUrl: null,
          sceneCount: 4,
          favorite: false,
          catalogIds: ['c1'],
        },
        { id: 'l2', name: 'Bea', imageUrl: null, sceneCount: 2, favorite: true },
        { id: 'l3', name: 'Only Mine', imageUrl: null, sceneCount: 1, favorite: false },
      ],
      [catalogPerformer('c1', 'Ana'), catalogPerformer('c2', 'BEA'), catalogPerformer('c3', 'Cat')],
      'bea',
    );

    expect(merged.map((entry) => entry.name)).toEqual(['BEA', 'Ana', 'Only Mine', 'Cat']);
    expect(merged[0]).toMatchObject({ exact: true, libraryScenes: 2, favorite: true });
    expect(merged[1]).toMatchObject({ link: ['/performer', 'c1'], libraryScenes: 4 });
    expect(merged[2]).toMatchObject({ link: ['/library/performer', 'l3'], catalogScenes: null });
  });

  it('gives a library entry to the catalog entry it’s linked to, not a namesake listed first', () => {
    const merged = mergePerformers(
      [
        {
          id: 'l1',
          name: 'Sam',
          imageUrl: null,
          sceneCount: 3,
          favorite: false,
          catalogIds: ['c2'],
        },
      ],
      [catalogPerformer('c1', 'Sam'), catalogPerformer('c2', 'Samuel')],
      'sa',
    );
    const byName = new Map(merged.map((entry) => [entry.name, entry]));
    expect(byName.get('Samuel')?.libraryScenes).toBe(3);
    expect(byName.get('Sam')?.libraryScenes).toBeNull();
  });

  it('shows a scene you own once: the catalog card, then library scenes the catalog didn’t find', () => {
    const catalog = [
      { id: 'c1', localSceneId: 'l1' },
      { id: 'c2', localSceneId: null },
    ] as SceneExplorerItem[];
    const library = [
      { id: 'l1', activeCatalogSceneId: 'c1' },
      { id: 'l2', activeCatalogSceneId: 'c2' },
      { id: 'l3', activeCatalogSceneId: null },
    ] as LibrarySceneItem[];

    expect(mergeScenes(catalog, library).map((scene) => `${scene.from}:${scene.item.id}`)).toEqual([
      'catalog:c1',
      'catalog:c2',
      'library:l3',
    ]);
  });
});

describe('asking the catalog by library names', () => {
  const studio = (id: string, name: string, sceneCount = 1, catalogIds: string[] = []) => ({
    id,
    name,
    imageUrl: null,
    sceneCount,
    catalogIds,
  });

  it('names library entries the catalog search missed', () => {
    const local = [studio('1', 'Blacked Raw', 2, ['c1']), studio('2', 'Blacked', 9)];
    expect(missedNames(local, [{ id: 'c2', name: 'Blacked' }], 'blackedraw')).toEqual([
      'Blacked Raw',
    ]);
    // Already asked by that name: nothing new to ask.
    expect(missedNames([studio('1', 'Blacked Raw')], [], 'blacked raw')).toEqual([]);
  });

  it('keeps only the same studio from the answer, once', () => {
    const local = [studio('1', 'Blacked Raw', 2, ['c1'])];
    const found = [
      { id: 'c1', name: 'Blacked Raw (StashDB)' },
      { id: 'c3', name: 'Blacked' },
      { id: 'c4', name: 'blacked raw' },
    ];
    expect(addFound([{ id: 'c4', name: 'Blacked Raw' }], found, local).map((s) => s.id)).toEqual([
      'c4',
      'c1',
    ]);
  });
});
