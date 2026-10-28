import { BadGatewayException, Logger } from '@nestjs/common';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { StashdbAdapter } from './stashdb.adapter';
import { resetCatalogRateLimit } from './catalog-rate-limit';

describe('StashdbAdapter', () => {
  let adapter: StashdbAdapter;
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
    resetCatalogRateLimit();
    runtimeHealthService = {
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };
    adapter = new StashdbAdapter(
      runtimeHealthService as unknown as RuntimeHealthService,
    );
  });

  it('does not record runtime health failures for setup connectivity checks', async () => {
    fetchMock.mockRejectedValue(new Error('network failure'));

    await expect(
      adapter.testConnection({
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).rejects.toThrow(
      'Failed to reach StashDB provider endpoint: network failure',
    );

    expect(runtimeHealthService.recordFailure).not.toHaveBeenCalled();
    expect(runtimeHealthService.recordSuccess).not.toHaveBeenCalled();
  });

  it('treats a database error on the catalog’s server as that query failing, said once', async () => {
    const message =
      'ERROR: window_agg placeholder should not be executed (SQLSTATE XX000)';
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ message }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const config = { baseUrl: 'http://stashdb.local/graphql' };

    await expect(adapter.searchScenesByText(config, 'a b c')).rejects.toThrow(
      'SQLSTATE',
    );
    await expect(adapter.searchScenesByText(config, 'd e f')).rejects.toThrow(
      'SQLSTATE',
    );

    expect(runtimeHealthService.recordFailure).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([text]) => String(text).includes('MatchSearch')),
    ).toHaveLength(1);
    warn.mockRestore();
  });

  describe('when the catalog’s own search fails', () => {
    const broken = () =>
      new Response(
        JSON.stringify({
          errors: [{ message: 'window_agg placeholder (SQLSTATE XX000)' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    const answer = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        headers: { 'content-type': 'application/json' },
      });
    const sentQueries = () =>
      fetchMock.mock.calls.map(
        ([, init]) =>
          (JSON.parse(String((init as RequestInit).body)) as { query: string })
            .query,
      );
    const config = {
      baseUrl: 'http://stashdb.local',
      page: 1,
      perPage: 2,
      sort: 'DATE' as const,
      text: 'beach day',
    };

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it('asks again without the count, and estimates it', async () => {
      fetchMock.mockResolvedValueOnce(broken()).mockResolvedValueOnce(
        answer({
          queryScenes: {
            scenes: [
              { id: 's1', title: 'One', images: [] },
              { id: 's2', title: 'Two', images: [] },
            ],
          },
        }),
      );

      const result = await adapter.getScenesBySort(config);

      expect(result.scenes.map((scene) => scene.id)).toEqual(['s1', 's2']);
      // A full page: there may be more.
      expect(result.total).toBe(3);
      const [first, second] = sentQueries();
      expect(first).toMatch(/^\s*count\s*$/m);
      expect(second).not.toMatch(/^\s*count\s*$/m);
      expect(runtimeHealthService.recordFailure).not.toHaveBeenCalled();
    });

    it('falls back to its other search when that fails too', async () => {
      fetchMock
        .mockResolvedValueOnce(broken())
        .mockResolvedValueOnce(broken())
        .mockResolvedValueOnce(
          answer({ searchScene: [{ id: 's9', title: 'Nine', images: [] }] }),
        );

      const result = await adapter.getScenesBySort(config);

      expect(result).toMatchObject({ total: 1 });
      expect(result.scenes.map((scene) => scene.id)).toEqual(['s9']);
      expect(sentQueries()[2]).toContain('searchScene(term: $term');
    });

    it('doesn’t fall back while studios narrow the list: that search can’t filter', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(broken()));

      await expect(
        adapter.getScenesBySort({ ...config, studioIds: ['studio-1'] }),
      ).rejects.toThrow('SQLSTATE');

      expect(sentQueries()).toHaveLength(2);
      expect(sentQueries().join('\n')).not.toContain('searchScene(');
    });

    it('finds performers by name without the count too', async () => {
      fetchMock.mockResolvedValueOnce(broken()).mockResolvedValueOnce(
        answer({
          queryPerformers: {
            performers: [{ id: 'p1', name: 'Ana', images: [] }],
          },
        }),
      );

      const result = await adapter.getPerformersFeed({
        baseUrl: 'http://stashdb.local',
        page: 1,
        perPage: 12,
        name: 'ana',
      });

      expect(result).toMatchObject({ total: 1 });
      expect(result.performers.map((performer) => performer.id)).toEqual([
        'p1',
      ]);
    });
  });

  it('waits as long as the catalog asks after a 429, then tries once more', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { searchScene: [] } }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(
      adapter.searchScenesByText({ baseUrl: 'http://stashdb.local' }, 'x'),
    ).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runtimeHealthService.recordFailure).not.toHaveBeenCalled();
  });

  it('gives up straight away when the catalog asks for a long wait, without calling it down', async () => {
    fetchMock.mockResolvedValue(
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(
      adapter.searchScenesByText({ baseUrl: 'http://stashdb.local' }, 'x'),
    ).rejects.toThrow('slow down; try again in 120 seconds');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeHealthService.recordFailure).not.toHaveBeenCalled();
  });

  it('says the same refusal once per catalog, and counts a lost database connection as the catalog down', async () => {
    const answer = (message: string) =>
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ errors: [{ message }] }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    answer('ERROR: window_agg placeholder (SQLSTATE XX000)');

    for (const baseUrl of ['https://stashdb.org', 'https://fansdb.cc']) {
      await expect(
        adapter.searchScenesByText({ baseUrl }, 'a b c'),
      ).rejects.toThrow('SQLSTATE');
    }
    const said = warn.mock.calls
      .map(([text]) => String(text))
      .filter((text) => text.includes('MatchSearch'));
    expect(said).toHaveLength(2);
    expect(said[0]).toContain('stashdb.org');
    expect(said[1]).toContain('fansdb.cc');
    expect(runtimeHealthService.recordFailure).not.toHaveBeenCalled();

    answer('ERROR: terminating connection (SQLSTATE 08006)');
    await expect(
      adapter.searchScenesByText({ baseUrl: 'https://stashdb.org' }, 'd e f'),
    ).rejects.toThrow('08006');
    expect(runtimeHealthService.recordFailure).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves nested Node fetch timeout causes in connectivity errors', async () => {
    const timeout = Object.assign(
      new Error('connect ETIMEDOUT 2606:4700::6810:85e5:443'),
      {
        code: 'ETIMEDOUT',
      },
    );
    const aggregateError = new AggregateError([timeout], 'fetch failed');
    const fetchError = new TypeError('fetch failed', {
      cause: aggregateError,
    });
    fetchMock.mockRejectedValue(fetchError);

    await expect(
      adapter.testConnection({
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).rejects.toThrow(
      'Failed to reach StashDB provider endpoint: fetch failed; ETIMEDOUT connect ETIMEDOUT 2606:4700::6810:85e5:443',
    );
  });

  it('requests studio images and normalizes studio badge URL from the widest image', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 1,
              scenes: [
                {
                  id: 'scene-1',
                  title: 'Scene 1',
                  details: 'Details',
                  date: '2026-03-01',
                  release_date: '2026-03-02',
                  production_date: '2026-03-03',
                  duration: 640,
                  images: [
                    {
                      id: 'img-1',
                      url: 'https://scene-small.jpg',
                      width: 320,
                      height: 180,
                    },
                    {
                      id: 'img-2',
                      url: 'https://scene-large.jpg',
                      width: 1920,
                      height: 1080,
                    },
                  ],
                  studio: {
                    id: 'studio-1',
                    name: 'Studio Name',
                    images: [
                      {
                        id: 'studio-img-1',
                        url: 'https://studio-small.jpg',
                        width: 64,
                        height: 64,
                      },
                      {
                        id: 'studio-img-2',
                        url: 'https://studio-large.jpg',
                        width: 512,
                        height: 512,
                      },
                    ],
                  },
                },
              ],
            },
          },
        }),
    });

    const result = await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'TRENDING',
      direction: 'DESC',
    });

    expect(result).toEqual({
      total: 1,
      scenes: [
        {
          id: 'scene-1',
          title: 'Scene 1',
          details: 'Details',
          imageUrl: 'https://scene-large.jpg',
          studioId: 'studio-1',
          studioName: 'Studio Name',
          studioImageUrl: 'https://studio-large.jpg',
          date: '2026-03-01',
          releaseDate: '2026-03-02',
          productionDate: '2026-03-03',
          duration: 640,
        },
      ],
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('studio');
    expect(requestBody.query).toContain('images');
  });

  it('returns normalized studioImageUrl for scene details from studio images', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScene: {
              id: 'scene-1',
              title: 'Scene 1',
              details: 'Details',
              date: '2026-03-01',
              release_date: '2026-03-02',
              production_date: '2026-03-03',
              duration: 640,
              images: [
                {
                  id: 'img-1',
                  url: 'https://scene-large.jpg',
                  width: 1920,
                  height: 1080,
                },
              ],
              tags: [],
              urls: [],
              performers: [],
              studio: {
                id: 'studio-1',
                name: 'Studio Name',
                is_favorite: false,
                images: [
                  {
                    id: 'studio-img-1',
                    url: 'https://studio-small.jpg',
                    width: 180,
                    height: 120,
                  },
                  {
                    id: 'studio-img-2',
                    url: 'https://studio-wide.png',
                    width: 860,
                    height: 180,
                  },
                ],
              },
            },
          },
        }),
    });

    const result = await adapter.getSceneById('scene-1', {
      baseUrl: 'http://stashdb.local/graphql',
    });

    expect(result).toMatchObject({
      id: 'scene-1',
      studioName: 'Studio Name',
      studioImageUrl: 'https://studio-wide.png',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('findScene');
    expect(requestBody.query).toContain('studio');
    expect(requestBody.query).toContain('images');
  });

  it('opens and lists scenes that have no title', async () => {
    const untitled = {
      id: 'scene-untitled',
      title: null,
      details: null,
      date: '2026-03-01',
      duration: 600,
      images: [],
      tags: [],
      urls: [],
      performers: [],
      studio: null,
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { findScene: untitled } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { queryScenes: { count: 1, scenes: [untitled] } },
        }),
    });

    await expect(
      adapter.getSceneById('scene-untitled', {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toMatchObject({ id: 'scene-untitled', title: 'Untitled scene' });
    await expect(
      adapter.getScenesSortedByDate({
        baseUrl: 'http://stashdb.local/graphql',
        page: 1,
        perPage: 25,
      }),
    ).resolves.toMatchObject({
      total: 1,
      scenes: [{ id: 'scene-untitled', title: 'Untitled scene' }],
    });
  });

  it('batches lightweight scene metadata lookups with GraphQL aliases', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            scene_0: {
              id: 'scene-1',
              title: 'Scene 1',
              details: 'Details 1',
              date: '2026-03-01',
              release_date: '2026-03-02',
              production_date: '2026-03-03',
              duration: 640,
              images: [
                {
                  id: 'img-1',
                  url: 'https://scene-1-large.jpg',
                  width: 1920,
                  height: 1080,
                },
              ],
              studio: {
                id: 'studio-1',
                name: 'Studio One',
                images: [
                  {
                    id: 'studio-1-img',
                    url: 'https://studio-1-large.jpg',
                    width: 512,
                    height: 512,
                  },
                ],
              },
              performers: [
                { as: null, performer: { name: 'Ann' } },
                { as: 'Bee', performer: { name: 'Bea' } },
              ],
            },
            scene_1: {
              id: 'scene-2',
              title: 'Scene 2',
              details: null,
              date: null,
              release_date: null,
              production_date: '2026-04-01',
              duration: 720,
              images: [],
              studio: null,
            },
          },
        }),
    });

    const result = await adapter.getSceneMetadataByIds(['scene-1', 'scene-2'], {
      baseUrl: 'http://stashdb.local/graphql',
    });

    expect(result).toEqual([
      {
        id: 'scene-1',
        title: 'Scene 1',
        details: 'Details 1',
        imageUrl: 'https://scene-1-large.jpg',
        studioId: 'studio-1',
        studioName: 'Studio One',
        studioImageUrl: 'https://studio-1-large.jpg',
        releaseDate: '2026-03-02',
        duration: 640,
        performerNames: ['Ann', 'Bea', 'Bee'],
      },
      {
        id: 'scene-2',
        title: 'Scene 2',
        details: null,
        imageUrl: null,
        studioId: null,
        studioName: null,
        studioImageUrl: null,
        releaseDate: '2026-04-01',
        duration: 720,
        performerNames: [],
      },
    ]);

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: Record<string, string> };

    expect(requestBody.query).toContain('scene_0: findScene(id: $id0)');
    expect(requestBody.query).toContain('scene_1: findScene(id: $id1)');
    // Only performer names, for searching.
    expect(requestBody.query).toContain('performer {');
    expect(requestBody.query).not.toContain('gender');
    expect(requestBody.query).not.toContain('tags');
    expect(requestBody.query).not.toContain('urls');
    expect(requestBody.variables).toEqual({
      id0: 'scene-1',
      id1: 'scene-2',
    });
  });

  it('requests date-sorted scenes for the scenes feed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await expect(
      adapter.getScenesSortedByDate({
        baseUrl: 'http://stashdb.local/graphql',
        page: 1,
        perPage: 25,
      }),
    ).resolves.toEqual({
      total: 0,
      scenes: [],
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('sort: DATE');
    expect(requestBody.query).toContain('direction: DESC');
    expect(runtimeHealthService.recordSuccess).toHaveBeenCalledWith('CATALOG');
  });

  it('passes through selected sort value for scene feeds', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await expect(
      adapter.getScenesBySort({
        baseUrl: 'http://stashdb.local/graphql',
        page: 1,
        perPage: 25,
        sort: 'UPDATED_AT',
      }),
    ).resolves.toEqual({
      total: 0,
      scenes: [],
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('sort: UPDATED_AT');
    expect(requestBody.query).toContain('direction: DESC');
  });

  it('fetches tag ids and names for the scene feed only when asked', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 1,
              scenes: [
                {
                  id: 'scene-1',
                  title: 'Scene 1',
                  tags: [
                    { id: 'tag-anal', name: 'Anal' },
                    { id: null, name: null },
                    { id: 'tag-pov', name: 'POV' },
                  ],
                  performers: [
                    { performer: { id: 'p-1', name: 'Jane' } },
                    { performer: null },
                  ],
                },
              ],
            },
          },
        }),
    });

    const result = await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'TRENDING',
      includeTagNames: true,
    });
    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'TRENDING',
    });

    const [withTags, withoutTags] = fetchMock.mock.calls.map(
      (call) =>
        (
          JSON.parse((call as [string, { body: string }])[1].body) as {
            query: string;
          }
        ).query,
    );
    expect(result.scenes[0].tagNames).toEqual(['Anal', 'POV']);
    expect(result.scenes[0].tagIds).toEqual(['tag-anal', 'tag-pov']);
    expect(result.scenes[0].performers).toEqual([{ id: 'p-1', name: 'Jane' }]);
    expect(withTags).toContain('tags { id name }');
    expect(withTags).toContain('performers { performer { id name } }');
    expect(withoutTags).not.toContain('tags { id name }');
    expect(withoutTags).not.toContain('performers { performer');
  });

  it("loads a scene's fingerprints, most submitted first", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScene: {
              id: 'scene-1',
              title: 'Title',
              date: '2024-01-01',
              release_date: '2024-02-02',
              duration: 1800,
              studio: { name: 'Studio' },
              fingerprints: [
                { hash: 'p', algorithm: 'PHASH', submissions: 2 },
                { hash: 'o', algorithm: 'OSHASH', submissions: 7 },
                { hash: 'x', algorithm: 'SOMETHING', submissions: 9 },
                { hash: null, algorithm: 'MD5', submissions: 9 },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.getSceneFingerprints('scene-1', {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      id: 'scene-1',
      title: 'Title',
      studioName: 'Studio',
      date: '2024-02-02',
      duration: 1800,
      fingerprints: [
        { hash: 'o', algorithm: 'OSHASH', submissions: 7 },
        { hash: 'p', algorithm: 'PHASH', submissions: 2 },
      ],
    });
  });

  it('returns null fingerprints for a scene the catalog does not have', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { findScene: null } }),
    });

    await expect(
      adapter.getSceneFingerprints('missing', {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toBeNull();
  });

  it('records catalog runtime failures when provider requests fail', async () => {
    fetchMock.mockRejectedValue(new Error('network failure'));

    await expect(
      adapter.getScenesBySort({
        baseUrl: 'http://stashdb.local/graphql',
        page: 1,
        perPage: 25,
        sort: 'DATE',
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);

    expect(runtimeHealthService.recordFailure).toHaveBeenCalledWith(
      'CATALOG',
      'Failed to reach StashDB provider endpoint: network failure',
    );
  });

  it('reports a reply that is not JSON as a catalog failure, not a crash', async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 200 }));

    await expect(
      adapter.getScenesBySort({
        baseUrl: 'http://stashdb.local/graphql',
        page: 1,
        perPage: 25,
        sort: 'DATE',
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(runtimeHealthService.recordFailure).toHaveBeenCalledWith(
      'CATALOG',
      `The catalog provider replied with something that isn't JSON ("Not Found"). Check its URL.`,
    );
  });

  it('loads scenes by id for matching, in one request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            s0: {
              id: 'a',
              title: 'Scene A',
              performers: [],
              tags: [],
              urls: [],
            },
            s1: null,
          },
        }),
    });

    const scenes = await adapter.getMatchScenesByIds(
      { baseUrl: 'http://stashdb.local/graphql' },
      ['a', 'missing', 'a'],
    );

    expect(scenes.map((scene) => scene.id)).toEqual(['a']);
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: Record<string, string> };
    expect(body.variables).toEqual({ id0: 'a', id1: 'missing' });
    expect(body.query).toContain('s1: findScene(id: $id1)');
  });

  it('passes through requested scene direction', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'ASC',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('direction: ASC');
  });

  it('maps OR tag mode to INCLUDES and sends selected tag ids', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      tagFilter: {
        tagIds: ['tag-1', 'tag-2'],
        mode: 'OR',
      },
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: { tagIds?: string[] } };

    expect(requestBody.query).toContain('modifier: INCLUDES');
    expect(requestBody.variables.tagIds).toEqual(['tag-1', 'tag-2']);
  });

  it('maps AND tag mode to INCLUDES_ALL', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      tagFilter: {
        tagIds: ['tag-9'],
        mode: 'AND',
      },
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('modifier: INCLUDES_ALL');
  });

  it('omits tags filter when no tag ids are provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      tagFilter: {
        tagIds: [],
        mode: 'OR',
      },
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).not.toContain('tags:');
  });

  it('omits favorites filter when favorites is unset', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).not.toContain('favorites:');
  });

  it('includes favorites: ALL when requested', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      favorites: 'ALL',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('favorites: ALL');
  });

  it('includes favorites: PERFORMER when requested', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      favorites: 'PERFORMER',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('favorites: PERFORMER');
  });

  it('includes favorites: STUDIO when requested', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesBySort({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      favorites: 'STUDIO',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('favorites: STUDIO');
  });

  it('searches tags and normalizes result shape', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryTags: {
              tags: [
                {
                  id: 'tag-1',
                  name: 'Natural',
                  description: 'Natural scenes',
                  aliases: ['Nat', 42],
                },
                {
                  id: 12,
                  name: 'Invalid',
                  description: null,
                  aliases: [],
                },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.searchTags({
        baseUrl: 'http://stashdb.local/graphql',
        query: 'nat',
      }),
    ).resolves.toEqual([
      {
        id: 'tag-1',
        name: 'Natural',
        description: 'Natural scenes',
        aliases: ['Nat'],
      },
    ]);

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: { name?: string } };

    expect(requestBody.query).toContain('queryTags');
    expect(requestBody.variables.name).toBe('nat');
  });

  const body = (call: number) =>
    JSON.parse(
      (fetchMock.mock.calls[call] as [string, { body: string }])[1].body,
    ) as { query: string; variables: Record<string, string> };

  it('looks up many tag names in one request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { t0: { id: 'tag-anal' }, t1: { id: 'tag-pov' } },
        }),
    });

    const found = await adapter.findTagIdsByNames(
      { baseUrl: 'http://stashdb.local/graphql' },
      ['Anal', 'POV'],
    );

    expect(found).toEqual(
      new Map([
        ['anal', 'tag-anal'],
        ['pov', 'tag-pov'],
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body(0).query).toContain('t1: findTagOrAlias(name: $n1)');
    expect(body(0).variables).toEqual({ n0: 'Anal', n1: 'POV' });
  });

  it('searches, in one request, only the names the exact lookup missed', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ data: { t0: { id: 'tag-anal' }, t1: null } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              t0: {
                tags: [
                  { id: 'tag-1', name: 'Accidental Anal', aliases: [] },
                  { id: 'tag-blonde', name: 'Blonde', aliases: [] },
                ],
              },
            },
          }),
      });

    const found = await adapter.findTagIdsByNames(
      { baseUrl: 'http://stashdb.local/graphql' },
      ['Anal', 'blonde'],
    );

    expect(found.get('anal')).toBe('tag-anal');
    expect(found.get('blonde')).toBe('tag-blonde');
    expect(body(1).query).toContain('per_page: 100');
    expect(body(1).variables).toEqual({ n0: 'blonde' });
  });

  it('falls back to the search when the server lacks findTagOrAlias', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [{ message: 'Cannot query field "findTagOrAlias"' }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              t0: { tags: [{ id: 'tag-2', name: 'Anal', aliases: [] }] },
            },
          }),
      });

    const found = await adapter.findTagIdsByNames(
      { baseUrl: 'http://stashdb.local/graphql' },
      ['anal'],
    );

    expect(found.get('anal')).toBe('tag-2');
  });

  it('reports no tag when the catalog has none by that name', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { t0: null } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { t0: { tags: [] } } }),
      });

    const found = await adapter.findTagIdsByNames(
      { baseUrl: 'http://stashdb.local/graphql' },
      ['Nope'],
    );

    expect(found.get('nope')).toBeNull();
  });

  it('checks many tag ids in one request', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { t0: { id: 'tag-1' }, t1: null } }),
    });

    await expect(
      adapter.existingTagIds({ baseUrl: 'http://stashdb.local/graphql' }, [
        'tag-1',
        'tag-2',
      ]),
    ).resolves.toEqual(new Set(['tag-1']));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('queries performers with default NAME sort', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryPerformers: {
              count: 1,
              performers: [
                {
                  id: 'p-1',
                  name: 'Performer One',
                  gender: 'FEMALE',
                  scene_count: 12,
                  is_favorite: true,
                },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.getPerformersFeed({
        baseUrl: 'http://stashdb.local/graphql',
        page: 1,
        perPage: 50,
      }),
    ).resolves.toEqual({
      total: 1,
      performers: [
        {
          id: 'p-1',
          name: 'Performer One',
          gender: 'FEMALE',
          sceneCount: 12,
          isFavorite: true,
          imageUrl: null,
        },
      ],
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('sort: NAME');
    expect(requestBody.query).toContain('direction: ASC');
    expect(requestBody.query).toContain('images');
    expect(requestBody.query).not.toContain('is_favorite: true');
  });

  it('forwards performer feed filters and non-default sort', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryPerformers: {
              count: 0,
              performers: [],
            },
          },
        }),
    });

    await adapter.getPerformersFeed({
      baseUrl: 'http://stashdb.local/graphql',
      page: 2,
      perPage: 50,
      name: 'aj',
      gender: 'FEMALE',
      sort: 'SCENE_COUNT',
      favoritesOnly: true,
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: { name?: string } };

    expect(requestBody.query).toContain('name: $name');
    expect(requestBody.query).toContain('gender: FEMALE');
    expect(requestBody.query).toContain('sort: SCENE_COUNT');
    expect(requestBody.query).toContain('direction: ASC');
    expect(requestBody.query).toContain('is_favorite: true');
    expect(requestBody.variables.name).toBe('aj');
  });

  it('passes through requested performer feed direction', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryPerformers: {
              count: 0,
              performers: [],
            },
          },
        }),
    });

    await adapter.getPerformersFeed({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 50,
      direction: 'DESC',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('direction: DESC');
  });

  it('omits is_favorite filter when favoritesOnly is false', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryPerformers: {
              count: 0,
              performers: [],
            },
          },
        }),
    });

    await adapter.getPerformersFeed({
      baseUrl: 'http://stashdb.local/graphql',
      page: 1,
      perPage: 50,
      favoritesOnly: false,
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).not.toContain('is_favorite: true');
  });

  it('normalizes findPerformer response for performer details', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findPerformer: {
              id: 'p-1',
              name: 'Performer One',
              disambiguation: 'v2',
              aliases: ['Alias'],
              gender: 'FEMALE',
              birth_date: '1990-01-01',
              death_date: null,
              age: 35,
              ethnicity: 'Ethnicity',
              country: 'US',
              eye_color: 'Brown',
              hair_color: 'Black',
              height: '170cm',
              cup_size: 'C',
              band_size: 34,
              waist_size: 24,
              hip_size: 35,
              breast_type: 'NATURAL',
              career_start_year: 2010,
              career_end_year: null,
              deleted: false,
              merged_ids: ['p-old'],
              merged_into_id: null,
              is_favorite: true,
              created: '2024-01-01',
              updated: '2025-01-01',
              images: [
                {
                  id: 'img-1',
                  url: 'https://small.jpg',
                  width: 320,
                  height: 240,
                },
                {
                  id: 'img-2',
                  url: 'https://large.jpg',
                  width: 1024,
                  height: 768,
                },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.getPerformerById('p-1', {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toMatchObject({
      id: 'p-1',
      name: 'Performer One',
      isFavorite: true,
      imageUrl: 'https://large.jpg',
      images: [{ id: 'img-1' }, { id: 'img-2' }],
    });
  });

  it('normalizes findStudio response for studio details', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findStudio: {
              id: 'studio-1',
              name: 'Studio One',
              aliases: ['Alias One'],
              deleted: false,
              is_favorite: true,
              created: '2024-01-01',
              updated: '2024-02-01',
              urls: [
                {
                  url: 'https://stashdb.org/studios/studio-1',
                  type: 'DETAILS',
                  site: {
                    name: 'StashDB',
                    url: 'https://stashdb.org',
                    icon: 'https://stashdb.org/icon.png',
                  },
                },
              ],
              parent: {
                id: 'parent-1',
                name: 'Parent Studio',
                aliases: ['Parent Alias'],
                is_favorite: false,
                urls: [
                  {
                    url: 'https://stashdb.org/studios/parent-1',
                    type: 'DETAILS',
                    site: {
                      name: 'StashDB',
                      url: 'https://stashdb.org',
                      icon: null,
                    },
                  },
                ],
              },
              child_studios: [
                {
                  id: 'child-1',
                  name: 'Child Studio',
                  aliases: [],
                  deleted: false,
                  is_favorite: false,
                  created: '2024-03-01',
                  updated: '2024-03-02',
                  urls: [],
                  images: [
                    {
                      id: 'child-img-1',
                      url: 'https://child-small.jpg',
                      width: 128,
                      height: 128,
                    },
                    {
                      id: 'child-img-2',
                      url: 'https://child-large.jpg',
                      width: 512,
                      height: 256,
                    },
                  ],
                },
              ],
              images: [
                {
                  id: 'studio-img-1',
                  url: 'https://studio-small.jpg',
                  width: 64,
                  height: 64,
                },
                {
                  id: 'studio-img-2',
                  url: 'https://studio-large.jpg',
                  width: 720,
                  height: 400,
                },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.getStudioById('studio-1', {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      id: 'studio-1',
      name: 'Studio One',
      aliases: ['Alias One'],
      deleted: false,
      isFavorite: true,
      createdAt: '2024-01-01',
      updatedAt: '2024-02-01',
      imageUrl: 'https://studio-large.jpg',
      images: [
        {
          id: 'studio-img-1',
          url: 'https://studio-small.jpg',
          width: 64,
          height: 64,
        },
        {
          id: 'studio-img-2',
          url: 'https://studio-large.jpg',
          width: 720,
          height: 400,
        },
      ],
      urls: [
        {
          url: 'https://stashdb.org/studios/studio-1',
          type: 'DETAILS',
          siteName: 'StashDB',
          siteUrl: 'https://stashdb.org',
          siteIcon: 'https://stashdb.org/icon.png',
        },
      ],
      parentStudio: {
        id: 'parent-1',
        name: 'Parent Studio',
        aliases: ['Parent Alias'],
        isFavorite: false,
        urls: [
          {
            url: 'https://stashdb.org/studios/parent-1',
            type: 'DETAILS',
            siteName: 'StashDB',
            siteUrl: 'https://stashdb.org',
            siteIcon: null,
          },
        ],
      },
      childStudios: [
        {
          id: 'child-1',
          name: 'Child Studio',
          aliases: [],
          deleted: false,
          isFavorite: false,
          createdAt: '2024-03-01',
          updatedAt: '2024-03-02',
          imageUrl: 'https://child-large.jpg',
        },
      ],
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: { id: string } };

    expect(requestBody.query).toContain('findStudio');
    expect(requestBody.variables.id).toBe('studio-1');
  });

  it('throws NotFoundException when findStudio returns null', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findStudio: null,
          },
        }),
    });

    await expect(
      adapter.getStudioById('studio-404', {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).rejects.toThrow('Studio studio-404 not found in StashDB.');
  });

  it('normalizes studio search with child studios', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryStudios: {
              studios: [
                {
                  id: 'studio-1',
                  name: 'Network',
                  child_studios: [
                    { id: 'studio-1a', name: 'Child A' },
                    { id: 'studio-1b', name: 'Child B' },
                  ],
                },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.searchStudios('net', { baseUrl: 'http://stashdb.local/graphql' }),
    ).resolves.toEqual([
      {
        id: 'studio-1',
        name: 'Network',
        childStudios: [
          { id: 'studio-1a', name: 'Child A' },
          { id: 'studio-1b', name: 'Child B' },
        ],
      },
    ]);
  });

  it('queries studios feed with sort/name/favorites and normalizes image + children', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryStudios: {
              count: 2,
              studios: [
                {
                  id: 'studio-1',
                  name: 'Studio One',
                  is_favorite: true,
                  parent: {
                    id: 'parent-1',
                    name: 'Parent Studio',
                  },
                  images: [
                    {
                      id: 'studio-img-small',
                      url: 'https://studio-small.jpg',
                      width: 64,
                      height: 64,
                    },
                    {
                      id: 'studio-img-large',
                      url: 'https://studio-large.jpg',
                      width: 480,
                      height: 320,
                    },
                  ],
                  child_studios: [
                    { id: 'child-1', name: 'Child One' },
                    { id: 'child-2', name: 'Child Two' },
                  ],
                },
                {
                  id: 'parent-1',
                  name: 'Parent Studio',
                  is_favorite: false,
                  parent: null,
                  images: [],
                  child_studios: [{ id: 'studio-1', name: 'Studio One' }],
                },
              ],
            },
          },
        }),
    });

    await expect(
      adapter.getStudiosFeed({
        baseUrl: 'http://stashdb.local/graphql',
        page: 2,
        perPage: 25,
        sort: 'UPDATED_AT',
        direction: 'DESC',
        name: 'studio',
        favoritesOnly: true,
      }),
    ).resolves.toEqual({
      total: 2,
      studios: [
        {
          id: 'studio-1',
          name: 'Studio One',
          isFavorite: true,
          imageUrl: 'https://studio-large.jpg',
          parentStudio: { id: 'parent-1', name: 'Parent Studio' },
          childStudios: [
            { id: 'child-1', name: 'Child One' },
            { id: 'child-2', name: 'Child Two' },
          ],
        },
        {
          id: 'parent-1',
          name: 'Parent Studio',
          isFavorite: false,
          imageUrl: null,
          parentStudio: null,
          childStudios: [{ id: 'studio-1', name: 'Studio One' }],
        },
      ],
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as {
      query: string;
      variables: { page: number; perPage: number; name?: string };
    };

    expect(requestBody.query).toContain('queryStudios');
    expect(requestBody.query).toContain('sort: UPDATED_AT');
    expect(requestBody.query).toContain('direction: DESC');
    expect(requestBody.query).toContain('parent {');
    expect(requestBody.query).toContain('is_favorite: true');
    expect(requestBody.variables).toEqual({
      page: 2,
      perPage: 25,
      name: 'studio',
    });
  });

  it('builds performer-scoped scenes query with optional filters', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesForPerformer({
      baseUrl: 'http://stashdb.local/graphql',
      performerId: 'p-1',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      studioIds: ['studio-1'],
      tagIds: ['tag-1', 'tag-2'],
      onlyFavoriteStudios: true,
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string; variables: Record<string, unknown> };

    expect(requestBody.query).toContain(
      'performers: { value: $performerId, modifier: INCLUDES }',
    );
    expect(requestBody.query).toContain('direction: DESC');
    expect(requestBody.query).toContain(
      'studios: { value: $studioIds, modifier: INCLUDES }',
    );
    expect(requestBody.query).toContain(
      'tags: { value: $tagIds, modifier: INCLUDES }',
    );
    expect(requestBody.query).toContain('favorites: STUDIO');
    expect(requestBody.variables.performerId).toEqual(['p-1']);
    expect(requestBody.variables.studioIds).toEqual(['studio-1']);
    expect(requestBody.variables.tagIds).toEqual(['tag-1', 'tag-2']);
  });

  it('omits optional performer-scoped scene filters when unset', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesForPerformer({
      baseUrl: 'http://stashdb.local/graphql',
      performerId: 'p-1',
      page: 1,
      perPage: 25,
      sort: 'DATE',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).not.toContain('studios:');
    expect(requestBody.query).not.toContain('tags:');
    expect(requestBody.query).not.toContain('favorites: STUDIO');
    expect(requestBody.query).toContain('direction: DESC');
  });

  it('passes through requested performer-scenes direction', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            queryScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    });

    await adapter.getScenesForPerformer({
      baseUrl: 'http://stashdb.local/graphql',
      performerId: 'p-1',
      page: 1,
      perPage: 25,
      sort: 'DATE',
      direction: 'ASC',
    });

    const requestBody = JSON.parse(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { query: string };

    expect(requestBody.query).toContain('direction: ASC');
  });

  it('favorites performer successfully', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            favoritePerformer: true,
          },
        }),
    });

    await expect(
      adapter.favoritePerformer('performer-1', true, {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      favorited: true,
      alreadyFavorited: false,
    });
  });

  it('treats performer duplicate favorite as idempotent success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: null,
          errors: [
            {
              message:
                'ERROR: duplicate key value violates unique constraint "performer_favorites_unique_idx" (SQLSTATE 23505)',
              path: ['favoritePerformer'],
            },
          ],
        }),
    });

    await expect(
      adapter.favoritePerformer('performer-1', true, {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      favorited: true,
      alreadyFavorited: true,
    });
  });

  it('favorites studio successfully', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            favoriteStudio: true,
          },
        }),
    });

    await expect(
      adapter.favoriteStudio('studio-1', true, {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      favorited: true,
      alreadyFavorited: false,
    });
  });

  it('treats studio duplicate favorite as idempotent success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: null,
          errors: [
            {
              message:
                'ERROR: duplicate key value violates unique constraint "studio_favorites_unique_idx" (SQLSTATE 23505)',
              path: ['favoriteStudio'],
            },
          ],
        }),
    });

    await expect(
      adapter.favoriteStudio('studio-1', true, {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      favorited: true,
      alreadyFavorited: true,
    });
  });

  it('unfavorites performer successfully', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            favoritePerformer: true,
          },
        }),
    });

    await expect(
      adapter.favoritePerformer('performer-1', false, {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      favorited: false,
      alreadyFavorited: false,
    });
  });

  it('unfavorites studio successfully', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            favoriteStudio: true,
          },
        }),
    });

    await expect(
      adapter.favoriteStudio('studio-1', false, {
        baseUrl: 'http://stashdb.local/graphql',
      }),
    ).resolves.toEqual({
      favorited: false,
      alreadyFavorited: false,
    });
  });
});
