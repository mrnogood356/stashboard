import { BadGatewayException, Logger } from '@nestjs/common';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { WhisparrAdapter } from './whisparr.adapter';

describe('WhisparrAdapter', () => {
  let adapter: WhisparrAdapter;
  let runtimeHealthService: {
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
  };
  let originalFetch: typeof fetch;
  const fetchMock = jest.fn();

  beforeAll(() => {
    originalFetch = global.fetch;
    Object.assign(global, { fetch: fetchMock });
  });

  afterAll(() => {
    Object.assign(global, { fetch: originalFetch });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeHealthService = {
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    adapter = new WhisparrAdapter(
      runtimeHealthService as unknown as RuntimeHealthService,
    );
  });

  describe('import settings', () => {
    it('reads hardlinks and counts enabled torrent clients', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve(
              url.includes('mediamanagement')
                ? { copyUsingHardlinks: true }
                : [
                    { enable: true, protocol: 'torrent' },
                    { enable: false, protocol: 'torrent' },
                    { enable: true, protocol: 'usenet' },
                  ],
            ),
        }),
      );

      await expect(
        adapter.getImportSettings({ baseUrl: 'http://w', apiKey: 'k' }),
      ).resolves.toEqual({ copyUsingHardlinks: true, torrentClients: 1 });
    });

    it('answers unknown for fields Whisparr doesn’t send', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ something: 'else' }),
      });

      await expect(
        adapter.getImportSettings({ baseUrl: 'http://w', apiKey: 'k' }),
      ).resolves.toEqual({ copyUsingHardlinks: null, torrentClients: null });
    });
  });

  describe('releases', () => {
    it('searches releases for a movie and reads them', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              guid: 'g1',
              indexerId: 3,
              indexer: 'Tracker',
              title: 'Scene.1080p',
              size: 2048,
              quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
              protocol: 'torrent',
              seeders: 12,
              leechers: 1,
              ageHours: 30,
              customFormatScore: 5,
              rejected: false,
              rejections: [],
              languages: [{ name: 'English' }],
            },
            {
              guid: 'g2',
              indexerId: 3,
              title: 'Bad',
              rejected: true,
              rejections: [{ reason: 'Not wanted' }],
            },
            { title: 'no guid' },
          ]),
      });
      const releases = await adapter.searchReleases(
        { baseUrl: 'http://w.local/', apiKey: 'k' },
        9,
      );
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'http://w.local/api/v3/release?movieId=9',
      );
      expect(releases).toHaveLength(2);
      expect(releases[0]).toMatchObject({
        guid: 'g1',
        quality: 'WEBDL-1080p',
        resolution: 1080,
        protocol: 'torrent',
        seeders: 12,
        languages: ['English'],
      });
      expect(releases[1]).toMatchObject({
        rejected: true,
        rejections: ['Not wanted'],
      });
    });

    it('grabs a release by guid and indexer, for the scene it was found for', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      await adapter.grabRelease(
        { baseUrl: 'http://w.local', apiKey: 'k' },
        { guid: 'g1', indexerId: 3 },
        12,
      );
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://w.local/api/v3/release');
      expect(init.method).toBe('POST');
      // Without movieId, Whisparr refuses releases whose name it can't match.
      expect(JSON.parse(String(init.body))).toEqual({
        guid: 'g1',
        indexerId: 3,
        movieId: 12,
      });
    });
  });

  describe('history and queue details', () => {
    it('reads one scene’s history, newest first, in either event style', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              eventType: 'grabbed',
              date: '2026-10-21T11:00:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              data: { indexer: 'NZBgeek', downloadClientName: 'SABnzbd' },
            },
            {
              eventType: 3,
              date: '2026-10-21T11:35:00Z',
              sourceTitle: 'Bright.Summer.Afternoon.1080p',
              data: { importedPath: '/media/Bright/Summer Afternoon.mp4' },
            },
            { eventType: 'downloadFailed' },
          ]),
      });

      const history = await adapter.getMovieHistory(
        { baseUrl: 'http://w.local/', apiKey: 'k' },
        7,
      );

      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'http://w.local/api/v3/history/movie?movieId=7',
      );
      expect(history).toEqual([
        {
          eventType: 'downloadFolderImported',
          date: '2026-10-21T11:35:00Z',
          sourceTitle: 'Bright.Summer.Afternoon.1080p',
          indexer: null,
          downloadClient: null,
          message: null,
          importedPath: '/media/Bright/Summer Afternoon.mp4',
        },
        {
          eventType: 'grabbed',
          date: '2026-10-21T11:00:00Z',
          sourceTitle: 'Bright.Summer.Afternoon.1080p',
          indexer: 'NZBgeek',
          downloadClient: 'SABnzbd',
          message: null,
          importedPath: null,
        },
      ]);
    });

    it('reads the queue with progress, for one scene or all', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              movieId: 7,
              title: 'Bright.Summer.Afternoon.1080p',
              indexer: 'NZBgeek',
              size: 1000,
              sizeleft: 250,
              timeleft: '00:05:00',
              status: 'completed',
              trackedDownloadState: 'importBlocked',
              trackedDownloadStatus: 'warning',
              statusMessages: [
                { title: 'x', messages: ['No files found are eligible'] },
              ],
            },
            { movieId: 8, title: 'Other' },
          ]),
      });

      const config = { baseUrl: 'http://w.local', apiKey: 'k' };
      const [item] = await adapter.getQueueDetails(config, 7);

      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'http://w.local/api/v3/queue/details?movieId=7',
      );
      expect(item).toMatchObject({
        movieId: 7,
        size: 1000,
        sizeLeft: 250,
        timeLeft: '00:05:00',
        trackedDownloadState: 'importBlocked',
        messages: ['No files found are eligible'],
      });
      await expect(adapter.getQueueDetails(config)).resolves.toHaveLength(2);
      expect(String(fetchMock.mock.calls[1][0])).toBe(
        'http://w.local/api/v3/queue/details',
      );
    });
  });

  describe('indexer health', () => {
    it('lists indexers paused after errors and counts the searchable ones', async () => {
      const later = new Date(Date.now() + 3_600_000).toISOString();
      const earlier = new Date(Date.now() - 3_600_000).toISOString();
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                id: 1,
                name: 'NZBgeek',
                enable: true,
                enableInteractiveSearch: true,
              },
              {
                id: 2,
                name: 'Old',
                enable: true,
                enableInteractiveSearch: true,
              },
              { id: 3, name: 'Off', enable: false },
            ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              { indexerId: 1, disabledTill: later },
              { indexerId: 2, disabledTill: earlier },
            ]),
        });

      await expect(
        adapter.getIndexerHealth({ baseUrl: 'http://w.local', apiKey: 'k' }),
      ).resolves.toEqual({
        searchable: 2,
        paused: [{ name: 'NZBgeek', until: later }],
      });
    });

    it('copes with a Whisparr that has no indexer status, and stops asking for it', async () => {
      const indexers = {
        ok: true,
        json: () => Promise.resolve([{ id: 1, name: 'NZBgeek', enable: true }]),
      };
      fetchMock
        .mockResolvedValueOnce(indexers)
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce(indexers);
      const config = { baseUrl: 'http://w.local', apiKey: 'k' };

      await expect(adapter.getIndexerHealth(config)).resolves.toEqual({
        searchable: 1,
        paused: [],
      });
      await adapter.getIndexerHealth(config);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[2][0])).toContain('/api/v3/indexer');
      expect(String(fetchMock.mock.calls[2][0])).not.toContain('indexerstatus');
    });
  });

  describe('manual import', () => {
    it('asks Whisparr what it sees at a path and imports it', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                path: '/m/a.mp4',
                quality: { quality: { id: 3 } },
                languages: [{ id: 1 }],
                rejections: [{ reason: 'Unknown' }],
              },
            ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 42 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: 42, status: 'Completed' }),
        });
      const config = { baseUrl: 'http://w.local', apiKey: 'k' };
      const items = await adapter.getManualImportItems(config, '/m/a.mp4', 5);
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'http://w.local/api/v3/manualimport?folder=%2Fm%2Fa.mp4&movieId=5&filterExistingFiles=false',
      );
      expect(items[0]).toMatchObject({
        path: '/m/a.mp4',
        rejections: ['Unknown'],
      });
      const id = await adapter.startManualImport(
        config,
        [{ item: items[0], movieId: 5 }],
        'move',
      );
      expect(id).toBe(42);
      const body = JSON.parse(
        String((fetchMock.mock.calls[1][1] as RequestInit).body),
      );
      expect(body).toMatchObject({
        name: 'ManualImport',
        importMode: 'move',
        files: [
          { path: '/m/a.mp4', movieId: 5, quality: { quality: { id: 3 } } },
        ],
      });
      expect(await adapter.getCommandStatus(config, 42)).toEqual({
        status: 'completed',
        message: null,
      });
    });
  });

  describe('setMoviePath', () => {
    it('sends the whole scene back with the new path and moveFiles', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              id: 7,
              title: 'T',
              path: '/old',
              monitored: true,
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        });
      await adapter.setMoviePath(
        { baseUrl: 'http://w', apiKey: 'k' },
        7,
        '/new/T',
        '/new',
        true,
      );
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('http://w/api/v3/movie/7?moveFiles=true');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(String(init.body))).toEqual({
        id: 7,
        title: 'T',
        path: '/new/T',
        rootFolderPath: '/new',
        monitored: true,
      });
    });
  });

  describe('findMovieByStashId', () => {
    it('returns null for empty result array', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      });

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toBeNull();
    });

    it('normalizes movie lookup payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              id: 42,
              stashId: 'scene-1',
              hasFile: true,
            },
          ]),
      });

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local/base',
          apiKey: 'secret',
        }),
      ).resolves.toEqual({
        movieId: 42,
        stashId: 'scene-1',
        hasFile: true,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://whisparr.local/base/api/v3/movie?stashId=scene-1',
        expect.objectContaining({
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Api-Key': 'secret',
          },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(runtimeHealthService.recordSuccess).toHaveBeenCalledWith(
        'WHISPARR',
      );
    });

    it('ignores malformed entries', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: null, stashId: 'scene-1', hasFile: true },
            { id: 1, hasFile: true },
            { id: 2, stashId: 'other-scene', hasFile: true },
            { id: 3, stashId: 'scene-1', hasFile: false },
          ]),
      });

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toEqual({
        movieId: 3,
        stashId: 'scene-1',
        hasFile: false,
      });
    });

    it('throws and logs for multiple movie matches', async () => {
      const loggerWarnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 1, stashId: 'scene-1', hasFile: false },
            { id: 2, stashId: 'scene-1', hasFile: true },
          ]),
      });

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);

      expect(loggerWarnSpy).toHaveBeenCalled();
      loggerWarnSpy.mockRestore();
    });

    it('throws BadGatewayException for malformed non-array payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ not: 'an array' }),
      });

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('says why a reply could not be read', async () => {
      fetchMock.mockResolvedValue(
        new Response('<html>Sign in</html>', { status: 200 }),
      );

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local',
        }),
      ).rejects.toThrow(
        `Whisparr replied with something that isn't JSON ("Sign in"). Check its URL.`,
      );
    });

    it('throws BadGatewayException when fetch fails', async () => {
      fetchMock.mockRejectedValue(new Error('network failure'));

      await expect(
        adapter.findMovieByStashId('scene-1', {
          baseUrl: 'http://whisparr.local',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      expect(runtimeHealthService.recordFailure).toHaveBeenCalledWith(
        'WHISPARR',
        expect.any(Error),
      );
    });
  });

  describe('findMovieById', () => {
    it('normalizes movie-by-id payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 42,
            stashId: 'scene-1',
            hasFile: true,
          }),
      });

      await expect(
        adapter.findMovieById(42, {
          baseUrl: 'http://whisparr.local/base',
          apiKey: 'secret',
        }),
      ).resolves.toEqual({
        movieId: 42,
        stashId: 'scene-1',
        hasFile: true,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://whisparr.local/base/api/v3/movie/42',
        expect.objectContaining({
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Api-Key': 'secret',
          },
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('returns null when movie-by-id payload cannot be normalized', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 42,
            hasFile: true,
          }),
      });

      await expect(
        adapter.findMovieById(42, {
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toBeNull();
    });

    it('throws for unexpected movie-by-id payload shape', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['not-an-object']),
      });

      await expect(
        adapter.findMovieById(42, {
          baseUrl: 'http://whisparr.local',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  describe('getQueueSnapshot', () => {
    it('normalizes queue payload with records wrapper and filters malformed entries', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            page: 1,
            pageSize: 10,
            records: [
              {
                movieId: 100,
                status: 'downloading',
                trackedDownloadState: 'downloading',
                trackedDownloadStatus: 'ok',
                errorMessage: null,
              },
              {
                movie: { id: 101 },
                status: 'warning',
                trackedDownloadState: 'ImportPending',
                trackedDownloadStatus: 'Warning',
                errorMessage: 'The download is stalled with no connections',
              },
              {
                movie: {},
                status: 'completed',
                trackedDownloadState: 'Downloading',
              },
              {
                status: 'queued',
                trackedDownloadState: 'Downloading',
              },
            ],
            totalRecords: 4,
          }),
      });

      await expect(
        adapter.getQueueSnapshot({
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toEqual([
        {
          movieId: 100,
          status: 'downloading',
          trackedDownloadState: 'downloading',
          trackedDownloadStatus: 'ok',
          errorMessage: null,
        },
        {
          movieId: 101,
          status: 'warning',
          trackedDownloadState: 'ImportPending',
          trackedDownloadStatus: 'Warning',
          errorMessage: 'The download is stalled with no connections',
        },
      ]);

      expect(fetchMock).toHaveBeenCalledWith(
        'http://whisparr.local/api/v3/queue?page=1&pageSize=50',
        expect.any(Object),
      );
    });

    it('pages through queue until totalRecords is collected', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              page: 1,
              pageSize: 50,
              totalRecords: 3,
              records: [
                {
                  movieId: 200,
                  status: 'downloading',
                  trackedDownloadState: 'downloading',
                  trackedDownloadStatus: 'ok',
                  errorMessage: null,
                },
                {
                  movieId: 201,
                  status: 'completed',
                  trackedDownloadState: 'Importing',
                  trackedDownloadStatus: 'ok',
                  errorMessage: null,
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              page: 2,
              pageSize: 50,
              totalRecords: 3,
              records: [
                {
                  movieId: 202,
                  status: 'warning',
                  trackedDownloadState: 'ImportPending',
                  trackedDownloadStatus: 'ok',
                  errorMessage: 'Temporary provider failure',
                },
              ],
            }),
        });

      await expect(
        adapter.getQueueSnapshot({
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toEqual([
        {
          movieId: 200,
          status: 'downloading',
          trackedDownloadState: 'downloading',
          trackedDownloadStatus: 'ok',
          errorMessage: null,
        },
        {
          movieId: 201,
          status: 'completed',
          trackedDownloadState: 'Importing',
          trackedDownloadStatus: 'ok',
          errorMessage: null,
        },
        {
          movieId: 202,
          status: 'warning',
          trackedDownloadState: 'ImportPending',
          trackedDownloadStatus: 'ok',
          errorMessage: 'Temporary provider failure',
        },
      ]);

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://whisparr.local/api/v3/queue?page=1&pageSize=50',
        expect.any(Object),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'http://whisparr.local/api/v3/queue?page=2&pageSize=50',
        expect.any(Object),
      );
    });
  });

  describe('request workflow methods', () => {
    it('normalizes root folders', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 1, path: '/media/a', accessible: true },
            { id: 2, path: '/media/b', accessible: false },
            { id: 3, accessible: true },
          ]),
      });

      await expect(
        adapter.getRootFolders({
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toEqual([
        { id: 1, path: '/media/a', accessible: true },
        { id: 2, path: '/media/b', accessible: false },
      ]);
    });

    it('normalizes quality profiles', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: 10, name: 'Default' }, { id: 11 }]),
      });

      await expect(
        adapter.getQualityProfiles({
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toEqual([{ id: 10, name: 'Default' }]);
    });

    it('normalizes tags', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 50, label: 'VR' },
            { id: 51, label: '' },
          ]),
      });

      await expect(
        adapter.getTags({
          baseUrl: 'http://whisparr.local',
        }),
      ).resolves.toEqual([{ id: 50, label: 'VR' }]);
    });

    it('submits create movie payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            id: 777,
          }),
      });

      await expect(
        adapter.createMovie(
          {
            title: 'Scene title',
            studio: 'Scene studio',
            foreignId: 'scene-1',
            monitored: true,
            rootFolderPath: '/media/a',
            addOptions: { searchForMovie: true },
            qualityProfileId: 10,
            tags: [50],
          },
          {
            baseUrl: 'http://whisparr.local',
            apiKey: 'secret',
          },
        ),
      ).resolves.toEqual({ movieId: 777 });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://whisparr.local/api/v3/movie',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Api-Key': 'secret',
          },
          body: JSON.stringify({
            title: 'Scene title',
            studio: 'Scene studio',
            foreignId: 'scene-1',
            monitored: true,
            rootFolderPath: '/media/a',
            addOptions: { searchForMovie: true },
            qualityProfileId: 10,
            tags: [50],
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('throws for malformed create movie response payload', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(['unexpected']),
      });

      await expect(
        adapter.createMovie(
          {
            title: 'Scene title',
            studio: 'Scene studio',
            foreignId: 'scene-1',
            monitored: true,
            rootFolderPath: '/media/a',
            addOptions: { searchForMovie: true },
            qualityProfileId: 10,
            tags: [],
          },
          {
            baseUrl: 'http://whisparr.local',
          },
        ),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });
  });

  it('builds scene view URL for deep-linking', () => {
    expect(adapter.buildSceneViewUrl('http://whisparr.local/base/', 1234)).toBe(
      'http://whisparr.local/base/movie/1234',
    );
  });

  describe('setup check', () => {
    const config = { baseUrl: 'http://whisparr.local/', apiKey: 'k' };
    const reply = (body: unknown) => ({
      ok: true,
      json: () => Promise.resolve(body),
    });

    it('reads the version from system status', async () => {
      fetchMock.mockResolvedValue(reply({ version: '3.0.1' }));
      await expect(adapter.getSystemStatus(config)).resolves.toEqual({
        version: '3.0.1',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://whisparr.local/api/v3/system/status',
      );
    });

    it('saves a settings page to its id', async () => {
      fetchMock.mockResolvedValue(reply({}));
      await adapter.updateConfigSection(config, 'mediamanagement', {
        id: 1,
        copyUsingHardlinks: true,
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://whisparr.local/api/v3/config/mediamanagement/1');
      expect(init.method).toBe('PUT');
    });

    it('adds a new connection and updates an existing one', async () => {
      fetchMock.mockResolvedValue(reply({}));
      await adapter.saveNotification(config, { name: 'Stashboard' });
      await adapter.saveNotification(config, { id: 4, name: 'Stashboard' });
      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      expect(calls[0][0]).toBe('http://whisparr.local/api/v3/notification');
      expect(calls[0][1].method).toBe('POST');
      expect(calls[1][0]).toBe('http://whisparr.local/api/v3/notification/4');
      expect(calls[1][1].method).toBe('PUT');
    });

    it('lists connections, ignoring anything that isn’t one', async () => {
      fetchMock.mockResolvedValue(reply([{ id: 1 }, null, 'x']));
      await expect(adapter.listNotifications(config)).resolves.toEqual([
        { id: 1 },
      ]);
    });
  });
});
