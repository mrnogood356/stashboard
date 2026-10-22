import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  IntegrationStatus,
  IntegrationType,
  RequestStatus,
} from '@prisma/client';
import { IndexingService } from '../indexing/indexing.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  indexerNotice,
  RequestsService,
  sortReleases,
} from './requests.service';

describe('RequestsService', () => {
  const findOneMock = jest.fn();
  const getConfiguredCatalogProviderMock = jest.fn();
  const findMovieByStashIdMock = jest.fn();
  const getRootFoldersMock = jest.fn();
  const getQualityProfilesMock = jest.fn();
  const getTagsMock = jest.fn();
  const createMovieMock = jest.fn();
  const getSceneByIdMock = jest.fn();
  const upsertRequestMock = jest.fn();
  const seedRequestedSceneMock = jest.fn();
  const requestImmediateRefreshMock = jest.fn();
  const searchReleasesMock = jest.fn();
  const findSceneIndexMock = jest.fn();

  const indexingService = {
    seedRequestedScene: seedRequestedSceneMock,
    requestImmediateRefresh: requestImmediateRefreshMock,
  } as unknown as IndexingService;

  const integrationsService = {
    findOne: findOneMock,
  } as unknown as IntegrationsService;
  const catalogProviderService = {
    getConfiguredCatalogProvider: getConfiguredCatalogProviderMock,
    getInstanceCatalogProvider: getConfiguredCatalogProviderMock,
  } as unknown as CatalogProviderService;

  const whisparrAdapter = {
    findMovieByStashId: findMovieByStashIdMock,
    getRootFolders: getRootFoldersMock,
    getQualityProfiles: getQualityProfilesMock,
    getTags: getTagsMock,
    createMovie: createMovieMock,
    searchReleases: searchReleasesMock,
  } as unknown as WhisparrAdapter;

  const stashdbAdapter = {
    getSceneById: getSceneByIdMock,
  } as unknown as StashdbAdapter;

  const prismaService = {
    request: {
      upsert: upsertRequestMock,
    },
    sceneIndex: {
      findUnique: findSceneIndexMock,
    },
  } as unknown as PrismaService;

  const configuredWhisparrIntegration = {
    enabled: true,
    status: IntegrationStatus.CONFIGURED,
    baseUrl: 'http://whisparr.local',
    apiKey: 'wh-key',
  };

  const configuredStashdbIntegration = {
    integrationType: 'STASHDB',
    providerKey: 'STASHDB',
    label: 'StashDB',
    baseUrl: 'http://stashdb.local',
    apiKey: 'stashdb-key',
  };

  let service: RequestsService;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new RequestsService(
      indexingService,
      integrationsService,
      catalogProviderService,
      whisparrAdapter,
      stashdbAdapter,
      prismaService,
    );

    findOneMock.mockImplementation((type: IntegrationType) => {
      if (type === IntegrationType.WHISPARR) {
        return configuredWhisparrIntegration;
      }

      throw new Error('Unexpected integration type');
    });
    getConfiguredCatalogProviderMock.mockResolvedValue(
      configuredStashdbIntegration,
    );

    getSceneByIdMock.mockImplementation((stashId: string) =>
      Promise.resolve({
        id: stashId,
        title: `Title ${stashId}`,
        details: `Description ${stashId}`,
        imageUrl: `http://image/${stashId}`,
        images: [],
        studioId: 'studio-1',
        studioName: 'Studio',
        studioImageUrl: 'http://studio/image',
        releaseDate: '2026-01-01',
        duration: 123,
        tags: [],
        performers: [],
        sourceUrls: [],
      }),
    );
    upsertRequestMock.mockImplementation(
      ({ where }: { where: { stashId: string } }) =>
        Promise.resolve({
          stashId: where.stashId,
          status: RequestStatus.REQUESTED,
          updatedAt: new Date('2026-03-27T00:00:00.000Z'),
        }),
    );
    requestImmediateRefreshMock.mockResolvedValue(undefined);
  });

  it('returns normalized request options with defaults', async () => {
    getRootFoldersMock.mockResolvedValue([
      { id: 1, path: '/media/a', accessible: false },
      { id: 2, path: '/media/b', accessible: true },
    ]);
    getQualityProfilesMock.mockResolvedValue([{ id: 10, name: 'Default' }]);
    getTagsMock.mockResolvedValue([{ id: 50, label: 'VR' }]);

    const result = await service.getRequestOptions('scene-1');

    expect(result).toEqual({
      scene: {
        stashId: 'scene-1',
        title: 'Title scene-1',
        studio: 'Studio',
      },
      defaults: {
        monitored: true,
        searchForMovie: true,
      },
      rootFolders: [
        { id: 1, path: '/media/a', accessible: false },
        { id: 2, path: '/media/b', accessible: true },
      ],
      qualityProfiles: [{ id: 10, name: 'Default' }],
      tags: [{ id: 50, label: 'VR' }],
    });
  });

  it('throws when there are no accessible root folders', async () => {
    getRootFoldersMock.mockResolvedValue([
      { id: 1, path: '/media/a', accessible: false },
    ]);
    getQualityProfilesMock.mockResolvedValue([{ id: 10, name: 'Default' }]);
    getTagsMock.mockResolvedValue([]);

    await expect(service.getRequestOptions('scene-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('submits create movie request and upserts local request row', async () => {
    findMovieByStashIdMock.mockResolvedValue(null);
    getRootFoldersMock.mockResolvedValue([
      { id: 2, path: '/media/b', accessible: true },
    ]);
    getQualityProfilesMock.mockResolvedValue([{ id: 10, name: 'Default' }]);
    getTagsMock.mockResolvedValue([{ id: 50, label: 'VR' }]);
    createMovieMock.mockResolvedValue({ movieId: 444 });

    const result = await service.submitSceneRequest('scene-1', {
      monitored: true,
      rootFolderPath: '/media/b',
      searchForMovie: true,
      qualityProfileId: 10,
      tags: [50],
    });

    expect(createMovieMock).toHaveBeenCalledWith(
      {
        title: 'Title scene-1',
        studio: 'Studio',
        foreignId: 'scene-1',
        monitored: true,
        rootFolderPath: '/media/b',
        addOptions: { searchForMovie: true },
        qualityProfileId: 10,
        tags: [50],
      },
      expect.objectContaining({ baseUrl: 'http://whisparr.local' }),
    );
    expect(upsertRequestMock).toHaveBeenCalledWith({
      where: { stashId: 'scene-1' },
      create: { stashId: 'scene-1', status: RequestStatus.REQUESTED },
      update: { status: RequestStatus.REQUESTED },
    });
    expect(seedRequestedSceneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stashId: 'scene-1',
        whisparrMovieId: 444,
        whisparrHasFile: false,
        requestStatus: RequestStatus.REQUESTED,
      }),
    );
    expect(requestImmediateRefreshMock).toHaveBeenCalledWith(
      ['scene-1'],
      'request-submitted',
    );
    expect(result).toEqual({
      accepted: true,
      alreadyExists: false,
      stashId: 'scene-1',
      whisparrMovieId: 444,
    });
  });

  it('treats existing whisparr movie as idempotent success', async () => {
    findMovieByStashIdMock.mockResolvedValue({
      movieId: 999,
      stashId: 'scene-1',
      hasFile: false,
    });

    const result = await service.submitSceneRequest('scene-1', {
      monitored: true,
      rootFolderPath: '/media/b',
      searchForMovie: true,
      qualityProfileId: 10,
      tags: [],
    });

    expect(createMovieMock).not.toHaveBeenCalled();
    expect(upsertRequestMock).toHaveBeenCalledTimes(1);
    expect(seedRequestedSceneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stashId: 'scene-1',
        whisparrMovieId: 999,
        whisparrHasFile: false,
      }),
    );
    expect(requestImmediateRefreshMock).toHaveBeenCalledWith(
      ['scene-1'],
      'request-existing-movie',
    );
    expect(result).toEqual({
      accepted: true,
      alreadyExists: true,
      stashId: 'scene-1',
      whisparrMovieId: 999,
    });
  });

  it('throws for missing scene metadata required for provider payload', async () => {
    getSceneByIdMock.mockResolvedValue({
      id: 'scene-1',
      title: 'Title scene-1',
      details: null,
      imageUrl: null,
      images: [],
      studioId: null,
      studioName: null,
      studioImageUrl: null,
      releaseDate: null,
      duration: null,
      tags: [],
      performers: [],
      sourceUrls: [],
    });

    await expect(
      service.submitSceneRequest('scene-1', {
        monitored: true,
        rootFolderPath: '/media/b',
        searchForMovie: true,
        qualityProfileId: 10,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws when no quality profiles are available during submit', async () => {
    findMovieByStashIdMock.mockResolvedValue(null);
    getRootFoldersMock.mockResolvedValue([
      { id: 2, path: '/media/b', accessible: true },
    ]);
    getQualityProfilesMock.mockResolvedValue([]);
    getTagsMock.mockResolvedValue([]);

    await expect(
      service.submitSceneRequest('scene-1', {
        monitored: true,
        rootFolderPath: '/media/b',
        searchForMovie: true,
        qualityProfileId: 10,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws when STASHDB integration has no baseUrl', async () => {
    getConfiguredCatalogProviderMock.mockRejectedValue(
      new BadRequestException('StashDB integration is missing a base URL.'),
    );

    await expect(service.getRequestOptions('scene-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('uses the active FANSDB provider for request metadata lookups', async () => {
    getRootFoldersMock.mockResolvedValue([
      { id: 2, path: '/media/b', accessible: true },
    ]);
    getQualityProfilesMock.mockResolvedValue([{ id: 10, name: 'Default' }]);
    getTagsMock.mockResolvedValue([]);
    getConfiguredCatalogProviderMock.mockResolvedValue({
      integrationType: 'FANSDB',
      providerKey: 'FANSDB',
      label: 'FansDB',
      baseUrl: 'http://fansdb.local/graphql',
      apiKey: 'fansdb-key',
    });

    await service.getRequestOptions('scene-1');

    expect(getSceneByIdMock).toHaveBeenCalledWith('scene-1', {
      baseUrl: 'http://fansdb.local/graphql',
      apiKey: 'fansdb-key',
    });
  });
  it('says how well each release fits the scene and lists the best fits first', async () => {
    findMovieByStashIdMock.mockResolvedValue({
      movieId: 7,
      stashId: 'scene-1',
      hasFile: false,
    });
    findSceneIndexMock.mockResolvedValue({
      title: 'Sunset Rendezvous',
      studioName: 'Brazzers Exxtra',
      releaseDate: '2024-03-15',
      performerNames: 'Jane Doe, Ann Smith',
    });
    const base = {
      indexerId: 1,
      indexer: 'Tracker',
      size: null,
      quality: null,
      protocol: 'torrent',
      seeders: 5,
      leechers: 0,
      ageHours: 1,
      customFormatScore: 0,
      rejected: false,
      rejections: [],
      languages: [],
      infoUrl: null,
      downloadAllowed: true,
    };
    searchReleasesMock.mockResolvedValue([
      {
        ...base,
        guid: 'wrong',
        title: 'Some.Other.Studio.23.01.01.XXX.2160p',
        resolution: 2160,
      },
      {
        ...base,
        guid: 'right',
        title: 'BrazzersExxtra.24.03.15.Jane.Doe.XXX.1080p',
        resolution: 1080,
      },
    ]);

    const result = await service.getReleases('scene-1');

    expect(findSceneIndexMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stashId: 'scene-1' } }),
    );
    expect(result.releases.map((release) => release.guid)).toEqual([
      'right',
      'wrong',
    ]);
    expect(result.releases[0].match).toEqual({
      strength: 'strong',
      matched: ['studio', 'date', 'performer'],
    });
    expect(result.releases[1].match?.strength).toBe('weak');
  });
});

describe('sortReleases', () => {
  const release = (overrides: Record<string, unknown>) => ({
    guid: 'g',
    indexerId: 1,
    indexer: null,
    title: 't',
    size: null,
    quality: null,
    resolution: null,
    protocol: null,
    seeders: null,
    leechers: null,
    ageHours: null,
    customFormatScore: null,
    rejected: false,
    rejections: [],
    languages: [],
    infoUrl: null,
    downloadAllowed: true,
    ...overrides,
  });

  it('puts accepted releases first, then score, resolution and seeders', () => {
    const sorted = sortReleases([
      release({ guid: 'rejected', rejected: true, customFormatScore: 100 }),
      release({ guid: 'low', resolution: 720, seeders: 50 }),
      release({ guid: 'high', resolution: 2160, seeders: 1 }),
      release({ guid: 'scored', customFormatScore: 10 }),
    ]);
    expect(sorted.map((entry) => entry.guid)).toEqual([
      'scored',
      'high',
      'low',
      'rejected',
    ]);
  });

  it('puts releases that fit the scene before better-quality ones that do not', () => {
    const sorted = sortReleases([
      release({
        guid: 'weak-4k',
        resolution: 2160,
        match: { strength: 'weak', matched: [] },
      }),
      release({
        guid: 'partial',
        resolution: 1080,
        match: { strength: 'partial', matched: ['performer'] },
      }),
      release({
        guid: 'strong-720',
        resolution: 720,
        match: { strength: 'strong', matched: ['studio', 'date'] },
      }),
      release({ guid: 'unknown', resolution: 480, match: null }),
    ]);
    expect(sorted.map((entry) => entry.guid)).toEqual([
      'strong-720',
      'unknown',
      'partial',
      'weak-4k',
    ]);
  });
});

describe('indexerNotice', () => {
  it('names the indexers Whisparr paused after errors', () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(
      indexerNotice({
        searchable: 3,
        paused: [
          { name: 'NZBgeek', until },
          { name: 'Torznab', until },
        ],
      }).notice,
    ).toMatch(
      /^Whisparr paused 2 of 3 indexers after errors, until about .+: NZBgeek, Torznab\./,
    );
  });

  it('says when no indexer can do an interactive search', () => {
    expect(indexerNotice({ searchable: 0, paused: [] }).notice).toContain(
      'enabled for interactive search',
    );
  });

  it('says nothing when the indexers are fine, or Whisparr can’t be asked', () => {
    expect(indexerNotice({ searchable: 2, paused: [] })).toEqual({});
    expect(indexerNotice(null)).toEqual({});
  });
});
