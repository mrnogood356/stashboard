import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { EMPTY_EXCLUDE_RULES } from '../scenes/scene-exclude-terms.util';
import { HybridScenesService } from './hybrid-scenes.service';

describe('HybridScenesService hidden content', () => {
  const scene = (id: string, studioId: string) => ({
    id,
    title: id,
    details: null,
    imageUrl: null,
    studioId,
    studioName: studioId,
    studioImageUrl: null,
    date: null,
    releaseDate: null,
    productionDate: null,
    duration: null,
  });
  let getScenesBySort: jest.Mock;
  let findScenesByStashId: jest.Mock;
  let service: HybridScenesService;

  beforeEach(() => {
    getScenesBySort = jest.fn().mockResolvedValue({
      total: 3,
      scenes: [scene('a', 's-ok'), scene('b', 's-hidden'), scene('c', 's-ok')],
    });
    findScenesByStashId = jest.fn().mockResolvedValue([]);
    service = new HybridScenesService(
      { findScenesByStashId } as unknown as StashAdapter,
      { getScenesBySort } as unknown as StashdbAdapter,
    );
  });

  const hidden = { ...EMPTY_EXCLUDE_RULES, studioIds: new Set(['s-hidden']) };

  it('leaves hidden scenes out of a "missing from library" rail', async () => {
    const result = await service.getHybridSceneFeed(
      { baseUrl: 'https://stashdb.org/graphql' },
      { baseUrl: 'http://stash.local' },
      {
        page: 1,
        perPage: 10,
        sort: 'TRENDING',
        direction: 'DESC',
        libraryAvailability: 'MISSING_FROM_LIBRARY',
        hidden,
      },
    );

    expect(result.scenes.map((entry) => entry.id)).toEqual(['a', 'c']);
    // The hidden scene isn't even looked up in the library.
    expect(findScenesByStashId).toHaveBeenCalledTimes(2);
  });

  it('never hides scenes you already have', async () => {
    findScenesByStashId.mockResolvedValue([{ id: '1' }]);

    const result = await service.getHybridSceneFeed(
      { baseUrl: 'https://stashdb.org/graphql' },
      { baseUrl: 'http://stash.local' },
      {
        page: 1,
        perPage: 10,
        sort: 'TRENDING',
        direction: 'DESC',
        libraryAvailability: 'IN_LIBRARY',
        hidden,
      },
    );

    expect(result.scenes.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});
