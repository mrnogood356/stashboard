import { SceneFacetsService } from './scene-facets.service';
import type { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import type { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';

describe('SceneFacetsService', () => {
  const facets = { total: 3, scanned: 3, tags: [], studios: [] };
  let getSceneFacets: jest.Mock;
  let service: SceneFacetsService;

  beforeEach(() => {
    getSceneFacets = jest.fn().mockResolvedValue(facets);
    service = new SceneFacetsService(
      {
        getConfiguredCatalogProvider: jest
          .fn()
          .mockResolvedValue({ baseUrl: 'http://stashdb', apiKey: 'k' }),
      } as unknown as CatalogProviderService,
      { getSceneFacets } as unknown as StashdbAdapter,
    );
  });

  it('asks the catalog once an hour for the same performer', async () => {
    await expect(service.forPerformer(' p1 ')).resolves.toBe(facets);
    await service.forPerformer('p1');
    await service.forStudio('p1');

    expect(getSceneFacets).toHaveBeenCalledTimes(2);
    expect(getSceneFacets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ performerId: 'p1', maxScenes: 500 }),
    );
    expect(getSceneFacets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ studioId: 'p1' }),
    );
  });

  it('asks again after a failed look', async () => {
    getSceneFacets.mockRejectedValueOnce(new Error('catalog down'));

    await expect(service.forPerformer('p1')).rejects.toThrow('catalog down');
    await expect(service.forPerformer('p1')).resolves.toBe(facets);
    expect(getSceneFacets).toHaveBeenCalledTimes(2);
  });

  it('needs an id', async () => {
    await expect(service.forStudio('  ')).rejects.toThrow('studio id');
  });
});
