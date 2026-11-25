import { describe, expect, it } from 'vitest';
import { PerformerFeedItem } from '../../core/api/discover.types';
import { addFound, catalogPerformers, libraryPeople, missedNames, nameKey } from './search-merge';

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

  it('marks catalog entries you have, by catalog id first, then by name', () => {
    const listed = catalogPerformers(
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

    // Only the catalog's, an exact name first, then in the catalog's order.
    expect(listed.map((entry) => entry.name)).toEqual(['BEA', 'Ana', 'Cat']);
    expect(listed[0]).toMatchObject({ exact: true, libraryScenes: 2, favorite: true });
    expect(listed[1]).toMatchObject({ link: ['/performer', 'c1'], libraryScenes: 4 });
    expect(listed[2]).toMatchObject({ libraryScenes: null, catalogScenes: 5 });
  });

  it('gives a library entry to the catalog entry it’s linked to, not a namesake listed first', () => {
    const listed = catalogPerformers(
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
    const byName = new Map(listed.map((entry) => [entry.name, entry]));
    expect(byName.get('Samuel')?.libraryScenes).toBe(3);
    expect(byName.get('Sam')?.libraryScenes).toBeNull();
  });

  it('lists your library’s own, each opening its library page, an exact name first', () => {
    const listed = libraryPeople(
      [
        { id: 'l1', name: 'Bea Two', imageUrl: null, sceneCount: 4, favorite: false },
        { id: 'l2', name: 'Bea', imageUrl: null, sceneCount: 2, favorite: true },
      ],
      'performer',
      'bea',
    );
    expect(listed.map((entry) => entry.name)).toEqual(['Bea', 'Bea Two']);
    expect(listed[0]).toMatchObject({
      key: 'library:l2',
      link: ['/library/performer', 'l2'],
      libraryScenes: 2,
      catalogScenes: null,
      favorite: true,
    });
    expect(
      libraryPeople(
        [{ id: 's1', name: 'Studio A', imageUrl: null, sceneCount: 1 }],
        'studio',
        'x',
      )[0],
    ).toMatchObject({ link: ['/library/studio', 's1'], kind: 'studio', favorite: false });
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
