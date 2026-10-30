import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import {
  StashdbAdapter,
  StashdbSceneDetails,
} from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { SceneStatusService } from '../scene-status/scene-status.service';
import {
  EMPTY_EXCLUDE_RULES,
  buildExcludeMatchers,
} from './scene-exclude-terms.util';
import { ScenesService } from './scenes.service';

describe('ScenesService', () => {
  const integrationsService = {
    findOne: jest.fn(),
  } as unknown as IntegrationsService;
  const isBrowseOnlyRequestMock = jest.fn();
  const catalogProviderService = {
    getConfiguredCatalogProvider: jest.fn(),
    getInstanceCatalogProvider: jest
      .fn()
      .mockResolvedValue({ integrationType: 'STASHDB' }),
    isBrowseOnlyRequest: isBrowseOnlyRequestMock,
  } as unknown as CatalogProviderService;

  const stashdbAdapter = {
    getSceneById: jest.fn(),
    getScenesBySort: jest.fn(),
    searchTags: jest.fn(),
    findTagIdsByNames: jest.fn(),
    existingTagIds: jest.fn(),
    favoriteStudio: jest.fn(),
  } as unknown as StashdbAdapter;

  const sceneStatusService = {
    resolveForScene: jest.fn(),
  } as unknown as SceneStatusService;

  const stashAdapter = {
    findScenesByStashId: jest.fn(),
  } as unknown as StashAdapter;

  const whisparrAdapter = {
    findMovieByStashId: jest.fn(),
    buildSceneViewUrl: jest.fn(),
  } as unknown as WhisparrAdapter;

  const stashdbIntegration = {
    enabled: true,
    status: IntegrationStatus.CONFIGURED,
    baseUrl: 'http://stashdb.local',
    apiKey: 'stashdb-key',
  };

  const stashIntegration = {
    enabled: true,
    status: IntegrationStatus.CONFIGURED,
    baseUrl: 'http://stash.local',
    apiKey: 'stash-key',
  };

  const whisparrIntegration = {
    enabled: true,
    status: IntegrationStatus.CONFIGURED,
    baseUrl: 'http://whisparr.local',
    apiKey: 'whisparr-key',
  };

  const sceneDetails: StashdbSceneDetails = {
    id: 'stashdb-scene-1',
    title: 'Scene',
    details: 'Description',
    imageUrl: 'http://cdn.local/image.jpg',
    images: [],
    studioId: 'studio-1',
    studioIsFavorite: false,
    studioName: 'Studio',
    studioImageUrl: 'http://studio-image',
    releaseDate: '2026-01-01',
    duration: 300,
    tags: [],
    performers: [],
    sourceUrls: [],
  };

  let service: ScenesService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Single-provider stand-in: load from whatever provider the test configured.
    (
      catalogProviderService as unknown as { withDetailFallback: unknown }
    ).withDetailFallback = jest.fn(
      async (load: (provider: unknown) => Promise<unknown>) => {
        const provider =
          await catalogProviderService.getConfiguredCatalogProvider();
        return { value: await load(provider), provider, browseOnly: false };
      },
    );
    isBrowseOnlyRequestMock.mockResolvedValue(false);
    service = new ScenesService(
      integrationsService,
      catalogProviderService,
      stashdbAdapter,
      sceneStatusService,
      stashAdapter,
      whisparrAdapter,
    );

    integrationsService.findOne = jest
      .fn()
      .mockImplementation((type: IntegrationType) => {
        if (type === IntegrationType.STASH) {
          return stashIntegration;
        }

        if (type === IntegrationType.WHISPARR) {
          return whisparrIntegration;
        }

        throw new Error('Unexpected integration type');
      });
    catalogProviderService.getConfiguredCatalogProvider = jest
      .fn()
      .mockResolvedValue({
        integrationType: 'STASHDB',
        providerKey: 'STASHDB',
        label: 'StashDB',
        baseUrl: stashdbIntegration.baseUrl,
        apiKey: stashdbIntegration.apiKey,
      });

    stashdbAdapter.getSceneById = jest.fn().mockResolvedValue(sceneDetails);
    stashdbAdapter.getScenesBySort = jest.fn().mockResolvedValue({
      total: 1,
      scenes: [
        {
          id: 'stashdb-scene-1',
          title: 'Scene',
          details: 'Description',
          imageUrl: 'http://cdn.local/image.jpg',
          studioId: 'studio-1',
          studioName: 'Studio',
          studioImageUrl: 'http://studio-image',
          date: '2026-01-01',
          releaseDate: '2026-01-02',
          productionDate: '2026-01-03',
          duration: 300,
        },
      ],
    });
    stashdbAdapter.searchTags = jest.fn().mockResolvedValue([]);
    stashdbAdapter.findTagIdsByNames = jest.fn(
      (_config: unknown, names: readonly string[]) =>
        Promise.resolve(
          new Map(names.map((name) => [name.toLowerCase(), null])),
        ),
    );
    stashdbAdapter.existingTagIds = jest.fn().mockResolvedValue(new Set());
    stashdbAdapter.favoriteStudio = jest.fn().mockResolvedValue({
      favorited: true,
      alreadyFavorited: false,
    });
    sceneStatusService.resolveForScene = jest
      .fn()
      .mockResolvedValue({ state: 'AVAILABLE' });
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(
        new Map([['stashdb-scene-1', { state: 'AVAILABLE' }]]),
      );
    sceneStatusService.resolveLocalSceneIds = jest
      .fn()
      .mockResolvedValue(new Map([['stashdb-scene-1', '42']]));
    stashAdapter.findScenesByStashId = jest.fn().mockResolvedValue([]);
    whisparrAdapter.findMovieByStashId = jest.fn().mockResolvedValue(null);
    whisparrAdapter.buildSceneViewUrl = jest
      .fn()
      .mockReturnValue('http://whisparr.local/movie/stashdb-scene-1');
  });

  it('enriches scene details with stash availability when stash copies exist', async () => {
    stashAdapter.findScenesByStashId = jest.fn().mockResolvedValue([
      {
        id: '3027',
        width: 3840,
        height: 2160,
        viewUrl: 'http://stash.local/scene/3027',
        label: '2160p',
      },
      {
        id: '3030',
        width: 1920,
        height: 1080,
        viewUrl: 'http://stash.local/scene/3030',
        label: '1080p',
      },
    ]);

    await expect(
      service.getSceneById('stashdb-scene-1'),
    ).resolves.toMatchObject({
      id: 'stashdb-scene-1',
      stash: {
        exists: true,
        hasMultipleCopies: true,
        copies: [
          { id: '3027', label: '2160p' },
          { id: '3030', label: '1080p' },
        ],
      },
      whisparr: null,
    });
    expect(stashAdapter.findScenesByStashId).toHaveBeenCalledWith(
      'stashdb-scene-1',
      {
        baseUrl: stashIntegration.baseUrl,
        apiKey: stashIntegration.apiKey,
      },
      {
        providerKey: 'STASHDB',
      },
    );
  });

  it('marks scenes from a browse-only provider as not requestable', async () => {
    isBrowseOnlyRequestMock.mockResolvedValue(true);
    catalogProviderService.getConfiguredCatalogProvider = jest
      .fn()
      .mockResolvedValue({
        integrationType: 'FANSDB',
        providerKey: 'FANSDB',
        label: 'FansDB',
        baseUrl: 'http://fansdb.local/graphql',
        apiKey: null,
      });
    (stashdbAdapter.getScenesBySort as jest.Mock).mockResolvedValue({
      total: 1,
      scenes: [
        {
          id: 'fans-1',
          title: 'Fans Scene',
          images: [],
          tags: [],
          performers: [],
        },
      ],
    });
    (sceneStatusService.resolveForScenes as jest.Mock).mockResolvedValue(
      new Map(),
    );

    const result = await service.getScenesFeed();

    expect(result.items[0]).toEqual(
      expect.objectContaining({ id: 'fans-1', requestable: false }),
    );
  });

  it('defaults to TRENDING sort for scenes feed and returns statuses', async () => {
    await expect(service.getScenesFeed()).resolves.toEqual({
      total: 1,
      page: 1,
      perPage: 24,
      hasMore: false,
      hidden: 0,
      items: [
        {
          id: 'stashdb-scene-1',
          title: 'Scene',
          description: 'Description',
          imageUrl: 'http://cdn.local/image.jpg',
          cardImageUrl: 'http://cdn.local/image.jpg?size=600',
          studioId: 'studio-1',
          studio: 'Studio',
          studioImageUrl: 'http://studio-image',
          releaseDate: '2026-01-02',
          duration: 300,
          type: 'SCENE',
          source: 'STASHDB',
          status: { state: 'AVAILABLE' },
          requestable: false,
          localSceneId: '42',
        },
      ],
    });
    expect(sceneStatusService.resolveLocalSceneIds).toHaveBeenCalledWith([
      'stashdb-scene-1',
    ]);

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 24,
      sort: 'TRENDING',
      direction: 'DESC',
      favorites: undefined,
      tagFilter: undefined,
      studioIds: [],
    });
    expect(stashAdapter.findScenesByStashId).not.toHaveBeenCalled();
  });

  it('uses the active FANSDB provider for discovery feed and scene detail source', async () => {
    catalogProviderService.getConfiguredCatalogProvider = jest
      .fn()
      .mockResolvedValue({
        integrationType: 'FANSDB',
        providerKey: 'FANSDB',
        label: 'FansDB',
        baseUrl: 'http://fansdb.local/graphql',
        apiKey: 'fansdb-key',
      });

    await expect(service.getScenesFeed()).resolves.toMatchObject({
      items: [expect.objectContaining({ source: 'FANSDB' })],
    });
    await expect(
      service.getSceneById('stashdb-scene-1'),
    ).resolves.toMatchObject({
      source: 'FANSDB',
    });

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'http://fansdb.local/graphql',
        apiKey: 'fansdb-key',
      }),
    );
    expect(stashdbAdapter.getSceneById).toHaveBeenCalledWith(
      'stashdb-scene-1',
      {
        baseUrl: 'http://fansdb.local/graphql',
        apiKey: 'fansdb-key',
      },
    );
    expect(stashAdapter.findScenesByStashId).toHaveBeenCalledWith(
      'stashdb-scene-1',
      {
        baseUrl: stashIntegration.baseUrl,
        apiKey: stashIntegration.apiKey,
      },
      {
        providerKey: 'FANSDB',
      },
    );
  });

  it('only looks up local scenes for scenes in the library', async () => {
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(
        new Map([['stashdb-scene-1', { state: 'NOT_REQUESTED' }]]),
      );
    sceneStatusService.resolveLocalSceneIds = jest
      .fn()
      .mockResolvedValue(new Map());

    const result = await service.getScenesFeed();

    expect(sceneStatusService.resolveLocalSceneIds).toHaveBeenCalledWith([]);
    expect(result.items[0].localSceneId).toBeNull();
  });

  it('reuses a catalog page for a minute, but not after a failure or a favorite change', async () => {
    await service.getScenesFeed(1, 16, 'DATE', 'DESC', [], 'OR', 'STUDIO');
    await service.getScenesFeed(1, 16, 'DATE', 'DESC', [], 'OR', 'STUDIO');
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledTimes(1);

    // Different filters are a different page.
    await service.getScenesFeed(1, 16, 'DATE', 'DESC', [], 'OR', 'PERFORMER');
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledTimes(2);

    // Starring a studio changes the favorite-studio list.
    await service.favoriteStudio('studio-1', true);
    await service.getScenesFeed(1, 16, 'DATE', 'DESC', [], 'OR', 'STUDIO');
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledTimes(3);

    (stashdbAdapter.getScenesBySort as jest.Mock).mockRejectedValueOnce(
      new Error('catalog down'),
    );
    await expect(service.getScenesFeed(2, 16)).rejects.toThrow('catalog down');
    await service.getScenesFeed(2, 16);
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledTimes(5);
  });

  it('drops a catalog page read while a favorite change was still in flight', async () => {
    let finishFavorite: (value: unknown) => void = () => undefined;
    (stashdbAdapter.favoriteStudio as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        finishFavorite = resolve;
      }),
    );

    const favoriting = service.favoriteStudio('studio-1', true);
    await new Promise((resolve) => setImmediate(resolve));
    // Read (and cached) before the favorite has landed.
    await service.getScenesFeed(1, 16, 'DATE', 'DESC', [], 'OR', 'STUDIO');
    finishFavorite({ favorited: true, alreadyFavorited: false });
    await favoriting;

    await service.getScenesFeed(1, 16, 'DATE', 'DESC', [], 'OR', 'STUDIO');
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledTimes(2);
  });

  it('forwards non-default sort to stashdb adapter', async () => {
    await service.getScenesFeed(2, 10, 'TITLE');

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 2,
      perPage: 10,
      sort: 'TITLE',
      direction: 'DESC',
      favorites: undefined,
      tagFilter: undefined,
      studioIds: [],
    });
  });

  it('forwards ALL favorites filter to stashdb adapter', async () => {
    await service.getScenesFeed(1, 25, 'DATE', undefined, [], 'OR', 'ALL');

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'DESC',
      favorites: 'ALL',
      tagFilter: undefined,
      studioIds: [],
    });
  });

  it('forwards PERFORMER favorites filter to stashdb adapter', async () => {
    await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      [],
      'OR',
      'PERFORMER',
    );

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'DESC',
      favorites: 'PERFORMER',
      tagFilter: undefined,
      studioIds: [],
    });
  });

  it('marks NOT_REQUESTED discovery scenes as requestable from status resolution', async () => {
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(
        new Map([['stashdb-scene-1', { state: 'NOT_REQUESTED' }]]),
      );

    await expect(service.getScenesFeed(1, 25, 'DATE')).resolves.toEqual({
      total: 1,
      page: 1,
      perPage: 25,
      hasMore: false,
      hidden: 0,
      items: [
        expect.objectContaining({
          id: 'stashdb-scene-1',
          status: { state: 'NOT_REQUESTED' },
          requestable: true,
        }),
      ],
    });

    expect(stashAdapter.findScenesByStashId).not.toHaveBeenCalled();
  });

  it('forwards STUDIO favorites filter to stashdb adapter', async () => {
    await service.getScenesFeed(1, 25, 'DATE', undefined, [], 'OR', 'STUDIO');

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'DESC',
      favorites: 'STUDIO',
      tagFilter: undefined,
      studioIds: [],
    });
  });

  it('forwards selected tags and AND mode to stashdb adapter', async () => {
    await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      ['t-1', 't-2', 't-1'],
      'AND',
      'PERFORMER',
    );

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'DESC',
      favorites: 'PERFORMER',
      tagFilter: {
        tagIds: ['t-1', 't-2'],
        mode: 'AND',
      },
      studioIds: [],
    });
  });

  it('looks tags up by name in the catalog being browsed (a StashDB rail on FansDB)', async () => {
    stashdbAdapter.findTagIdsByNames = jest.fn(
      (_config: unknown, names: readonly string[]) =>
        Promise.resolve(
          new Map(
            names.map((name) => [
              name.toLowerCase(),
              name.toLowerCase() === 'anal' ? 'fans-anal' : null,
            ]),
          ),
        ),
    );

    const result = await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      ['stashdb-anal', 'stashdb-pov'],
      'OR',
      undefined,
      [],
      undefined,
      [],
      ['Anal', 'POV'],
    );

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({
        tagFilter: { tagIds: ['fans-anal'], mode: 'OR' },
      }),
    );
    expect(result.unknownTags).toEqual(['POV']);
  });

  it('shows nothing when every tag is required and one is missing here', async () => {
    stashdbAdapter.findTagIdsByNames = jest.fn(
      (_config: unknown, names: readonly string[]) =>
        Promise.resolve(
          new Map(
            names.map((name) => [
              name.toLowerCase(),
              name.toLowerCase() === 'anal' ? 'fans-anal' : null,
            ]),
          ),
        ),
    );

    const result = await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      ['stashdb-anal', 'stashdb-pov'],
      'AND',
      undefined,
      [],
      undefined,
      [],
      ['Anal', 'POV'],
    );

    expect(stashdbAdapter.getScenesBySort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 0, items: [], unknownTags: ['POV'] });
  });

  it('keeps a tag this catalog has by id even when its name has changed', async () => {
    stashdbAdapter.existingTagIds = jest.fn(
      (_config: unknown, ids: readonly string[]) =>
        Promise.resolve(new Set(ids.filter((id) => id === 'stashdb-renamed'))),
    );

    const result = await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      ['stashdb-renamed'],
      'AND',
      undefined,
      [],
      undefined,
      [],
      ['Old Name'],
    );

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({
        tagFilter: { tagIds: ['stashdb-renamed'], mode: 'AND' },
      }),
    );
    expect(result.unknownTags).toBeUndefined();
  });

  it('looks up a long tag list in one batch, and remembers it', async () => {
    stashdbAdapter.findTagIdsByNames = jest.fn(
      (_config: unknown, names: readonly string[]) =>
        Promise.resolve(
          new Map(names.map((name) => [name.toLowerCase(), `fans-${name}`])),
        ),
    );
    const ids = Array.from({ length: 24 }, (_, index) => `stash-${index}`);
    const names = Array.from({ length: 24 }, (_, index) => `Tag ${index}`);
    const feed = () =>
      service.getScenesFeed(
        1,
        25,
        'DATE',
        undefined,
        ids,
        'OR',
        undefined,
        [],
        undefined,
        [],
        names,
      );

    await feed();
    await feed();

    expect(stashdbAdapter.findTagIdsByNames).toHaveBeenCalledTimes(1);
    expect(
      (stashdbAdapter.findTagIdsByNames as jest.Mock).mock.calls[0][1],
    ).toHaveLength(24);
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({
        tagFilter: {
          tagIds: names.map((name) => `fans-${name.toLowerCase()}`),
          mode: 'OR',
        },
      }),
    );
  });

  it('shows nothing rather than everything when the catalog has none of the tags', async () => {
    const result = await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      ['stashdb-pov'],
      'OR',
      undefined,
      [],
      undefined,
      [],
      ['POV'],
    );

    expect(stashdbAdapter.getScenesBySort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 0, items: [], unknownTags: ['POV'] });
  });

  it('keeps the tag ids when the catalog can’t be asked for names', async () => {
    stashdbAdapter.findTagIdsByNames = jest
      .fn()
      .mockRejectedValue(new Error('down'));

    const result = await service.getScenesFeed(
      1,
      25,
      'DATE',
      undefined,
      ['t-1'],
      'OR',
      undefined,
      [],
      undefined,
      [],
      ['Anal'],
    );

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({ tagFilter: { tagIds: ['t-1'], mode: 'OR' } }),
    );
    expect(result.uncheckedTags).toEqual(['Anal']);
  });

  it('forwards normalized studioIds to stashdb adapter', async () => {
    await service.getScenesFeed(1, 25, 'DATE', undefined, [], 'OR', undefined, [
      'studio-1',
      'studio-1',
      'studio-2',
    ]);

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'DESC',
      favorites: undefined,
      tagFilter: undefined,
      studioIds: ['studio-1', 'studio-2'],
    });
  });

  it('forwards explicit sort direction to stashdb adapter', async () => {
    await service.getScenesFeed(1, 25, 'DATE', 'ASC');

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'ASC',
      favorites: undefined,
      tagFilter: undefined,
      studioIds: [],
    });
  });

  it('drops scenes matching excluded words, including "-word" in the text search', async () => {
    const baseScene = {
      details: null,
      imageUrl: null,
      studioId: 'studio-1',
      studioName: 'Studio',
      studioImageUrl: null,
      date: null,
      releaseDate: null,
      productionDate: null,
      duration: null,
    };
    stashdbAdapter.getScenesBySort = jest.fn().mockResolvedValue({
      total: 60,
      scenes: [
        { ...baseScene, id: 'keep', title: 'Anal Weekend', tagNames: ['Anal'] },
        {
          ...baseScene,
          id: 'tagged',
          title: 'Night',
          tagNames: ['Trans Woman'],
        },
        { ...baseScene, id: 'titled', title: 'TRANSGENDER special' },
        {
          ...baseScene,
          id: 'studio',
          title: 'Other',
          studioName: 'Trans Angels',
        },
        { ...baseScene, id: 'partial', title: 'Transfer day' },
      ],
    });
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(new Map());

    const result = await service.getScenesFeed(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      'anal -transgender',
      ['trans'],
    );

    expect(result.items.map((item) => item.id)).toEqual(['keep', 'partial']);
    // Paging still follows the catalog.
    expect(result.total).toBe(60);
    expect(result.hasMore).toBe(true);
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'anal', includeTagNames: true }),
    );
  });

  it("hides scenes from Settings → Hidden content on top of the search's own exclude words", async () => {
    const baseScene = {
      details: null,
      imageUrl: null,
      studioImageUrl: null,
      date: null,
      releaseDate: null,
      productionDate: null,
      duration: null,
    };
    stashdbAdapter.getScenesBySort = jest.fn().mockResolvedValue({
      total: 48,
      scenes: [
        {
          ...baseScene,
          id: 'keep',
          title: 'Weekend',
          studioId: 'studio-1',
          studioName: 'Studio',
          tagIds: ['tag-ok'],
          tagNames: ['POV'],
        },
        {
          ...baseScene,
          id: 'searched-out',
          title: 'Anal night',
          studioId: 'studio-1',
          studioName: 'Studio',
        },
        {
          ...baseScene,
          id: 'hidden-word',
          title: 'Night',
          studioId: 'studio-1',
          studioName: 'Studio',
          tagIds: ['tag-x'],
          tagNames: ['Transgender'],
        },
        {
          ...baseScene,
          id: 'hidden-tag',
          title: 'Night',
          studioId: 'studio-1',
          studioName: 'Studio',
          tagIds: ['tag-hidden'],
          tagNames: ['Whatever'],
        },
        {
          ...baseScene,
          id: 'hidden-studio',
          title: 'Night',
          studioId: 'studio-hidden',
          studioName: 'Hidden Studio',
        },
      ],
    });
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(new Map());
    const getRules = jest.fn((showHidden: boolean) =>
      Promise.resolve(
        showHidden
          ? {
              ...EMPTY_EXCLUDE_RULES,
              matchers: [],
              tagIds: new Set<string>(),
              studioIds: new Set<string>(),
            }
          : {
              ...EMPTY_EXCLUDE_RULES,
              matchers: buildExcludeMatchers(['trans', 'transgender']),
              tagIds: new Set(['tag-hidden']),
              studioIds: new Set(['studio-hidden']),
            },
      ),
    );
    service = new ScenesService(
      integrationsService,
      catalogProviderService,
      stashdbAdapter,
      sceneStatusService,
      stashAdapter,
      whisparrAdapter,
      { getRules } as unknown as HiddenContentService,
    );

    const result = await service.getScenesFeed(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      undefined,
      ['anal'],
    );

    expect(result.items.map((item) => item.id)).toEqual(['keep']);
    // What you excluded yourself isn't counted as hidden.
    expect(result.hidden).toBe(3);
    expect(getRules).toHaveBeenCalledWith(false);
    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.objectContaining({ includeTagNames: true }),
    );

    const shown = await service.getScenesFeed(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      [],
      undefined,
      ['anal'],
      [],
      true,
    );

    expect(shown.items.map((item) => item.id)).toEqual([
      'keep',
      'hidden-word',
      'hidden-tag',
      'hidden-studio',
    ]);
    expect(shown.hidden).toBe(0);
    expect(getRules).toHaveBeenLastCalledWith(true);
  });

  it('only asks the catalog for tags when a word or tag has to be matched', async () => {
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(new Map());
    service = new ScenesService(
      integrationsService,
      catalogProviderService,
      stashdbAdapter,
      sceneStatusService,
      stashAdapter,
      whisparrAdapter,
      {
        getRules: jest.fn().mockResolvedValue({
          ...EMPTY_EXCLUDE_RULES,
          matchers: [],
          tagIds: new Set<string>(),
          studioIds: new Set(['studio-hidden']),
        }),
      } as unknown as HiddenContentService,
    );

    await service.getScenesFeed(1, 24);

    expect(stashdbAdapter.getScenesBySort).toHaveBeenCalledWith(
      expect.not.objectContaining({ includeTagNames: true }),
    );
  });

  it("shows a hidden studio's scenes when you filter on that studio", async () => {
    stashdbAdapter.getScenesBySort = jest.fn().mockResolvedValue({
      total: 1,
      scenes: [
        {
          id: 'from-hidden-studio',
          title: 'Night',
          details: null,
          imageUrl: null,
          studioId: 'studio-hidden',
          studioName: 'Hidden Studio',
          studioImageUrl: null,
          date: null,
          releaseDate: null,
          productionDate: null,
          duration: null,
        },
      ],
    });
    sceneStatusService.resolveForScenes = jest
      .fn()
      .mockResolvedValue(new Map());
    service = new ScenesService(
      integrationsService,
      catalogProviderService,
      stashdbAdapter,
      sceneStatusService,
      stashAdapter,
      whisparrAdapter,
      {
        getRules: jest.fn().mockResolvedValue({
          ...EMPTY_EXCLUDE_RULES,
          studioIds: new Set(['studio-hidden']),
        }),
      } as unknown as HiddenContentService,
    );

    const result = await service.getScenesFeed(
      1,
      24,
      'TRENDING',
      'DESC',
      [],
      'OR',
      undefined,
      ['studio-hidden'],
    );

    expect(result.items.map((item) => item.id)).toEqual(['from-hidden-studio']);
    expect(result.hidden).toBe(0);
  });

  it('returns scene tag options from stashdb', async () => {
    stashdbAdapter.searchTags = jest.fn().mockResolvedValue([
      {
        id: 'tag-1',
        name: 'Tag One',
        description: null,
        aliases: ['Alias 1'],
      },
    ]);

    await expect(service.searchSceneTags('tag')).resolves.toEqual([
      {
        id: 'tag-1',
        name: 'Tag One',
        description: null,
        aliases: ['Alias 1'],
      },
    ]);

    expect(stashdbAdapter.searchTags).toHaveBeenCalledWith({
      baseUrl: stashdbIntegration.baseUrl,
      apiKey: stashdbIntegration.apiKey,
      query: 'tag',
    });
  });

  it('returns stash null when stash integration is unavailable', async () => {
    integrationsService.findOne = jest
      .fn()
      .mockImplementation((type: IntegrationType) => {
        if (type === IntegrationType.WHISPARR) {
          return whisparrIntegration;
        }

        throw new Error('stash unavailable');
      });

    await expect(
      service.getSceneById('stashdb-scene-1'),
    ).resolves.toMatchObject({
      id: 'stashdb-scene-1',
      stash: null,
      whisparr: null,
    });
  });

  it('returns stash null when stash provider fails', async () => {
    stashAdapter.findScenesByStashId = jest
      .fn()
      .mockRejectedValue(new Error('provider failed'));

    await expect(
      service.getSceneById('stashdb-scene-1'),
    ).resolves.toMatchObject({
      id: 'stashdb-scene-1',
      stash: null,
      whisparr: null,
    });
  });

  it('enriches scene details with whisparr view link when scene exists in whisparr', async () => {
    whisparrAdapter.findMovieByStashId = jest.fn().mockResolvedValue({
      movieId: 44,
      stashId: 'stashdb-scene-1',
      hasFile: false,
    });

    await expect(
      service.getSceneById('stashdb-scene-1'),
    ).resolves.toMatchObject({
      id: 'stashdb-scene-1',
      whisparr: {
        exists: true,
        viewUrl: 'http://whisparr.local/movie/stashdb-scene-1',
      },
    });
  });

  it('returns whisparr null when whisparr provider fails', async () => {
    whisparrAdapter.findMovieByStashId = jest
      .fn()
      .mockRejectedValue(new Error('provider failed'));

    await expect(
      service.getSceneById('stashdb-scene-1'),
    ).resolves.toMatchObject({
      id: 'stashdb-scene-1',
      whisparr: null,
    });
  });

  it('favorites studio by id', async () => {
    await expect(service.favoriteStudio('studio-1', true)).resolves.toEqual({
      favorited: true,
      alreadyFavorited: false,
    });

    expect(stashdbAdapter.favoriteStudio).toHaveBeenCalledWith(
      'studio-1',
      true,
      {
        baseUrl: stashdbIntegration.baseUrl,
        apiKey: stashdbIntegration.apiKey,
      },
    );
  });
});
