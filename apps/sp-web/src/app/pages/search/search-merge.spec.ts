import { describe, expect, it } from 'vitest';
import { PerformerFeedItem, SceneExplorerItem } from '../../core/api/discover.types';
import { LibrarySceneItem } from '../../core/api/library.types';
import { mergePerformers, mergeScenes, nameKey } from './search-merge';

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
