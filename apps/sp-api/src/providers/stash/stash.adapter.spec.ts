import { BadGatewayException } from '@nestjs/common';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { StashAdapter } from './stash.adapter';

describe('StashAdapter', () => {
  let adapter: StashAdapter;
  let runtimeHealthService: {
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
  };
  let originalFetch: typeof fetch;
  const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();

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
    adapter = new StashAdapter(
      runtimeHealthService as unknown as RuntimeHealthService,
    );
  });

  it('returns empty list when there are no matching scenes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toEqual([]);
  });

  it('ORs the criteria for scene copies and skips scenes without a file', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              scenes: [
                {
                  id: '12',
                  title: '',
                  date: '2024-05-01',
                  paths: {
                    screenshot: 'http://stash.local/scene/12/screenshot?t=99',
                  },
                  studio: { name: 'Studio' },
                  files: [{ path: '/library/a.mp4', duration: 1801.5 }],
                },
                { id: '13', title: 'No file', files: [] },
              ],
            },
          },
        }),
    } as Response);

    const copies = await adapter.findSceneCopies(
      { baseUrl: 'http://stash.local' },
      [
        { oshash: { value: 'a', modifier: 'EQUALS' } },
        { checksum: { value: 'b', modifier: 'EQUALS' } },
        { oshash: { value: 'c', modifier: 'EQUALS' } },
      ],
      3,
    );

    expect(copies).toEqual([
      {
        id: '12',
        title: null,
        date: '2024-05-01',
        studioName: 'Studio',
        path: '/library/a.mp4',
        duration: 1801.5,
        screenshotVersion: expect.any(String),
      },
    ]);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { variables: Record<string, unknown> };
    expect(body.variables).toEqual({
      filter: { per_page: 3 },
      scene_filter: {
        oshash: { value: 'a', modifier: 'EQUALS' },
        OR: {
          checksum: { value: 'b', modifier: 'EQUALS' },
          OR: { oshash: { value: 'c', modifier: 'EQUALS' } },
        },
      },
    });
    // A failed check never marks Stash as down.
    expect(runtimeHealthService.recordSuccess).not.toHaveBeenCalled();
  });

  it('asks Stash nothing for scene copies without criteria', async () => {
    await expect(
      adapter.findSceneCopies({ baseUrl: 'http://stash.local' }, []),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves out scenes linked to the id that have no file', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 2,
              scenes: [{ id: '3030', files: [] }, { id: '3031' }],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toEqual([]);
  });

  it('returns normalized scene links sorted by highest resolution', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 2,
              scenes: [
                {
                  id: '3030',
                  files: [{ width: 1920, height: 1080 }],
                },
                {
                  id: '3027',
                  files: [{ width: 3840, height: 2160 }],
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local/base/',
        apiKey: 'secret',
      }),
    ).resolves.toEqual([
      {
        id: '3027',
        width: 3840,
        height: 2160,
        viewUrl: 'http://stash.local/base/scenes/3027',
        label: '2160p',
      },
      {
        id: '3030',
        width: 1920,
        height: 1080,
        viewUrl: 'http://stash.local/base/scenes/3030',
        label: '1080p',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://stash.local/base/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ApiKey: 'secret',
        },
        signal: expect.any(AbortSignal),
      }),
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(String(init?.body));
    expect(body.variables).toEqual({
      sceneFilter: {
        stash_id_endpoint: {
          modifier: 'EQUALS',
          stash_id: 'stash-1',
        },
      },
    });
    expect(runtimeHealthService.recordSuccess).toHaveBeenCalledWith('STASH');
  });

  it('filters scene links to the requested catalog provider', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 2,
              scenes: [
                {
                  id: '3030',
                  stash_ids: [
                    {
                      endpoint: 'https://fansdb.cc/graphql',
                      stash_id: 'scene-1',
                    },
                  ],
                  files: [{ width: 1920, height: 1080 }],
                },
                {
                  id: '3027',
                  stash_ids: [
                    {
                      endpoint: 'https://stashdb.org/graphql',
                      stash_id: 'scene-1',
                    },
                  ],
                  files: [{ width: 3840, height: 2160 }],
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.findScenesByStashId(
        'scene-1',
        {
          baseUrl: 'http://stash.local',
        },
        {
          providerKey: 'STASHDB',
        },
      ),
    ).resolves.toEqual([
      {
        id: '3027',
        width: 3840,
        height: 2160,
        viewUrl: 'http://stash.local/scenes/3027',
        label: '2160p',
      },
    ]);
  });

  it('falls back to Scene #id label when file dimensions are missing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 1,
              scenes: [
                {
                  id: '3027',
                  files: [{ width: null, height: null }, {}],
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toEqual([
      {
        id: '3027',
        width: null,
        height: null,
        viewUrl: 'http://stash.local/scenes/3027',
        label: 'Scene #3027',
      },
    ]);
  });

  it('ignores malformed scene entries', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 3,
              scenes: [
                { id: 1, files: [] },
                { id: '', files: [] },
                { id: '3040', files: [{ width: 1280, height: 720 }] },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toEqual([
      {
        id: '3040',
        width: 1280,
        height: 720,
        viewUrl: 'http://stash.local/scenes/3040',
        label: '720p',
      },
    ]);
  });

  it('adds Stash-local favorite overlays to stashId matching when requested', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    } as Response);

    await adapter.findScenesByStashId(
      'stash-1',
      { baseUrl: 'http://stash.local' },
      {
        favoritePerformersOnly: true,
        favoriteStudiosOnly: false,
        favoriteTagsOnly: true,
      },
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.variables.sceneFilter).toEqual({
      stash_id_endpoint: {
        modifier: 'EQUALS',
        stash_id: 'stash-1',
      },
      performers_filter: {
        filter_favorites: true,
      },
      tags_filter: {
        favorite: true,
      },
    });
  });

  it('throws on malformed GraphQL payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    } as Response);

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toEqual([]);
  });

  it('scans only the given folders, with Stash’s own scan settings', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { metadataScan: '41' } })),
    );

    await expect(
      adapter.scanLibraryFolders({ baseUrl: 'http://stash.local' }, [
        '/data/scenes/A/',
        '/data/scenes/A',
        '/data/scenes/B',
      ]),
    ).resolves.toBe('41');

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      variables: unknown;
    };
    expect(body.variables).toEqual({
      input: { paths: ['/data/scenes/A', '/data/scenes/B'] },
    });
  });

  describe('queuing a job Stashboard already queued', () => {
    const config = { baseUrl: 'http://stash.local' };
    let nextJob: number;
    let queue: Array<{ id: string; status: string }>;
    const mutations = () =>
      fetchMock.mock.calls.filter(([, init]) =>
        String(init?.body).includes('mutation'),
      ).length;

    beforeEach(() => {
      nextJob = 50;
      queue = [];
      fetchMock.mockImplementation((_url, init) => {
        const body = String(init?.body);
        if (body.includes('jobQueue')) {
          return Promise.resolve(
            new Response(JSON.stringify({ data: { jobQueue: queue } })),
          );
        }
        const id = String((nextJob += 1));
        const field = body.includes('metadataGenerate')
          ? 'metadataGenerate'
          : 'metadataScan';
        return Promise.resolve(
          new Response(JSON.stringify({ data: { [field]: id } })),
        );
      });
    });

    it('gets the waiting scan of the same folder back instead of another', async () => {
      const first = await adapter.scanLibraryFolders(config, ['/data/a']);
      queue = [{ id: first!, status: 'READY' }];
      await expect(
        adapter.scanLibraryFolders(config, ['/data/a/']),
      ).resolves.toBe(first);
      expect(mutations()).toBe(1);
    });

    it('queues another once the first has started, as it may have passed the folder', async () => {
      const first = await adapter.scanLibraryFolders(config, ['/data/a']);
      queue = [{ id: first!, status: 'RUNNING' }];
      const second = await adapter.scanLibraryFolders(config, ['/data/a']);
      expect(second).not.toBe(first);
      expect(mutations()).toBe(2);
    });

    it('lets a waiting full scan cover a folder scan', async () => {
      const full = await adapter.startLibraryTask(config, 'scan');
      queue = [{ id: full!, status: 'READY' }];
      await expect(
        adapter.scanLibraryFolders(config, ['/data/b']),
      ).resolves.toBe(full);
      expect(mutations()).toBe(1);
    });

    it('keeps different scenes’ previews apart', async () => {
      const one = await adapter.startLibraryTask(config, 'generate', ['1']);
      queue = [{ id: one!, status: 'READY' }];
      await expect(
        adapter.startLibraryTask(config, 'generate', ['1']),
      ).resolves.toBe(one);
      await expect(
        adapter.startLibraryTask(config, 'generate', ['2']),
      ).resolves.not.toBe(one);
      expect(mutations()).toBe(2);
    });
  });

  it('throws BadGatewayException when provider request fails', async () => {
    fetchMock.mockRejectedValue(new Error('network failure'));

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(runtimeHealthService.recordFailure).toHaveBeenCalledWith(
      'STASH',
      expect.any(Error),
    );
  });

  it('reports a reply that is not JSON as a provider failure, not a crash', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html><title>Authelia</title></html>', { status: 200 }),
    );

    await expect(
      adapter.findScenesByStashId('stash-1', {
        baseUrl: 'http://stash.local',
      }),
    ).rejects.toThrow(
      new BadGatewayException(
        `Stash replied with something that isn't JSON ("Authelia"). Check its URL.`,
      ),
    );
    expect(runtimeHealthService.recordFailure).toHaveBeenCalledWith(
      'STASH',
      `Stash replied with something that isn't JSON ("Authelia"). Check its URL.`,
    );
  });

  it('keeps an error page out of the error message', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        `<html><body>${'<p>Bad gateway</p>'.repeat(500)}</body></html>`,
        {
          status: 502,
        },
      ),
    );

    const error = (await adapter
      .findScenesByStashId('stash-1', { baseUrl: 'http://stash.local' })
      .catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error.message).toMatch(/^Stash provider returned 502: Bad gateway/);
    expect(error.message).not.toContain('<');
    expect(error.message.length).toBeLessThan(250);
  });

  it('queries local scenes using created_at descending for recent library rails', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 1,
              scenes: [
                {
                  id: '411',
                  title: 'Fresh Library Scene',
                  details: 'Recently scanned into the local library.',
                  date: '2026-03-24',
                  paths: { screenshot: 'http://stash.local/images/411.jpg' },
                  studio: {
                    id: 'studio-1',
                    name: 'Archive',
                    image_path: 'http://stash.local/studios/archive.jpg',
                  },
                  files: [{ width: 1920, height: 1080, duration: 1800 }],
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.getLocalSceneFeed(
        {
          baseUrl: 'http://stash.local',
          apiKey: 'secret',
        },
        {
          page: 1,
          perPage: 16,
          sort: 'CREATED_AT',
          direction: 'DESC',
        },
      ),
    ).resolves.toEqual({
      total: 1,
      items: [
        {
          id: '411',
          title: 'Fresh Library Scene',
          description: 'Recently scanned into the local library.',
          imageUrl: 'http://stash.local/images/411.jpg',
          cardImageUrl: 'http://stash.local/images/411.jpg',
          studioId: 'studio-1',
          studio: 'Archive',
          studioImageUrl: 'http://stash.local/studios/archive.jpg',
          releaseDate: '2026-03-24',
          duration: 1800,
          viewUrl: 'http://stash.local/scenes/411',
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(String(init?.body));
    expect(body.variables).toMatchObject({
      filter: {
        page: 1,
        per_page: 16,
        sort: 'created_at',
        direction: 'DESC',
      },
    });
    expect(body.variables.sceneFilter).toBeUndefined();
    expect(String(body.query)).toContain(
      'findScenes(filter: $filter, scene_filter: $sceneFilter)',
    );
    expect(String(body.query)).toContain('paths');
  });

  it('returns rich local-library projection pages for background indexing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 2,
              scenes: [
                {
                  id: '411',
                  title: 'Fresh Library Scene',
                  details: 'Already local.',
                  date: '2026-03-24',
                  created_at: '2026-03-23T11:00:00.000Z',
                  updated_at: '2026-03-24T12:00:00.000Z',
                  stash_ids: [
                    {
                      endpoint: 'https://stashdb.org/graphql',
                      stash_id: 'stash-411',
                    },
                    {
                      endpoint: 'https://fansdb.cc/graphql',
                      stash_id: 'fans-411',
                    },
                    {
                      endpoint: 'https://example.invalid/graphql',
                      stash_id: 'ignored-411',
                    },
                  ],
                  studio: {
                    id: 'studio-1',
                    name: 'Archive',
                    image_path: 'http://stash.local/studios/archive.jpg',
                    favorite: true,
                  },
                  performers: [
                    {
                      id: 'performer-1',
                      name: 'Performer One',
                      favorite: true,
                    },
                  ],
                  tags: [
                    {
                      id: 'tag-1',
                      name: 'Tag One',
                      favorite: false,
                    },
                    {
                      id: 'tag-2',
                      name: 'Tag Two',
                      favorite: true,
                    },
                  ],
                  files: [{ duration: 1800 }],
                  paths: {
                    screenshot: 'http://stash.local/images/411.jpg',
                  },
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.getLocalLibraryScenePage(
        {
          baseUrl: 'http://stash.local',
          apiKey: 'secret',
        },
        {
          page: 1,
          perPage: 100,
        },
        'STASHDB',
      ),
    ).resolves.toEqual({
      total: 2,
      page: 1,
      perPage: 100,
      hasMore: false,
      items: [
        {
          id: '411',
          activeCatalogSceneId: 'stash-411',
          hasFile: true,
          linkedCatalogRefs: ['STASHDB|stash-411', 'FANSDB|fans-411'],
          title: 'Fresh Library Scene',
          description: 'Already local.',
          imageUrl: 'http://stash.local/images/411.jpg',
          studioId: 'studio-1',
          studio: 'Archive',
          studioImageUrl: 'http://stash.local/studios/archive.jpg',
          performerIds: ['performer-1'],
          performerNames: ['Performer One'],
          tagIds: ['tag-1', 'tag-2'],
          tagNames: ['Tag One', 'Tag Two'],
          releaseDate: '2026-03-24',
          duration: 1800,
          viewUrl: 'http://stash.local/scenes/411',
          createdAt: new Date('2026-03-23T11:00:00.000Z'),
          updatedAt: new Date('2026-03-24T12:00:00.000Z'),
          hasFavoritePerformer: true,
          favoriteStudio: true,
          hasFavoriteTag: true,
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.variables).toEqual({
      filter: {
        page: 1,
        per_page: 100,
        sort: 'created_at',
        direction: 'ASC',
      },
    });
    expect(String(body.query)).toContain('performers');
    expect(String(body.query)).toContain('tags');
    expect(String(body.query)).toContain('created_at');
    expect(String(body.query)).toContain('updated_at');
  });

  it('fingerprints the library from its size and most recently changed scene', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 1532,
              scenes: [{ id: '88', updated_at: '2026-10-28T19:00:00Z' }],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.getLibraryChangeMarker({
        baseUrl: 'http://stash.local',
        apiKey: 'secret',
      }),
    ).resolves.toBe('1532|88|2026-10-28T19:00:00Z');

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      variables: { filter: Record<string, unknown> };
    };
    expect(body.variables.filter).toEqual({
      page: 1,
      per_page: 1,
      sort: 'updated_at',
      direction: 'DESC',
    });
  });

  it('selects the active-provider catalog id without discarding other provider refs', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 1,
              scenes: [
                {
                  id: '411',
                  title: 'Fresh Library Scene',
                  details: 'Already local.',
                  date: '2026-03-24',
                  created_at: '2026-03-23T11:00:00.000Z',
                  updated_at: '2026-03-24T12:00:00.000Z',
                  stash_ids: [
                    {
                      endpoint: 'https://stashdb.org/graphql',
                      stash_id: 'stash-411',
                    },
                    {
                      endpoint: 'https://fansdb.cc/graphql',
                      stash_id: 'fans-411',
                    },
                  ],
                  studio: null,
                  performers: [],
                  tags: [],
                  files: [],
                  paths: {
                    screenshot: 'http://stash.local/images/411.jpg',
                  },
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.getLocalLibraryScenePage(
        {
          baseUrl: 'http://stash.local',
          apiKey: 'secret',
        },
        {
          page: 1,
          perPage: 100,
        },
        'FANSDB',
      ),
    ).resolves.toEqual({
      total: 1,
      page: 1,
      perPage: 100,
      hasMore: false,
      items: [
        expect.objectContaining({
          id: '411',
          activeCatalogSceneId: 'fans-411',
          hasFile: false,
          linkedCatalogRefs: ['STASHDB|stash-411', 'FANSDB|fans-411'],
        }),
      ],
    });
  });

  it('supports updated_at and title local scene feed sorts', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    } as Response);

    await adapter.getLocalSceneFeed(
      { baseUrl: 'http://stash.local' },
      { page: 1, perPage: 8, sort: 'UPDATED_AT', direction: 'ASC' },
    );

    let [, init] = fetchMock.mock.calls[0] ?? [];
    let body = JSON.parse(String(init?.body));
    expect(body.variables.filter).toMatchObject({
      sort: 'updated_at',
      direction: 'ASC',
    });

    fetchMock.mockClear();

    await adapter.getLocalSceneFeed(
      { baseUrl: 'http://stash.local' },
      { page: 2, perPage: 8, sort: 'TITLE', direction: 'DESC' },
    );

    [, init] = fetchMock.mock.calls[0] ?? [];
    body = JSON.parse(String(init?.body));
    expect(body.variables.filter).toMatchObject({
      page: 2,
      per_page: 8,
      sort: 'title',
      direction: 'DESC',
    });
  });

  it('adds title, tag, studio, and provider-scoped favorite filters to the local scene feed query', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    } as Response);

    await adapter.getLocalSceneFeed(
      { baseUrl: 'http://stash.local' },
      {
        page: 1,
        perPage: 10,
        sort: 'UPDATED_AT',
        direction: 'ASC',
        titleQuery: ' anthology ',
        tagIds: ['tag-1', 'tag-1', 'tag-2'],
        tagMode: 'AND',
        studioIds: ['studio-1', 'studio-1', 'studio-2'],
        favoritePerformersOnly: true,
        favoriteStudiosOnly: true,
        favoriteTagsOnly: true,
      },
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.variables.sceneFilter).toEqual({
      title: {
        value: 'anthology',
        modifier: 'INCLUDES',
      },
      tags: {
        value: ['tag-1', 'tag-2'],
        modifier: 'INCLUDES_ALL',
      },
      studios: {
        value: ['studio-1', 'studio-2'],
        modifier: 'INCLUDES',
      },
      performers_filter: {
        filter_favorites: true,
      },
      studios_filter: {
        favorite: true,
      },
      tags_filter: {
        favorite: true,
      },
    });
  });

  it('maps stash tag mode OR to INCLUDES and omits scene_filter when unset', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 0,
              scenes: [],
            },
          },
        }),
    } as Response);

    await adapter.getLocalSceneFeed(
      { baseUrl: 'http://stash.local' },
      {
        page: 1,
        perPage: 5,
        sort: 'CREATED_AT',
        direction: 'DESC',
      },
    );

    let [, init] = fetchMock.mock.calls[0] ?? [];
    let body = JSON.parse(String(init?.body));
    expect(body.variables).toMatchObject({
      filter: {
        page: 1,
        per_page: 5,
        sort: 'created_at',
        direction: 'DESC',
      },
    });
    expect(body.variables.sceneFilter).toBeUndefined();

    fetchMock.mockClear();

    await adapter.getLocalSceneFeed(
      { baseUrl: 'http://stash.local' },
      {
        page: 1,
        perPage: 5,
        sort: 'CREATED_AT',
        direction: 'DESC',
        tagIds: ['tag-1'],
        tagMode: 'OR',
      },
    );

    [, init] = fetchMock.mock.calls[0] ?? [];
    body = JSON.parse(String(init?.body));
    expect(body.variables.sceneFilter).toEqual({
      tags: {
        value: ['tag-1'],
        modifier: 'INCLUDES',
      },
    });
  });

  it('ignores malformed local scene entries and falls back cleanly when fields are missing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              count: 3,
              scenes: [
                { id: '' },
                { id: 9 },
                {
                  id: '812',
                  title: null,
                  details: '',
                  date: null,
                  files: [{ duration: null }, { width: 1280, height: 720 }],
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.getLocalSceneFeed(
        { baseUrl: 'http://stash.local/base' },
        { page: 1, perPage: 12, sort: 'CREATED_AT', direction: 'DESC' },
      ),
    ).resolves.toEqual({
      total: 3,
      items: [
        {
          id: '812',
          title: 'Scene #812',
          description: null,
          imageUrl: null,
          cardImageUrl: null,
          studioId: null,
          studio: null,
          studioImageUrl: null,
          releaseDate: null,
          duration: null,
          viewUrl: 'http://stash.local/base/scenes/812',
        },
      ],
    });
  });

  it('opens a protected scene screenshot with the configured ApiKey header', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findScene: {
                id: '411',
                paths: {
                  screenshot: 'http://stash.local/images/411.jpg',
                },
              },
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=300',
          'content-length': '12',
        }),
        arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      } as Response);

    const result = await adapter.openSceneScreenshot('411', {
      baseUrl: 'http://stash.local',
      apiKey: 'secret',
    });

    expect(result).toMatchObject({
      contentType: 'image/jpeg',
      cacheControl: 'public, max-age=300',
      contentLength: '3',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://stash.local/images/411.jpg',
      expect.objectContaining({
        headers: { ApiKey: 'secret' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('opens a protected studio logo and keeps asset requests on the configured origin', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findStudio: {
                id: 'studio-1',
                image_path: 'http://stash.local/studios/archive.jpg',
              },
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: () => Promise.resolve(new Uint8Array([4, 5, 6]).buffer),
      } as Response);

    await expect(
      adapter.openStudioLogo('studio-1', {
        baseUrl: 'http://stash.local/base',
        apiKey: null,
      }),
    ).resolves.toMatchObject({
      contentType: 'image/png',
    });

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findStudio: {
                id: 'studio-1',
                image_path: 'http://localhost:9999/studio/1/image?t=123',
              },
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
      } as Response);

    await expect(
      adapter.openStudioLogo('studio-1', {
        baseUrl: 'http://192.168.1.50:9999',
        apiKey: 'secret',
      }),
    ).resolves.toMatchObject({ contentType: 'image/png' });

    // The API key is only ever sent to the configured Stash origin.
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://192.168.1.50:9999/studio/1/image?t=123',
      expect.objectContaining({ headers: { ApiKey: 'secret' } }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('localhost'),
      expect.anything(),
    );
  });

  it('returns null for missing protected assets or invalid ids', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findScene: {
                id: '411',
                paths: {
                  screenshot: 'http://stash.local/images/411.jpg',
                },
              },
            },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        body: null,
      } as Response);

    await expect(
      adapter.openSceneScreenshot('411', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toBeNull();

    fetchMock.mockClear();

    await expect(
      adapter.openStudioLogo('../bad-id', {
        baseUrl: 'http://stash.local',
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes stash local tag search results', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findTags: {
              tags: [
                { id: '2', name: 'Archive' },
                { id: '1', name: ' Anthology ' },
                { id: '', name: 'Bad' },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.searchTags('archive', { baseUrl: 'http://stash.local' }),
    ).resolves.toEqual([
      { id: '1', name: 'Anthology' },
      { id: '2', name: 'Archive' },
    ]);
  });

  it('normalizes stash local studio search results into parent groups', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findStudios: {
              studios: [
                {
                  id: 'network-1',
                  name: 'North Network',
                  child_studios: [
                    { id: 'child-2', name: 'Bravo' },
                    { id: 'child-1', name: 'Alpha' },
                  ],
                },
                {
                  id: 'child-3',
                  name: 'Gamma',
                  parent_studio: { id: 'network-2', name: 'South Network' },
                },
                {
                  id: 'network-2',
                  name: 'South Network',
                  child_studios: [{ id: 'child-4', name: 'Delta' }],
                },
              ],
            },
          },
        }),
    } as Response);

    await expect(
      adapter.searchStudios('north', { baseUrl: 'http://stash.local' }),
    ).resolves.toEqual([
      {
        id: 'network-1',
        name: 'North Network',
        childStudios: [
          { id: 'child-1', name: 'Alpha' },
          { id: 'child-2', name: 'Bravo' },
        ],
      },
      {
        id: 'network-2',
        name: 'South Network',
        childStudios: [
          { id: 'child-4', name: 'Delta' },
          { id: 'child-3', name: 'Gamma' },
        ],
      },
    ]);
  });

  it.each([
    ['UNWATCHED', 'created_at', { value: 0, modifier: 'EQUALS' }],
    ['MOST_PLAYED', 'play_count', { value: 0, modifier: 'GREATER_THAN' }],
  ] as const)(
    'queries Stash by play count for %s',
    async (mode, sort, playCount) => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findScenes: {
                scenes: [
                  {
                    id: '9',
                    title: 'Scene Nine',
                    paths: {
                      screenshot: 'http://stash.local/scene/9/screenshot',
                    },
                    studio: { id: '2', name: 'Studio', image_path: null },
                    files: [{ width: 1920, height: 1080, duration: 600 }],
                  },
                ],
              },
            },
          }),
      } as Response);

      const scenes = await adapter.getLocalScenesByPlayback(
        { baseUrl: 'http://stash.local', apiKey: 'secret' },
        mode,
        12,
      );

      expect(scenes).toEqual([
        expect.objectContaining({ id: '9', title: 'Scene Nine' }),
      ]);
      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.variables).toEqual({
        filter: { page: 1, per_page: 12, sort, direction: 'DESC' },
        sceneFilter: { play_count: playCount },
      });
    },
  );

  it('falls back to sceneIncrementPlayCount on Stash versions without sceneAddPlay', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            errors: [
              {
                message:
                  'Cannot query field "sceneAddPlay" on type "Mutation".',
              },
            ],
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: { sceneIncrementPlayCount: 3 } }),
      } as Response);

    await adapter.addScenePlay(
      { baseUrl: 'http://stash.local', apiKey: 'secret' },
      '12',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(second.query).toContain('sceneIncrementPlayCount');
  });

  it('saves playback activity with resume time and seconds watched', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { sceneSaveActivity: true } }),
    } as Response);

    await adapter.saveSceneActivity(
      { baseUrl: 'http://stash.local' },
      '12',
      61.5,
      15,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.query).toContain('sceneSaveActivity');
    expect(body.variables).toEqual({ id: '12', resume: 61.5, played: 15 });
  });

  it('lists scenes in progress by last played, with resume time', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            findScenes: {
              scenes: [
                {
                  id: '5',
                  title: 'Half Watched',
                  resume_time: 300,
                  paths: {
                    screenshot: 'http://stash.local/scene/5/screenshot',
                  },
                  files: [{ duration: 1200 }],
                },
              ],
            },
          },
        }),
    } as Response);

    const scenes = await adapter.getScenesInProgress(
      { baseUrl: 'http://stash.local' },
      8,
    );

    expect(scenes).toEqual([
      expect.objectContaining({ id: '5', resumeTime: 300, duration: 1200 }),
    ]);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.variables).toEqual({
      filter: {
        page: 1,
        per_page: 8,
        sort: 'last_played_at',
        direction: 'DESC',
      },
      sceneFilter: { resume_time: { value: 0, modifier: 'GREATER_THAN' } },
    });
  });

  describe('local library', () => {
    const config = { baseUrl: 'http://stash.local', apiKey: 'k' };
    const ok = (data: unknown) =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data }),
      }) as Response;
    const gqlError = (message: string) =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ errors: [{ message }] }),
      }) as Response;
    const sentBody = (call: number) =>
      JSON.parse(
        String((fetchMock.mock.calls[call][1] as RequestInit).body),
      ) as {
        query: string;
        variables: Record<string, unknown>;
      };

    it('saves rating, organized and tags with sceneUpdate', async () => {
      fetchMock.mockResolvedValue(ok({ sceneUpdate: { id: '5' } }));

      await adapter.updateLocalScene(config, '5', {
        rating100: 80,
        organized: true,
        tagIds: ['1', '2'],
      });

      expect(sentBody(0).query).toContain('sceneUpdate');
      expect(sentBody(0).variables).toEqual({
        input: { id: '5', rating100: 80, organized: true, tag_ids: ['1', '2'] },
      });
    });

    it('only sends the fields that changed', async () => {
      fetchMock.mockResolvedValue(ok({ sceneUpdate: { id: '5' } }));

      await adapter.updateLocalScene(config, '5', { rating100: null });

      expect(sentBody(0).variables).toEqual({
        input: { id: '5', rating100: null },
      });
    });

    it('marks unwatched on older Stash by clearing play_count when sceneResetPlayCount is missing', async () => {
      fetchMock
        .mockResolvedValueOnce(
          gqlError(
            'Cannot query field "sceneResetPlayCount" on type "Mutation".',
          ),
        )
        .mockResolvedValue(
          ok({ sceneUpdate: { id: '5' }, sceneSaveActivity: true }),
        );

      await adapter.setSceneWatched(config, '5', false);

      expect(sentBody(1).variables).toEqual({
        input: { id: '5', play_count: 0 },
      });
      expect(sentBody(2).query).toContain('sceneSaveActivity');
      expect(sentBody(2).variables).toEqual(
        expect.objectContaining({ resume: 0 }),
      );
    });

    it('maps library scene cards and markers', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          findScenes: {
            count: 30,
            scenes: [
              {
                id: '7',
                title: '',
                date: '2025-01-02',
                play_count: 2,
                resume_time: 30,
                paths: { screenshot: 'http://stash/scene/1/screenshot?t=1' },
                studio: {
                  id: '3',
                  name: 'Studio',
                  image_path: 'http://stash/studio/3/image?default=true',
                },
                files: [{ duration: 600 }],
              },
            ],
          },
        }),
      );

      const page = await adapter.findLocalScenes(config, {
        page: 2,
        perPage: 24,
        sort: 'date',
        direction: 'DESC',
        sceneFilter: { performers: { value: ['9'], modifier: 'INCLUDES_ALL' } },
      });

      expect(page).toEqual({
        total: 30,
        items: [
          {
            id: '7',
            title: 'Scene #7',
            date: '2025-01-02',
            screenshotVersion: '1',
            studio: { id: '3', name: 'Studio', imageVersion: null },
            duration: 600,
            playCount: 2,
            resumeTime: 30,
          },
        ],
      });
      expect(sentBody(0).variables).toEqual({
        filter: { page: 2, per_page: 24, sort: 'date', direction: 'DESC' },
        scene_filter: {
          performers: { value: ['9'], modifier: 'INCLUDES_ALL' },
        },
      });
    });

    it('falls back to fewer performer fields on older Stash', async () => {
      fetchMock
        .mockResolvedValueOnce(
          gqlError('Cannot query field "disambiguation" on type "Performer".'),
        )
        .mockResolvedValueOnce(
          ok({
            findPerformer: {
              id: '9',
              name: 'Ana',
              favorite: true,
              image_path: 'http://stash/performer/1/image?t=1',
              scene_count: 4,
            },
          }),
        );

      await expect(adapter.getLocalPerformer(config, '9')).resolves.toEqual(
        expect.objectContaining({
          id: '9',
          name: 'Ana',
          favorite: true,
          imageVersion: '1',
          sceneCount: 4,
        }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sorts chapters and names untitled ones after their tag', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          findScene: {
            id: '5',
            title: 'Scene',
            scene_markers: [
              {
                id: 'b',
                title: '',
                seconds: 120,
                primary_tag: { name: 'Kiss' },
              },
              {
                id: 'a',
                title: 'Intro',
                seconds: 5,
                primary_tag: { name: 'Tag' },
              },
              { id: 'c', title: 'Broken', seconds: null },
            ],
            files: [],
          },
        }),
      );

      const scene = await adapter.getLocalSceneDetails(config, '5');

      expect(scene?.markers).toEqual([
        { id: 'a', title: 'Intro', seconds: 5 },
        { id: 'b', title: 'Kiss', seconds: 120 },
      ]);
    });

    it('creates a chapter with its primary tag', async () => {
      fetchMock.mockResolvedValue(ok({ sceneMarkerCreate: { id: 'm9' } }));

      await adapter.createSceneMarker(config, '5', {
        title: 'Beach',
        seconds: 61.5,
        primaryTagId: '12',
      });

      expect(sentBody(0).variables).toEqual({
        input: {
          scene_id: '5',
          title: 'Beach',
          seconds: 61.5,
          primary_tag_id: '12',
        },
      });
    });

    it('searches library performers and studios together', async () => {
      fetchMock.mockResolvedValue(
        ok({
          findPerformers: {
            performers: [
              {
                id: '1',
                name: 'Ana',
                image_path: 'http://s/performer/1/image?t=1',
                scene_count: 9,
                favorite: true,
              },
            ],
          },
          findStudios: {
            studios: [
              {
                id: '2',
                name: 'Harbor',
                image_path: 'http://s/x?default=true',
                scene_count: 4,
              },
            ],
          },
        }),
      );

      await expect(adapter.searchLocalPeople(config, ' ana ')).resolves.toEqual(
        {
          performers: [
            {
              id: '1',
              name: 'Ana',
              imageVersion: '1',
              sceneCount: 9,
              favorite: true,
            },
          ],
          studios: [
            { id: '2', name: 'Harbor', imageVersion: null, sceneCount: 4 },
          ],
        },
      );
      expect(sentBody(0).variables).toEqual({
        filter: {
          q: 'ana',
          page: 1,
          per_page: 12,
          sort: 'scenes_count',
          direction: 'DESC',
        },
      });
    });

    it('identifies scenes using the stash-box sources set up in Stash', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            configuration: {
              general: {
                stashBoxes: [{ endpoint: 'https://stashdb.org/graphql' }],
              },
            },
          }),
        )
        .mockResolvedValueOnce(ok({ metadataIdentify: '42' }));

      await expect(
        adapter.startLibraryTask(config, 'identify', ['5', '6']),
      ).resolves.toBe('42');
      expect(sentBody(1).variables).toEqual({
        input: {
          sources: [
            { source: { stash_box_endpoint: 'https://stashdb.org/graphql' } },
          ],
          sceneIDs: ['5', '6'],
        },
      });
    });

    it('explains when Stash has no identify source', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ configuration: { general: { stashBoxes: [] } } }),
      );

      await expect(
        adapter.startLibraryTask(config, 'identify'),
      ).rejects.toThrow(/Metadata Providers/);
    });

    it('finds duplicates, retrying without duration_diff on older Stash', async () => {
      fetchMock
        .mockResolvedValueOnce(
          gqlError(
            'Unknown argument "duration_diff" on field "findDuplicateScenes"',
          ),
        )
        .mockResolvedValueOnce(
          ok({
            findDuplicateScenes: [
              [
                {
                  id: '1',
                  title: 'A',
                  files: [
                    { width: 1920, height: 1080, size: '1000', bit_rate: 5 },
                  ],
                },
                {
                  id: '2',
                  title: 'B',
                  files: [{ width: 1280, height: 720, size: 500 }],
                },
              ],
              [{ id: '3', title: 'Alone', files: [] }],
            ],
          }),
        );

      const groups = await adapter.findDuplicateScenes(config, 0);

      expect(groups).toHaveLength(1);
      expect(groups[0].map((scene) => scene.id)).toEqual(['1', '2']);
      expect(groups[0][0].file?.size).toBe(1000);
      expect(sentBody(1).variables).toEqual({ distance: 0 });
    });

    it('deletes a scene and optionally its file', async () => {
      fetchMock.mockResolvedValue(ok({ sceneDestroy: true }));

      await adapter.deleteScene(config, '9', true);

      expect(sentBody(0).variables).toEqual({
        input: { id: '9', delete_file: true, delete_generated: true },
      });
    });

    it('waits for a job until it leaves the queue', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            jobQueue: [{ id: '7', status: 'RUNNING', description: 'Scanning' }],
          }),
        )
        .mockResolvedValueOnce(ok({ jobQueue: [] }));

      await expect(
        adapter.waitForJob(config, '7', { sleep: () => Promise.resolve() }),
      ).resolves.toBe('FINISHED');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports a failed job', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          jobQueue: [{ id: '7', status: 'FAILED', description: 'Scanning' }],
        }),
      );

      await expect(
        adapter.waitForJob(config, '7', { sleep: () => Promise.resolve() }),
      ).resolves.toBe('FAILED');
    });
  });

  describe('studios with aliases', () => {
    const config = { baseUrl: 'http://stash.local', apiKey: null };
    const respond = (body: unknown) =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }) as Response;
    const studio = {
      name: 'Mr Anal',
      stashId: 'sdb-studio',
      endpoint: 'https://stashdb.org/graphql',
    };

    it('uses the local studio that has the StashDB name as an alias', async () => {
      fetchMock
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [] } } }),
        )
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [] } } }),
        )
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [{ id: '42' }] } } }),
        );

      await expect(adapter.ensureStudio(config, studio)).resolves.toBe('42');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('falls back to the studio Stash names when creating one is refused', async () => {
      fetchMock
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [] } } }),
        )
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [] } } }),
        )
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [] } } }),
        )
        .mockResolvedValueOnce(
          respond({
            errors: [
              { message: "name 'Mr Anal' is used as alias for 'Mr. Anal'" },
            ],
          }),
        )
        .mockResolvedValueOnce(
          respond({
            data: {
              findStudios: { studios: [{ id: '42', name: 'Mr. Anal' }] },
            },
          }),
        );

      await expect(adapter.ensureStudio(config, studio)).resolves.toBe('42');
    });

    const empty = () => respond({ data: { findStudios: { studios: [] } } });
    const sentInput = (call: number) =>
      (
        JSON.parse(
          String((fetchMock.mock.calls[call][1] as RequestInit).body),
        ) as { variables: { input: Record<string, unknown> } }
      ).variables.input;

    it('creates a studio with its StashDB logo', async () => {
      fetchMock
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(
          respond({ data: { studioCreate: { id: '9' } } }),
        );

      await expect(
        adapter.ensureStudio(config, {
          ...studio,
          imageUrl: 'https://img/l.png',
        }),
      ).resolves.toBe('9');
      expect(sentInput(3).image).toBe('https://img/l.png');
    });

    it('creates it without the logo when Stash can’t fetch it', async () => {
      fetchMock
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(
          respond({ errors: [{ message: 'failed to download image' }] }),
        )
        .mockResolvedValueOnce(
          respond({ data: { studioCreate: { id: '9' } } }),
        );

      await expect(
        adapter.ensureStudio(config, {
          ...studio,
          imageUrl: 'https://img/l.png',
        }),
      ).resolves.toBe('9');
      expect(sentInput(4).image).toBeUndefined();
    });

    it('gives an existing studio without a logo the StashDB one', async () => {
      fetchMock
        .mockResolvedValueOnce(
          respond({ data: { findStudios: { studios: [{ id: '42' }] } } }),
        )
        .mockResolvedValueOnce(
          respond({
            data: {
              findStudio: {
                image_path: 'http://s/studio/42/image?default=true',
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          respond({ data: { studioUpdate: { id: '42' } } }),
        );

      await expect(
        adapter.ensureStudio(config, {
          ...studio,
          imageUrl: 'https://img/l.png',
        }),
      ).resolves.toBe('42');
      expect(sentInput(2)).toEqual({ id: '42', image: 'https://img/l.png' });
    });

    it('only links an existing studio when told not to create one', async () => {
      fetchMock
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty())
        .mockResolvedValueOnce(empty());

      await expect(
        adapter.ensureStudio(config, { ...studio, create: false }),
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('reads Stash’s Identify defaults', async () => {
      fetchMock.mockResolvedValueOnce(
        respond({
          data: {
            configuration: {
              defaults: {
                identify: {
                  options: {
                    includeMalePerformers: false,
                    fieldOptions: [
                      { field: 'performers', createMissing: false },
                      { field: 'studio', createMissing: true },
                    ],
                  },
                },
              },
            },
          },
        }),
      );

      await expect(adapter.getIdentifyDefaults(config)).resolves.toEqual({
        includeMalePerformers: false,
        createMissing: { performers: false, studio: true, tags: null },
      });
    });
  });

  describe('extra copies', () => {
    const config = { baseUrl: 'http://stash.local', apiKey: null };
    const respond = (body: unknown) =>
      ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }) as Response;

    it('makes the kept file the main one before deleting the other', async () => {
      fetchMock
        .mockResolvedValueOnce(respond({ data: { sceneUpdate: { id: '7' } } }))
        .mockResolvedValueOnce(respond({ data: { deleteFiles: true } }));

      await adapter.removeExtraFile(config, '7', '20', '10');

      const sent = fetchMock.mock.calls.map(
        (call) =>
          JSON.parse(String((call[1] as RequestInit).body)) as {
            variables: Record<string, unknown>;
          },
      );
      expect(sent[0].variables).toEqual({
        input: { id: '7', primary_file_id: '20' },
      });
      expect(sent[1].variables).toEqual({ ids: ['10'] });
    });

    it('never deletes the file it was told to keep', async () => {
      await expect(
        adapter.removeExtraFile(config, '7', '10', '10'),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
