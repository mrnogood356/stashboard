import {
  IntegrationStatus,
  IntegrationType,
  MetadataHydrationState,
} from '@prisma/client';
import { IndexingService } from '../indexing/indexing.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { SabnzbdAdapter } from '../providers/sabnzbd/sabnzbd.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import { AcquisitionService } from './acquisition.service';

function buildIndexedRow(overrides: Record<string, unknown> = {}) {
  return {
    stashId: 'scene-1',
    requestStatus: null,
    requestUpdatedAt: new Date('2026-03-10T00:00:00.000Z'),
    title: 'Title scene-1',
    description: 'Description scene-1',
    imageUrl: 'http://image/scene-1',
    studioId: 'studio-1',
    studioName: 'Studio',
    studioImageUrl: 'http://studio/image',
    performerNames: 'Ann, Bea',
    releaseDate: '2026-03-01',
    duration: 720,
    whisparrMovieId: 44,
    whisparrHasFile: false,
    whisparrQueuePosition: 0,
    whisparrQueueStatus: 'downloading',
    whisparrQueueState: 'downloading',
    whisparrErrorMessage: null,
    stashAvailable: false,
    computedLifecycle: 'DOWNLOADING',
    lifecycleSortOrder: 1,
    metadataHydrationState: MetadataHydrationState.HYDRATED,
    metadataLastSyncedAt: new Date('2026-03-10T00:00:00.000Z'),
    metadataRetryAfterAt: null,
    whisparrLastSyncedAt: new Date('2026-03-10T00:00:00.000Z'),
    stashLastSyncedAt: new Date('2026-03-10T00:00:00.000Z'),
    lastSyncedAt: new Date('2026-03-10T00:00:00.000Z'),
    createdAt: new Date('2026-03-10T00:00:00.000Z'),
    updatedAt: new Date('2026-03-10T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AcquisitionService', () => {
  const findOneMock = jest.fn();
  const getConfiguredCatalogProviderTypeMock = jest.fn();
  const buildSceneViewUrlMock = jest.fn();
  const requestMetadataHydrationForStashIdsMock = jest.fn();
  const toSceneStatusMock = jest.fn();
  const getSceneIndexSummaryMock = jest.fn();
  const sceneIndexFindManyMock = jest.fn();
  const sceneIndexGroupByMock = jest.fn();
  const librarySceneIndexFindManyMock = jest.fn();
  const getQueueDetailsMock = jest.fn();
  const downloadHandoffCountMock = jest.fn();
  const requestImmediateRefreshMock = jest.fn();
  const forgetRequestsMock = jest.fn();
  const findMovieByStashIdMock = jest.fn();
  const searchMoviesMock = jest.fn();
  const deleteMovieMock = jest.fn();
  const integrationConfigFindUniqueMock = jest.fn();
  const sabJobsMock = jest.fn();

  const indexingService = {
    requestMetadataHydrationForStashIds:
      requestMetadataHydrationForStashIdsMock,
    getSceneIndexSummary: getSceneIndexSummaryMock,
    toSceneStatus: toSceneStatusMock,
    requestImmediateRefresh: requestImmediateRefreshMock,
    forgetRequests: forgetRequestsMock,
  } as unknown as IndexingService;

  const integrationsService = {
    findOne: findOneMock,
  } as unknown as IntegrationsService;
  const catalogProviderService = {
    getConfiguredCatalogProviderType: getConfiguredCatalogProviderTypeMock,
  } as unknown as CatalogProviderService;

  const whisparrAdapter = {
    buildSceneViewUrl: buildSceneViewUrlMock,
    findMovieByStashId: findMovieByStashIdMock,
    searchMovies: searchMoviesMock,
    deleteMovie: deleteMovieMock,
    getQueueDetails: getQueueDetailsMock,
  } as unknown as WhisparrAdapter;

  const prismaService = {
    sceneIndex: {
      findMany: sceneIndexFindManyMock,
      groupBy: sceneIndexGroupByMock,
    },
    librarySceneIndex: {
      findMany: librarySceneIndexFindManyMock,
    },
    downloadHandoff: {
      count: downloadHandoffCountMock,
    },
    integrationConfig: {
      findUnique: integrationConfigFindUniqueMock,
    },
  } as unknown as PrismaService;
  const sabnzbdAdapter = { jobs: sabJobsMock } as unknown as SabnzbdAdapter;

  const configuredWhisparrIntegration = {
    enabled: true,
    status: IntegrationStatus.CONFIGURED,
    baseUrl: 'http://whisparr.local',
    apiKey: 'wh-key',
  };

  let service: AcquisitionService;

  beforeEach(() => {
    jest.clearAllMocks();

    service = new AcquisitionService(
      indexingService,
      integrationsService,
      catalogProviderService,
      whisparrAdapter,
      prismaService,
      sabnzbdAdapter,
    );
    // SABnzbd isn't connected unless a test says so.
    integrationConfigFindUniqueMock.mockResolvedValue(null);

    buildSceneViewUrlMock.mockImplementation(
      (baseUrl: string, movieId: number) => `${baseUrl}/movie/${movieId}`,
    );
    toSceneStatusMock.mockImplementation(
      (row: { computedLifecycle: string }) => ({
        state: row.computedLifecycle,
      }),
    );
    findOneMock.mockImplementation((type: IntegrationType) => {
      if (type === IntegrationType.WHISPARR) {
        return configuredWhisparrIntegration;
      }

      throw new Error(`Unexpected integration type: ${type}`);
    });
    getConfiguredCatalogProviderTypeMock.mockResolvedValue('STASHDB');
    librarySceneIndexFindManyMock.mockResolvedValue([]);
    getQueueDetailsMock.mockResolvedValue([]);
    getSceneIndexSummaryMock.mockResolvedValue({
      indexedScenes: 10,
      acquisitionTrackedScenes: 4,
      requestedCount: 1,
      downloadingCount: 1,
      importPendingCount: 1,
      failedCount: 1,
      metadataPendingCount: 0,
      metadataRetryableCount: 0,
      lastIndexWriteAt: new Date('2026-03-10T00:00:00.000Z'),
    });

    sceneIndexFindManyMock.mockResolvedValue([
      buildIndexedRow({
        stashId: 'scene-failed',
        title: 'Title scene-failed',
        computedLifecycle: 'FAILED',
        lifecycleSortOrder: 0,
        whisparrMovieId: 40,
        whisparrQueueStatus: 'failed',
        whisparrQueueState: 'warning',
      }),
      buildIndexedRow({
        stashId: 'scene-downloading',
        title: 'Title scene-downloading',
        computedLifecycle: 'DOWNLOADING',
        lifecycleSortOrder: 1,
        whisparrMovieId: 20,
      }),
    ]);
  });

  it('adds how far along each downloading scene is, from one Whisparr call', async () => {
    getQueueDetailsMock.mockResolvedValue([
      { movieId: 20, size: 1000, sizeLeft: 250, timeLeft: '00:06:10' },
      // A second, slower grab for the same scene loses to the first.
      { movieId: 20, size: 1000, sizeLeft: 900, timeLeft: '01:00:00' },
      // Failed scenes don't get a bar.
      { movieId: 40, size: 1000, sizeLeft: 0, timeLeft: null },
    ]);

    const result = await service.getScenesFeed(1, 2);

    expect(getQueueDetailsMock).toHaveBeenCalledTimes(1);
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('scene-downloading')?.download).toEqual({
      progress: 75,
      timeLeft: '00:06:10',
    });
    expect(byId.get('scene-failed')?.download).toBeNull();
  });

  it('asks SABnzbd itself how far along Whisparr’s download is, when it’s connected', async () => {
    integrationConfigFindUniqueMock.mockResolvedValue({
      enabled: true,
      status: IntegrationStatus.CONFIGURED,
      baseUrl: 'http://sab.local',
      apiKey: 'sab-key',
    });
    // Whisparr last asked SABnzbd a while ago.
    getQueueDetailsMock.mockResolvedValue([
      {
        movieId: 20,
        downloadId: 'SABnzbd_nzo_a',
        size: 1000,
        sizeLeft: 700,
        timeLeft: '00:20:00',
      },
    ]);
    sabJobsMock.mockResolvedValue({
      queue: [],
      history: [{ nzoId: 'SABnzbd_nzo_a', status: 'Completed' }],
    });

    let result = await service.getScenesFeed(1, 2);

    expect(sabJobsMock).toHaveBeenCalledWith(
      { baseUrl: 'http://sab.local', apiKey: 'sab-key' },
      ['SABnzbd_nzo_a'],
    );
    let byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('scene-downloading')?.download).toEqual({
      progress: 100,
      timeLeft: null,
      after: 'downloaded',
    });

    // Still downloading: SABnzbd's own numbers.
    sabJobsMock.mockResolvedValue({
      queue: [
        { nzoId: 'SABnzbd_nzo_a', percentage: 91.6, timeLeft: '0:00:40' },
      ],
      history: [],
    });
    result = await service.getScenesFeed(1, 2);
    byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('scene-downloading')?.download).toEqual({
      progress: 92,
      timeLeft: '0:00:40',
    });

    // SABnzbd can't be asked: Whisparr's numbers, as before.
    sabJobsMock.mockRejectedValue(new Error('SABnzbd is down'));
    result = await service.getScenesFeed(1, 2);
    byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get('scene-downloading')?.download).toEqual({
      progress: 30,
      timeLeft: '00:20:00',
    });
  });

  it('still lists the scenes when Whisparr’s queue can’t be read', async () => {
    getQueueDetailsMock.mockRejectedValue(
      new Error('Failed to reach Whisparr'),
    );

    const result = await service.getScenesFeed(1, 2);

    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.download === null)).toBe(true);
  });

  it('finds requests behind a big import of other scenes', async () => {
    // 500 other scenes Stash got since, then the requested one.
    const others = Array.from({ length: 500 }, (_, index) => ({
      linkedStashId: `other-${index}`,
      localCreatedAt: new Date('2026-10-27T10:00:00.000Z'),
      viewUrl: `http://stash.local/scenes/o${index}`,
    }));
    librarySceneIndexFindManyMock
      .mockResolvedValueOnce(others)
      .mockResolvedValueOnce([
        {
          linkedStashId: 'scene-asked',
          localCreatedAt: new Date('2026-10-20T10:00:00.000Z'),
          viewUrl: 'http://stash.local/scenes/1',
        },
      ]);
    sceneIndexFindManyMock.mockImplementation(
      ({ where }: { where: { stashId?: { in: string[] } } }) =>
        Promise.resolve(
          where.stashId?.in.includes('scene-asked')
            ? [
                buildIndexedRow({
                  stashId: 'scene-asked',
                  computedLifecycle: 'AVAILABLE',
                }),
              ]
            : [],
        ),
    );

    const result = await service.getScenesFeed(1, 24, 'AVAILABLE');

    expect(result.items.map((item) => item.id)).toEqual(['scene-asked']);
    expect(librarySceneIndexFindManyMock).toHaveBeenCalledTimes(2);
    expect(librarySceneIndexFindManyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 500, take: 500 }),
    );
  });

  it('reads on through scenes that arrived at the same moment as the 200th', async () => {
    const at = new Date('2026-10-27T10:00:00.000Z');
    const arrival = (id: string) => ({
      linkedStashId: id,
      localCreatedAt: at,
      viewUrl: `http://stash.local/scenes/${id}`,
    });
    // 500 requested scenes, then one more at the same moment that sorts first.
    const first = Array.from({ length: 500 }, (_, index) =>
      arrival(`z${String(index).padStart(3, '0')}`),
    );
    librarySceneIndexFindManyMock
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([arrival('a000')]);
    sceneIndexFindManyMock.mockImplementation(
      ({ where }: { where: { stashId: { in: string[] } } }) =>
        Promise.resolve(
          where.stashId.in.map((stashId) =>
            buildIndexedRow({ stashId, computedLifecycle: 'AVAILABLE' }),
          ),
        ),
    );

    const result = await service.getScenesFeed(1, 24, 'AVAILABLE');

    expect(result.items[0].id).toBe('a000');
    expect(result.total).toBe(200);
    expect(librarySceneIndexFindManyMock).toHaveBeenCalledTimes(2);
  });

  it('lists requests Stash got in the last two weeks, newest first', async () => {
    librarySceneIndexFindManyMock.mockResolvedValue([
      {
        linkedStashId: 'scene-new',
        localCreatedAt: new Date('2026-10-27T10:00:00.000Z'),
        viewUrl: 'http://stash.local/scenes/9',
      },
      {
        linkedStashId: 'scene-old',
        localCreatedAt: new Date('2026-10-20T10:00:00.000Z'),
        viewUrl: 'http://stash.local/scenes/3',
      },
      // An older copy of the same scene: its newest arrival counts.
      {
        linkedStashId: 'scene-new',
        localCreatedAt: new Date('2026-10-18T10:00:00.000Z'),
        viewUrl: 'http://stash.local/scenes/1',
      },
    ]);
    sceneIndexFindManyMock.mockResolvedValue([
      buildIndexedRow({ stashId: 'scene-old', computedLifecycle: 'AVAILABLE' }),
      buildIndexedRow({ stashId: 'scene-new', computedLifecycle: 'AVAILABLE' }),
    ]);

    const result = await service.getScenesFeed(1, 24, 'AVAILABLE');

    expect(librarySceneIndexFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ linkedStashId: { not: null } }),
        orderBy: [{ localCreatedAt: 'desc' }, { stashSceneId: 'asc' }],
      }),
    );
    expect(sceneIndexFindManyMock).toHaveBeenCalledWith({
      where: {
        stashId: { in: ['scene-new', 'scene-old'] },
        computedLifecycle: 'AVAILABLE',
        OR: [
          { requestStatus: { not: null } },
          { whisparrMovieId: { not: null } },
        ],
      },
    });
    expect(result.total).toBe(2);
    expect(result.countsByLifecycle.AVAILABLE).toBe(2);
    // The list and its tab count come from one lookup.
    expect(librarySceneIndexFindManyMock).toHaveBeenCalledTimes(1);
    expect(
      result.items.map((item) => [item.id, item.addedAt, item.stashViewUrl]),
    ).toEqual([
      ['scene-new', '2026-10-27T10:00:00.000Z', 'http://stash.local/scenes/9'],
      ['scene-old', '2026-10-20T10:00:00.000Z', 'http://stash.local/scenes/3'],
    ]);
  });

  it('counts failed requests and today’s failed downloads for the menu badge', async () => {
    downloadHandoffCountMock.mockResolvedValue(2);

    await expect(service.getAttention()).resolves.toEqual({ failed: 3 });
    expect(downloadHandoffCountMock).toHaveBeenCalledWith({
      where: {
        status: 'failed',
        updatedAt: { gte: expect.any(Date) },
        clearedAt: null,
      },
    });
  });

  it('builds the acquisition feed from the local scene index', async () => {
    const result = await service.getScenesFeed(1, 2);

    expect(result.total).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(result.countsByLifecycle).toEqual({
      REQUESTED: 1,
      DOWNLOADING: 1,
      IMPORT_PENDING: 1,
      FAILED: 1,
      AVAILABLE: 0,
    });
    expect(result.items.map((item) => item.id)).toEqual([
      'scene-failed',
      'scene-downloading',
    ]);
    expect(result.items[0]?.whisparrViewUrl).toBe(
      'http://whisparr.local/movie/40',
    );
    expect(result.items[0]?.source).toBe('STASHDB');
    expect(result.items[0]?.queueStatus).toBe('failed');
    expect(result.items[0]?.queueState).toBe('warning');
    expect(result.items[0]?.errorMessage).toBeNull();
    expect(result.items[0]?.performers).toBe('Ann, Bea');
    expect(sceneIndexFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          computedLifecycle: {
            in: ['REQUESTED', 'DOWNLOADING', 'IMPORT_PENDING', 'FAILED'],
          },
        },
        skip: 0,
        take: 2,
      }),
    );
    expect(getSceneIndexSummaryMock).toHaveBeenCalledTimes(1);
    expect(requestMetadataHydrationForStashIdsMock).not.toHaveBeenCalled();
  });

  it.each([
    ['REQUESTED', 1],
    ['DOWNLOADING', 1],
    ['IMPORT_PENDING', 1],
    ['FAILED', 1],
  ] as const)(
    'filters acquisition feed to %s scenes in the database query',
    async (lifecycle, expectedTotal) => {
      sceneIndexFindManyMock.mockResolvedValue([
        buildIndexedRow({
          stashId: `scene-${lifecycle.toLowerCase()}`,
          computedLifecycle: lifecycle,
        }),
      ]);
      getSceneIndexSummaryMock.mockResolvedValue({
        indexedScenes: 10,
        acquisitionTrackedScenes: 4,
        requestedCount: lifecycle === 'REQUESTED' ? expectedTotal : 1,
        downloadingCount: lifecycle === 'DOWNLOADING' ? expectedTotal : 1,
        importPendingCount: lifecycle === 'IMPORT_PENDING' ? expectedTotal : 1,
        failedCount: lifecycle === 'FAILED' ? expectedTotal : 1,
        metadataPendingCount: 0,
        metadataRetryableCount: 0,
        lastIndexWriteAt: new Date('2026-03-10T00:00:00.000Z'),
      });

      const result = await service.getScenesFeed(1, 25, lifecycle);

      expect(result.total).toBe(expectedTotal);
      expect(sceneIndexFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            computedLifecycle: lifecycle,
          },
        }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.status).toEqual({ state: lifecycle });
    },
  );

  it('schedules metadata hydration only for the requested page window', async () => {
    sceneIndexFindManyMock.mockResolvedValue([
      buildIndexedRow({
        stashId: 'scene-missing-metadata',
        title: null,
        metadataHydrationState: MetadataHydrationState.PENDING,
        metadataLastSyncedAt: null,
        computedLifecycle: 'REQUESTED',
        whisparrMovieId: 99,
      }),
    ]);
    getSceneIndexSummaryMock.mockResolvedValue({
      indexedScenes: 10,
      acquisitionTrackedScenes: 1,
      requestedCount: 1,
      downloadingCount: 0,
      importPendingCount: 0,
      failedCount: 0,
      metadataPendingCount: 1,
      metadataRetryableCount: 0,
      lastIndexWriteAt: new Date('2026-03-10T00:00:00.000Z'),
    });

    const result = await service.getScenesFeed(1, 25, 'REQUESTED');

    expect(requestMetadataHydrationForStashIdsMock).toHaveBeenCalledWith(
      ['scene-missing-metadata'],
      'acquisition-page',
    );
    expect(result.items[0]?.title).toBe('scene-missing-metadata');
  });

  it('marks acquisition scenes with the active FANSDB provider source', async () => {
    getConfiguredCatalogProviderTypeMock.mockResolvedValue('FANSDB');

    const result = await service.getScenesFeed(1, 2);

    expect(result.items.every((item) => item.source === 'FANSDB')).toBe(true);
  });

  it('orders the default list by pipeline status', async () => {
    await service.getScenesFeed(1, 2);

    expect(sceneIndexFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { lifecycleSortOrder: 'asc' },
          { whisparrQueuePosition: 'asc' },
          { requestUpdatedAt: 'desc' },
          { whisparrMovieId: 'asc' },
          { stashId: 'asc' },
        ],
      }),
    );
  });

  it.each([
    ['requested-desc', { requestUpdatedAt: { sort: 'desc', nulls: 'last' } }],
    ['requested-asc', { requestUpdatedAt: { sort: 'asc', nulls: 'last' } }],
    ['released-desc', { releaseDate: { sort: 'desc', nulls: 'last' } }],
    ['released-asc', { releaseDate: { sort: 'asc', nulls: 'last' } }],
    ['title', { title: { sort: 'asc', nulls: 'last' } }],
  ] as const)('sorts by %s', async (sort, firstOrder) => {
    await service.getScenesFeed(1, 2, 'ANY', { sort });

    expect(sceneIndexFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [firstOrder, { stashId: 'asc' }],
      }),
    );
  });

  it('searches title, studio, performers and id, with counts for the matches', async () => {
    sceneIndexGroupByMock.mockResolvedValue([
      { computedLifecycle: 'FAILED', _count: { _all: 2 } },
      { computedLifecycle: 'REQUESTED', _count: { _all: 3 } },
    ]);

    const result = await service.getScenesFeed(1, 2, 'ANY', {
      q: '  blue  Studio ',
    });

    const wordClause = (word: string) => ({
      OR: [
        { title: { contains: word, mode: 'insensitive' } },
        { studioName: { contains: word, mode: 'insensitive' } },
        { performerNames: { contains: word, mode: 'insensitive' } },
        { stashId: { equals: word } },
      ],
    });
    const search = { AND: [wordClause('blue'), wordClause('Studio')] };
    expect(sceneIndexFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              computedLifecycle: {
                in: ['REQUESTED', 'DOWNLOADING', 'IMPORT_PENDING', 'FAILED'],
              },
            },
            search,
          ],
        },
      }),
    );
    expect(getSceneIndexSummaryMock).not.toHaveBeenCalled();
    expect(result.countsByLifecycle).toEqual({
      REQUESTED: 3,
      DOWNLOADING: 0,
      IMPORT_PENDING: 0,
      FAILED: 2,
      AVAILABLE: 0,
    });
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(true);
  });

  it('uses the search counts for the total of one lifecycle', async () => {
    sceneIndexGroupByMock.mockResolvedValue([
      { computedLifecycle: 'FAILED', _count: { _all: 2 } },
      { computedLifecycle: 'REQUESTED', _count: { _all: 3 } },
    ]);

    const result = await service.getScenesFeed(1, 24, 'FAILED', { q: 'x' });

    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('ignores a blank search', async () => {
    await service.getScenesFeed(1, 2, 'ANY', { q: '   ' });

    expect(sceneIndexGroupByMock).not.toHaveBeenCalled();
    expect(getSceneIndexSummaryMock).toHaveBeenCalledTimes(1);
  });

  describe('bulk actions', () => {
    beforeEach(() => {
      requestImmediateRefreshMock.mockResolvedValue(undefined);
      forgetRequestsMock.mockResolvedValue(undefined);
      searchMoviesMock.mockResolvedValue(undefined);
      deleteMovieMock.mockResolvedValue(undefined);
      findMovieByStashIdMock.mockResolvedValue(null);
      sceneIndexFindManyMock.mockResolvedValue([
        { stashId: 'a', title: 'A', whisparrMovieId: 1 },
        { stashId: 'b', title: 'B', whisparrMovieId: null },
        { stashId: 'c', title: 'C', whisparrMovieId: null },
      ]);
    });

    it('searches Whisparr for every scene it has in one command', async () => {
      findMovieByStashIdMock.mockImplementation((stashId: string) =>
        Promise.resolve(
          stashId === 'b' ? { movieId: 2, stashId, hasFile: false } : null,
        ),
      );

      const result = await service.runBulkAction('search', [
        'a',
        ' b ',
        'c',
        'a',
      ]);

      expect(searchMoviesMock).toHaveBeenCalledTimes(1);
      expect(searchMoviesMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://whisparr.local' }),
        [1, 2],
      );
      expect(result).toEqual({
        action: 'search',
        done: 2,
        failed: [
          { id: 'c', title: 'C', reason: 'Whisparr doesn’t have this scene.' },
        ],
      });
      expect(requestImmediateRefreshMock).toHaveBeenCalledWith(
        ['a', 'b'],
        'acquisition-bulk-search',
      );
    });

    it('removes scenes one by one and forgets the ones that went', async () => {
      findMovieByStashIdMock.mockResolvedValue({
        movieId: 3,
        stashId: 'x',
        hasFile: false,
      });
      deleteMovieMock.mockImplementation((_config: unknown, movieId: number) =>
        movieId === 3
          ? Promise.reject(new Error('Whisparr said no.'))
          : Promise.resolve(),
      );
      sceneIndexFindManyMock.mockResolvedValue([
        { stashId: 'a', title: 'A', whisparrMovieId: 1 },
        { stashId: 'b', title: null, whisparrMovieId: null },
      ]);

      const result = await service.runBulkAction('remove', ['a', 'b']);

      expect(deleteMovieMock).toHaveBeenCalledTimes(2);
      expect(forgetRequestsMock).toHaveBeenCalledWith(['a']);
      expect(result).toEqual({
        action: 'remove',
        done: 1,
        failed: [{ id: 'b', title: null, reason: 'Whisparr said no.' }],
      });
    });

    it('still reports removals when forgetting the requests fails', async () => {
      sceneIndexFindManyMock.mockResolvedValue([
        { stashId: 'a', title: 'A', whisparrMovieId: 1 },
      ]);
      forgetRequestsMock.mockRejectedValueOnce(new Error('db down'));

      await expect(service.runBulkAction('remove', ['a'])).resolves.toEqual({
        action: 'remove',
        done: 1,
        failed: [],
      });
    });

    it('does not forget anything when nothing was removed', async () => {
      sceneIndexFindManyMock.mockResolvedValue([
        { stashId: 'a', title: 'A', whisparrMovieId: 1 },
      ]);
      deleteMovieMock.mockRejectedValue(new Error('Whisparr said no.'));

      await service.runBulkAction('remove', ['a']);

      expect(forgetRequestsMock).not.toHaveBeenCalled();
    });

    it('needs Whisparr set up', async () => {
      findOneMock.mockResolvedValue({
        ...configuredWhisparrIntegration,
        enabled: false,
      });

      await expect(service.runBulkAction('search', ['a'])).rejects.toThrow(
        'Set up Whisparr first.',
      );
      expect(searchMoviesMock).not.toHaveBeenCalled();
    });
  });
});
