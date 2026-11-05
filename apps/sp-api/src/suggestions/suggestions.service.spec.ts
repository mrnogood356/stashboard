import { SuggestionsService } from './suggestions.service';

describe('SuggestionsService', () => {
  function setup() {
    const scene = (id: string) => ({
      id,
      title: `Scene ${id}`,
      details: null,
      imageUrl: null,
      studioId: null,
      studioName: null,
      studioImageUrl: null,
      date: null,
      releaseDate: '2026-10-01',
      productionDate: null,
      duration: 1800,
      performers: [{ id: 'p-k', name: 'Kaitlyn' }],
    });
    let state = 'NOT_REQUESTED';
    const deps = {
      prisma: {
        suggestionDismissal: { findMany: jest.fn().mockResolvedValue([]) },
      },
      integrations: {
        findOne: jest.fn().mockResolvedValue({
          enabled: true,
          status: 'CONFIGURED',
          baseUrl: 'http://stash',
          apiKey: 'k',
        }),
      },
      catalogProvider: {
        getInstanceCatalogProvider: jest.fn().mockResolvedValue({
          providerKey: 'STASHDB',
          integrationType: 'STASHDB',
          baseUrl: 'https://stashdb.org/graphql',
          apiKey: 'x',
        }),
        getConfiguredCatalogProviderOrNull: jest.fn(),
      },
      stash: {
        listWatchHistory: jest.fn().mockResolvedValue([
          {
            playCount: 4,
            oCounter: 0,
            rating100: null,
            lastPlayedAt: new Date().toISOString(),
            performers: [
              { catalogId: 'p-k', name: 'Kaitlyn', favorite: false },
            ],
            studio: null,
          },
        ]),
      },
      stashdb: {
        getScenesForPerformer: jest
          .fn()
          .mockResolvedValue({ total: 2, scenes: [scene('a'), scene('b')] }),
        getScenesBySort: jest.fn(),
      },
      sceneStatus: {
        resolveForScenes: jest.fn((ids: string[]) =>
          Promise.resolve(
            new Map(
              ids.map((id) => [
                id,
                { state: id === 'a' ? state : 'NOT_REQUESTED' },
              ]),
            ),
          ),
        ),
      },
      scenes: {
        toScenesFeedItem: (
          s: { id: string; title: string },
          source: string,
          status: unknown,
          requestable: boolean,
        ) => ({
          id: s.id,
          title: s.title,
          source,
          status,
          requestable,
        }),
      },
      hiddenContent: { getRules: jest.fn().mockResolvedValue(null) },
    };
    const service = new SuggestionsService(
      deps.prisma as never,
      deps.integrations as never,
      deps.catalogProvider as never,
      deps.stash as never,
      deps.stashdb as never,
      deps.sceneStatus as never,
      deps.scenes as never,
      deps.hiddenContent as never,
    );
    return { service, deps, request: () => (state = 'REQUESTED') };
  }

  it('picks from the instance’s own catalog, whatever a page is browsing', async () => {
    const { service, deps } = setup();
    const result = await service.list();
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(deps.catalogProvider.getInstanceCatalogProvider).toHaveBeenCalled();
    expect(
      deps.catalogProvider.getConfiguredCatalogProviderOrNull,
    ).not.toHaveBeenCalled();
  });

  it('drops a scene requested since the list was worked out, without working it out again', async () => {
    const { service, deps, request } = setup();
    await service.list();
    request();
    const again = await service.list();
    expect(again.items.map((item) => item.id)).toEqual(['b']);
    expect(deps.stash.listWatchHistory).toHaveBeenCalledTimes(1);
  });
});
