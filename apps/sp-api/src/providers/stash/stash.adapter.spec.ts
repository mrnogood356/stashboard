import { BadGatewayException } from '@nestjs/common';
import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { withStashAccessHint } from './stash-graphql.client';
import { StashAdapter, stashVersionAtLeast } from './stash.adapter';

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
    // An older Stash by default; the tests for 0.32 say so.
    jest.spyOn(adapter, 'supportsProductionDate').mockResolvedValue(false);
  });

  /** Stash answering the check list, the coverless ids and each file. */
  const stashWith = (
    scenes: unknown[],
    coverless: string[],
    asset: (url: string, method?: string) => Partial<Response>,
  ) =>
    fetchMock.mockImplementation((url, init) => {
      const text = String(url);
      if (!text.includes('/graphql')) {
        return Promise.resolve({
          headers: new Headers(),
          body: null,
          ...asset(text, init?.method),
        } as Response);
      }
      const body = String(init?.body ?? '');
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findScenes: {
                scenes: body.includes('query Missing')
                  ? coverless.map((id) => ({ id }))
                  : scenes,
              },
            },
          }),
      } as Response);
    });

  const file = (path: string, phash: string | null = 'p') => ({
    id: `f${path}`,
    path,
    basename: path.slice(1),
    size: 100,
    mod_time: '2026-01-01T00:00:00Z',
    fingerprints: phash ? [{ type: 'phash', value: phash }] : [],
  });

  it('says what Generate hasn’t made for each scene', async () => {
    stashWith(
      [
        {
          id: '1',
          title: 'Complete',
          files: [file('/1.mp4')],
          scene_markers: [{ id: '10' }],
        },
        {
          id: '2',
          title: 'Gaps',
          files: [file('/2.mp4', null)],
          scene_markers: [{ id: '20' }, { id: '21' }],
        },
        { id: '3', title: 'No cover', files: [file('/3.mp4')] },
        { id: '4', title: 'No file', files: [] },
      ],
      ['3'],
      (url) => {
        const scene2 = url.includes('/scene/2/');
        if (url.endsWith('/screenshot')) {
          // Stash's placeholder for a picture it hasn't made.
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              'content-type': url.includes('/21/') ? 'image/png' : 'image/jpeg',
            }),
          };
        }
        const gone =
          scene2 &&
          (url.endsWith('/preview') ||
            url.endsWith('/vtt/sprite') ||
            url.includes('/20/stream'));
        return { ok: !gone, status: gone ? 404 : 200 };
      },
    );

    const found = await adapter.findGenerateGaps({
      baseUrl: 'http://stash.local',
    });
    expect(found).toMatchObject({ missing: 2, checked: 3, unanswered: 0 });
    expect(found.scenes[0]).toMatchObject({ id: '2', path: '/2.mp4' });
    expect(found.scenes[0].problems).toEqual([
      'No fingerprint (phash), so Duplicates can’t compare it.',
      'No hover preview: nothing plays when you point at it.',
      'No scrubber thumbnails: the seek bar shows no pictures.',
      '1 of 2 chapters have no preview clip.',
      '1 of 2 chapters have no picture.',
    ]);
    expect(found.scenes[1]).toMatchObject({
      id: '3',
      problems: ['No cover picture.'],
    });
  });

  it('counts files Stash didn’t answer for apart from missing ones, with the reason', async () => {
    stashWith([{ id: '1', title: 'One', files: [file('/1.mp4')] }], [], () => ({
      ok: false,
      status: 500,
    }));
    await expect(
      adapter.findGenerateGaps({ baseUrl: 'http://stash.local' }),
    ).resolves.toEqual({
      missing: 0,
      checked: 1,
      unanswered: 2,
      unansweredWhy: 'HTTP 500',
      unansweredExample: '/scene/1/preview',
      scenes: [],
    });
  });

  it('says in words when Stash refuses a file, with one address to try', async () => {
    stashWith([{ id: '1', title: 'One', files: [file('/1.mp4')] }], [], () => ({
      ok: false,
      status: 403,
    }));
    const found = await adapter.findGenerateGaps({
      baseUrl: 'http://stash.local',
    });
    expect(found.unanswered).toBe(2);
    expect(found.unansweredWhy).toBe(
      'HTTP 403: Stash refused to serve the file',
    );
    expect(found.unansweredExample).toBe('/scene/1/preview');
  });

  it('asks once more about files Stash didn’t answer for the first time', async () => {
    const asked = new Map<string, number>();
    stashWith(
      [{ id: '1', title: 'One', files: [file('/1.mp4')] }],
      [],
      (url) => {
        const times = (asked.get(url) ?? 0) + 1;
        asked.set(url, times);
        // Busy the first time; the preview is then found missing.
        if (times === 1) {
          return { ok: false, status: 503 };
        }
        return url.endsWith('/preview')
          ? { ok: false, status: 404 }
          : { ok: true, status: 200 };
      },
    );
    const found = await adapter.findGenerateGaps({
      baseUrl: 'http://stash.local',
    });
    expect(found.unanswered).toBe(0);
    expect(found.scenes[0].problems).toEqual([
      'No hover preview: nothing plays when you point at it.',
    ]);
    expect([...asked.values()].every((times) => times === 2)).toBe(true);
  });

  it('asks for one byte when Stash won’t answer HEAD', async () => {
    const sent: Array<{ method?: string }> = [];
    fetchMock.mockReset();
    stashWith(
      [{ id: '1', title: 'One', files: [file('/1.mp4')] }],
      [],
      (url, method) => {
        if (url.endsWith('/preview')) {
          sent.push({ method });
        }
        return method === 'HEAD'
          ? { ok: false, status: 405 }
          : { ok: false, status: 404 };
      },
    );
    const found = await adapter.findGenerateGaps({
      baseUrl: 'http://stash.local',
    });
    expect(found.scenes[0].problems).toContain(
      'No hover preview: nothing plays when you point at it.',
    );
    expect(sent).toEqual([{ method: 'HEAD' }, { method: 'GET' }]);
  });

  it('rescans a scene’s files with previews, and nothing else generated', async () => {
    fetchMock.mockImplementation((_url, init) => {
      const body = String(init?.body ?? '');
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: body.includes('PreviewFiles')
              ? {
                  findScenes: {
                    scenes: [{ files: [{ path: '/data/a/scene.mp4' }] }],
                  },
                }
              : { metadataScan: '77' },
          }),
      } as Response);
    });

    await expect(
      adapter.rescanForPreviews({ baseUrl: 'http://stash.local' }, ['12']),
    ).resolves.toBe('77');
    const scanCall = fetchMock.mock.calls.find(([, init]) =>
      String((init as { body?: string })?.body).includes('PreviewScan'),
    )!;
    const scan = JSON.parse((scanCall[1] as { body: string }).body) as {
      variables: { input: Record<string, unknown> };
    };
    expect(scan.variables.input).toMatchObject({
      paths: ['/data/a/scene.mp4'],
      rescan: true,
      scanGeneratePreviews: true,
      scanGenerateCovers: false,
      scanGenerateSprites: false,
      scanGeneratePhashes: false,
    });
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
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { metadataScan: '41' } })),
      ),
    );

    await expect(
      adapter.scanLibraryFolders({ baseUrl: 'http://stash.local' }, [
        '/data/scenes/A/',
        '/data/scenes/A',
        '/data/scenes/B',
      ]),
    ).resolves.toBe('41');

    const [, init] =
      fetchMock.mock.calls.find(([, call]) =>
        String(call?.body).includes('ScanFolders'),
      ) ?? [];
    const body = JSON.parse(String(init?.body)) as {
      variables: unknown;
    };
    expect(body.variables).toEqual({
      input: { paths: ['/data/scenes/A', '/data/scenes/B'] },
    });
  });

  describe('Stashboard’s background jobs', () => {
    const config = { baseUrl: 'http://stash.local' };
    let nextJob: number;
    let queue: Array<{ id: string; status: string }>;
    const sent = () =>
      fetchMock.mock.calls
        .map(([, init]) => String(init?.body))
        .filter((body) => body.includes('mutation'))
        .map(
          (body) =>
            JSON.parse(body) as {
              variables: { input: Record<string, unknown> };
            },
        );
    let wake: () => void;

    beforeEach(() => {
      nextJob = 50;
      queue = [];
      const lane = adapter as unknown as {
        lanePollMs: number;
        laneSleep: (ms: number) => Promise<void>;
        startGraceMs: number;
      };
      lane.lanePollMs = 0;
      lane.startGraceMs = 0;
      // Each look at a busy queue waits until the test says Stash moved on.
      lane.laneSleep = () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        });
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
          : body.includes('metadataIdentify')
            ? 'metadataIdentify'
            : 'metadataScan';
        return Promise.resolve(
          new Response(JSON.stringify({ data: { [field]: id } })),
        );
      });
    });

    // Lets the fetches and the lane's looks at the queue run.
    const settle = async () => {
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    it('waits while anything waits in Stash’s queue, then scans every folder asked meanwhile in one job', async () => {
      queue = [{ id: '9', status: 'READY' }];
      const a = adapter.scanLibraryFolders(config, ['/data/a']);
      await settle();
      const b = adapter.scanLibraryFolders(config, ['/data/b/']);
      expect(sent()).toHaveLength(0);

      queue = [{ id: '9', status: 'RUNNING' }];
      wake();
      await expect(a).resolves.toBe('51');
      await expect(b).resolves.toBe('51');
      expect(sent()).toHaveLength(1);
      expect(sent()[0].variables.input).toEqual({
        paths: ['/data/a', '/data/b'],
      });
    });

    it('goes ahead once Stash’s queue has been stuck too long', async () => {
      (adapter as unknown as { laneMaxWaitMs: number }).laneMaxWaitMs = 0;
      queue = [{ id: '9', status: 'READY' }];
      await expect(
        adapter.scanLibraryFolders(config, ['/data/stuck']),
      ).resolves.toBe('51');
      expect(sent()).toHaveLength(1);
    });

    it('makes one Generate for every scene asked while Stash is busy', async () => {
      queue = [{ id: '9', status: 'READY' }];
      const asks = ['1', '2', '3'].map((id) =>
        adapter.startLibraryTask(config, 'generate', [id]),
      );
      await settle();
      queue = [];
      wake();
      const jobs = await Promise.all(asks);
      expect(new Set(jobs)).toEqual(new Set(['51']));
      expect(sent()).toHaveLength(1);
      expect(sent()[0].variables.input['sceneIDs']).toEqual(['1', '2', '3']);
    });

    it('starts one kind after another, never two waiting at once', async () => {
      const scan = await adapter.scanLibraryFolders(config, ['/data/a']);
      // The scan now waits its turn in Stash: the Generate waits for it.
      queue = [{ id: scan!, status: 'READY' }];
      const generate = adapter.startLibraryTask(config, 'generate', ['1']);
      await settle();
      expect(sent()).toHaveLength(1);
      queue = [{ id: scan!, status: 'RUNNING' }];
      wake();
      await expect(generate).resolves.toBe('52');
    });

    it('reuses a running scan of ours that has the folder, rather than queuing another', async () => {
      const first = await adapter.scanLibraryFolders(config, ['/data/a']);
      queue = [{ id: first!, status: 'RUNNING' }];
      // The folder watcher noticing the file the download's scan is for.
      await expect(
        adapter.scanLibraryFolders(config, ['/data/a/']),
      ).resolves.toBe(first);
      expect(sent()).toHaveLength(1);
      // Once it has finished, a new ask is a new scan.
      queue = [];
      await expect(
        adapter.scanLibraryFolders(config, ['/data/a']),
      ).resolves.toBe('52');
    });

    it('gives a second ask for the same scenes the job being started, not another', async () => {
      const first = adapter.startLibraryTask(config, 'generate', ['1']);
      await settle();
      // Running in Stash now: a second ask for the scene gets the same job.
      queue = [{ id: '51', status: 'RUNNING' }];
      const second = adapter.startLibraryTask(config, 'generate', ['1']);
      await expect(first).resolves.toBe('51');
      await expect(second).resolves.toBe('51');
      expect(sent()).toHaveLength(1);
    });

    it('starts what you asked for straight away, busy or not', async () => {
      queue = [{ id: '9', status: 'READY' }];
      await expect(
        adapter.startLibraryTask(config, 'generate', ['1'], { now: true }),
      ).resolves.toBe('51');
    });

    it('says whether a folder’s scan still waits, and asks again once it has run', async () => {
      queue = [{ id: '9', status: 'READY' }];
      await expect(adapter.requestFolderScan(config, '/data/a')).resolves.toBe(
        'waiting',
      );
      await expect(adapter.requestFolderScan(config, '/data/a')).resolves.toBe(
        'waiting',
      );
      await settle();
      queue = [];
      wake();
      await settle();
      await settle();
      queue = [{ id: '51', status: 'RUNNING' }];
      await expect(adapter.requestFolderScan(config, '/data/a')).resolves.toBe(
        '51',
      );
      // Finished: still that scan, until it has been looked at.
      queue = [];
      await expect(adapter.requestFolderScan(config, '/data/a')).resolves.toBe(
        '51',
      );
      adapter.forgetFolderScan(config, '/data/a/');
      // Stash is free: the new scan starts at once.
      await expect(adapter.requestFolderScan(config, '/data/a')).resolves.toBe(
        '52',
      );
      await settle();
      await settle();
      expect(sent()).toHaveLength(2);
    });

    it('hands back the scan at once when Stash is free, so one check can follow it', async () => {
      (adapter as unknown as { startGraceMs: number }).startGraceMs = 1_000;
      await expect(adapter.requestFolderScan(config, '/data/b')).resolves.toBe(
        '51',
      );
    });

    it('never runs Generate for the whole library when no named scene is real', async () => {
      await expect(
        adapter.startLibraryTask(config, 'generate', ['', '  ']),
      ).rejects.toThrow('None of those is a scene');
      expect(sent()).toHaveLength(0);
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
          width: 1920,
          height: 1080,
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
                  files: [
                    {
                      duration: 1800,
                      fingerprints: [
                        { type: 'oshash', value: 'ABC123' },
                        { type: 'phash', value: 'ff00' },
                        { type: 'duration', value: '1800' },
                      ],
                    },
                  ],
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
          fingerprints: ['OSHASH|abc123', 'PHASH|ff00'],
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
          width: null,
          height: null,
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

  it('reads production date and picture size from a Stash 0.32 or later, and asks an older one without it', async () => {
    const config = { baseUrl: 'http://stash.local' };
    const page = (productionDate: boolean) => {
      jest
        .spyOn(adapter, 'supportsProductionDate')
        .mockResolvedValue(productionDate);
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              findScenes: {
                count: 1,
                scenes: [
                  {
                    id: '9',
                    title: 'Filmed',
                    date: '2026-01-10',
                    ...(productionDate
                      ? { production_date: '2025-08-01' }
                      : {}),
                    files: [{ duration: 600, width: 2560, height: 1440 }],
                  },
                ],
              },
            },
          }),
      } as Response);
      return adapter.getLocalLibraryScenePage(config, { page: 1, perPage: 10 });
    };
    const query = () =>
      String(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).query);

    const newer = await page(true);
    expect(newer.items[0]).toMatchObject({
      productionDate: '2025-08-01',
      width: 2560,
      height: 1440,
    });
    expect(query()).toContain('production_date');

    const older = await page(false);
    // Not asked: left out, so the library index keeps the date it has.
    expect(older.items[0].productionDate).toBeUndefined();
    expect(older.items[0]).toMatchObject({ width: 2560 });
    expect(query()).not.toContain('production_date');
  });

  it('says how to let Stashboard in when Stash 0.32 refuses it with a 403', () => {
    expect(withStashAccessHint('Stash provider returned 403', 403)).toContain(
      'public_whitelist',
    );
    expect(withStashAccessHint('Stash provider returned 500', 500)).toBe(
      'Stash provider returned 500',
    );
  });

  it('knows 0.32 and later have production dates, from the version Stash reports', async () => {
    const fresh = new StashAdapter(
      runtimeHealthService as unknown as RuntimeHealthService,
    );
    const config = { baseUrl: 'http://stash.version.test' };
    const getVersion = jest
      .spyOn(fresh, 'getVersion')
      .mockResolvedValueOnce('v0.32.0')
      .mockResolvedValueOnce('v0.31.1');
    await expect(fresh.supportsProductionDate(config)).resolves.toBe(true);
    // Remembered for a while: Stash isn't asked again straight away.
    await expect(fresh.supportsProductionDate(config)).resolves.toBe(true);
    expect(getVersion).toHaveBeenCalledTimes(1);
    await expect(
      fresh.supportsProductionDate({ baseUrl: 'http://other.test' }),
    ).resolves.toBe(false);

    // A failed check isn't remembered: Stash is asked again next time.
    const flaky = new StashAdapter(
      runtimeHealthService as unknown as RuntimeHealthService,
    );
    const flakyVersion = jest
      .spyOn(flaky, 'getVersion')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('v0.32.1');
    await expect(flaky.supportsProductionDate(config)).resolves.toBe(false);
    await expect(flaky.supportsProductionDate(config)).resolves.toBe(true);
    expect(flakyVersion).toHaveBeenCalledTimes(2);

    expect(stashVersionAtLeast('v0.32.0-21-gabcdef', 0, 32)).toBe(true);
    expect(stashVersionAtLeast('v1.0.0', 0, 32)).toBe(true);
    expect(stashVersionAtLeast('v0.31.9', 0, 32)).toBe(false);
    expect(stashVersionAtLeast(null, 0, 32)).toBe(false);
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
          width: null,
          height: null,
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
                  files: [{ duration: 1200, width: 1920, height: 1080 }],
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
      expect.objectContaining({
        id: '5',
        resumeTime: 300,
        duration: 1200,
        width: 1920,
        height: 1080,
      }),
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

    it('lists chapters with where each ends, filtered by tag and words', async () => {
      const scene = (id: string, duration: number, starts: number[]) => ({
        id,
        title: `Scene ${id}`,
        files: [{ duration }],
        scene_markers: starts.map((seconds) => ({ seconds })),
      });
      fetchMock.mockResolvedValue(
        ok({
          findSceneMarkers: {
            scene_markers: [
              // Its own end time.
              {
                id: '1',
                title: 'Own',
                seconds: 10,
                end_seconds: 25,
                primary_tag: { name: 'T' },
                scene: scene('5', 600, [10, 200]),
              },
              // Up to the next chapter in its scene.
              {
                id: '2',
                title: '',
                seconds: 200,
                primary_tag: { name: 'Pool' },
                scene: scene('6', 600, [200, 260]),
              },
              // Nothing after it: a minute, but not past the end.
              {
                id: '3',
                title: 'Last',
                seconds: 570,
                primary_tag: { name: 'T' },
                scene: scene('7', 600, [570]),
              },
              { id: '9', seconds: 1, scene: null },
            ],
          },
        }),
      );

      const chapters = await adapter.findChapters(config, {
        tagId: '4',
        query: ' beach ',
        limit: 500,
      });

      expect(
        chapters.map((c) => [c.id, c.title, c.seconds, c.endSeconds]),
      ).toEqual([
        ['1', 'Own', 10, 25],
        ['2', 'Pool', 200, 260],
        ['3', 'Last', 570, 600],
      ]);
      expect(sentBody(0).variables).toEqual({
        filter: {
          per_page: 500,
          sort: 'created_at',
          direction: 'DESC',
          q: 'beach',
        },
        marker_filter: {
          tags: { value: ['4'], modifier: 'INCLUDES', depth: 0 },
        },
      });
    });

    it('merges performers, keeping the others’ names as aliases and their links', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            findPerformers: {
              performers: [
                {
                  id: '1',
                  name: 'Jane Doe',
                  alias_list: ['JD'],
                  stash_ids: [{ endpoint: 'sdb', stash_id: 'a' }],
                },
                {
                  id: '2',
                  name: 'jane doe',
                  alias_list: ['Janie'],
                  stash_ids: [{ endpoint: 'fdb', stash_id: 'b' }],
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(ok({ performerMerge: { id: '1' } }));

      await adapter.mergePerformers(config, '1', ['2']);

      expect(sentBody(1).variables).toEqual({
        input: {
          source: ['2'],
          destination: '1',
          values: {
            id: '1',
            alias_list: ['JD', 'Janie'],
            stash_ids: [
              { endpoint: 'sdb', stash_id: 'a' },
              { endpoint: 'fdb', stash_id: 'b' },
            ],
          },
        },
      });
    });

    it('merges studios: moves everything, then deletes the merged one before adding its name as an alias', async () => {
      const calls: string[] = [];
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const name = /(query|mutation) (\w+)/.exec(body.query)?.[2] ?? '?';
        calls.push(name);
        if (name === 'MergeStudioSources') {
          return Promise.resolve(
            ok({
              findStudios: {
                studios: [
                  {
                    id: '1',
                    name: 'Brand',
                    aliases: [],
                    stash_ids: [],
                    child_studios: [],
                  },
                  {
                    id: '2',
                    name: 'Brand Inc',
                    aliases: ['BI'],
                    stash_ids: [],
                    child_studios: [{ id: '9' }],
                  },
                ],
              },
            }),
          );
        }
        if (name === 'StudioItems') {
          return Promise.resolve(
            ok(
              body.query.includes('findScenes')
                ? { findScenes: { scenes: [{ id: '50' }, { id: '51' }] } }
                : {
                    findGalleries: { galleries: [] },
                    findImages: { images: [] },
                    findGroups: { groups: [] },
                  },
            ),
          );
        }
        return Promise.resolve(ok({}));
      });

      await adapter.mergeStudios(config, '1', ['2']);

      expect(calls).toEqual([
        'MergeStudioSources',
        'StudioItems',
        'MoveToStudio',
        'StudioItems',
        'StudioItems',
        'StudioItems',
        'MoveSubStudio',
        'RemoveStudio',
        'KeepStudio',
      ]);
      const bodies = fetchMock.mock.calls.map(
        ([, init]) =>
          JSON.parse(String((init as RequestInit).body)) as {
            variables: Record<string, unknown>;
          },
      );
      expect(bodies[2].variables).toEqual({
        input: { ids: ['50', '51'], studio_id: '1' },
      });
      expect(bodies[6].variables).toEqual({
        input: { id: '9', parent_id: '1' },
      });
      expect(bodies[8].variables).toEqual({
        input: { id: '1', aliases: ['Brand Inc', 'BI'], stash_ids: [] },
      });
    });

    it('carries a removed copy’s plays, tags and chapters to the copy kept', async () => {
      const calls: Array<{ name: string; variables: Record<string, unknown> }> =
        [];
      const scenes = (fromLength: number) => [
        {
          id: '2',
          rating100: 80,
          organized: true,
          play_history: ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'],
          o_history: [],
          urls: ['https://a'],
          tags: [{ id: 't1' }, { id: 't2' }],
          performers: [{ id: 'p1' }],
          galleries: [],
          groups: [{ group: { id: 'g1' }, scene_index: 3 }],
          stash_ids: [{ endpoint: 'sdb', stash_id: 'x' }],
          files: [{ duration: fromLength }],
          scene_markers: [
            {
              title: 'Pool',
              seconds: 100,
              primary_tag: { id: 't9' },
              tags: [],
            },
            {
              title: 'Same',
              seconds: 300,
              primary_tag: { id: 't8' },
              tags: [],
            },
          ],
        },
        {
          id: '1',
          rating100: null,
          organized: false,
          play_history: [],
          o_history: [],
          urls: [],
          tags: [{ id: 't2' }],
          performers: [],
          galleries: [],
          groups: [],
          stash_ids: [],
          files: [{ duration: 1800 }],
          scene_markers: [
            { title: 'Same', seconds: 300.5, primary_tag: { id: 't8' } },
          ],
        },
      ];
      let fromLength = 1801;
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const name = /(query|mutation) (\w+)/.exec(body.query)?.[2] ?? '?';
        calls.push({ name, variables: body.variables });
        return Promise.resolve(
          ok(
            name === 'CarryScenes'
              ? { findScenes: { scenes: scenes(fromLength) } }
              : {},
          ),
        );
      });

      expect(await adapter.carrySceneDetails(config, '2', '1')).toEqual({
        plays: 2,
        os: 0,
        chapters: 1,
      });
      expect(calls.map((call) => call.name)).toEqual([
        'CarryScenes',
        'CarryDetails',
        'CarryChapter',
        'CarryPlays',
      ]);
      expect(calls[1].variables).toEqual({
        input: {
          id: '1',
          tag_ids: ['t2', 't1'],
          performer_ids: ['p1'],
          gallery_ids: [],
          groups: [{ group_id: 'g1', scene_index: 3 }],
          stash_ids: [{ endpoint: 'sdb', stash_id: 'x' }],
          urls: ['https://a'],
          rating100: 80,
          organized: true,
        },
      });
      expect(calls[2].variables).toEqual({
        input: {
          scene_id: '1',
          title: 'Pool',
          seconds: 100,
          primary_tag_id: 't9',
          tag_ids: [],
        },
      });

      // A different length: no chapters, which could land in the wrong place.
      calls.length = 0;
      fromLength = 1700;
      expect((await adapter.carrySceneDetails(config, '2', '1')).chapters).toBe(
        0,
      );
      expect(calls.some((call) => call.name === 'CarryChapter')).toBe(false);
    });

    it('gives each card its main file’s picture size, for its quality', async () => {
      fetchMock.mockResolvedValue(
        ok({
          findScenes: {
            count: 1,
            scenes: [
              {
                id: '1',
                title: 'Pool',
                files: [
                  { duration: 2451, width: 3840, height: 2160 },
                  { duration: 2451, width: 1280, height: 720 },
                ],
              },
            ],
          },
        }),
      );
      const page = await adapter.findLocalScenes(config, {
        page: 1,
        perPage: 10,
        sort: 'id',
        direction: 'ASC',
        sceneFilter: {},
      });
      expect(page.items[0]).toMatchObject({
        duration: 2451,
        width: 3840,
        height: 2160,
      });
      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(body.query).toMatch(/files \{\s*duration\s*width\s*height/);
    });

    it('refuses an answer with no scene list when asked to be strict', async () => {
      fetchMock.mockResolvedValue(ok({}));
      await expect(
        adapter.findLocalScenes(config, {
          page: 1,
          perPage: 10,
          sort: 'id',
          direction: 'ASC',
          sceneFilter: {},
          ids: ['1'],
          strict: true,
        }),
      ).rejects.toThrow('list of scenes');
      fetchMock.mockResolvedValue(
        ok({ findScenes: { count: 1, scenes: [{ id: 1 }] } }),
      );
      await expect(
        adapter.findLocalScenes(config, {
          page: 1,
          perPage: 10,
          sort: 'id',
          direction: 'ASC',
          sceneFilter: {},
          ids: ['1'],
          strict: true,
        }),
      ).rejects.toThrow('couldn’t read');
      fetchMock.mockResolvedValue(ok({}));
      await expect(
        adapter.findLocalScenes(config, {
          page: 1,
          perPage: 10,
          sort: 'id',
          direction: 'ASC',
          sceneFilter: {},
        }),
      ).resolves.toEqual({ total: 0, items: [] });
    });

    it('says what to add by hand when the kept studio can’t take the names', async () => {
      fetchMock.mockImplementation((_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        const name = /(query|mutation) (\w+)/.exec(body.query)?.[2] ?? '?';
        if (name === 'MergeStudioSources') {
          return Promise.resolve(
            ok({
              findStudios: {
                studios: [
                  {
                    id: '1',
                    name: 'Brand',
                    aliases: [],
                    stash_ids: [],
                    child_studios: [],
                  },
                  {
                    id: '2',
                    name: 'Brand Inc',
                    aliases: [],
                    stash_ids: [{ endpoint: 'sdb', stash_id: 'x' }],
                    child_studios: [],
                  },
                ],
              },
            }),
          );
        }
        if (name === 'KeepStudio') {
          return Promise.resolve(gqlError('alias taken'));
        }
        return Promise.resolve(ok({}));
      });
      await expect(adapter.mergeStudios(config, '1', ['2'])).rejects.toThrow(
        /aliases Brand Inc; StashDB\/FansDB links sdb x/,
      );
    });

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
            width: null,
            height: null,
            playCount: 2,
            resumeTime: 30,
            lastPlayedAt: null,
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
                stash_ids: [{ stash_id: 'sdb-ana' }],
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
              catalogIds: ['sdb-ana'],
            },
          ],
          studios: [
            {
              id: '2',
              name: 'Harbor',
              imageVersion: null,
              sceneCount: 4,
              catalogIds: [],
            },
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
        // Nothing waiting in Stash's queue: it starts.
        .mockResolvedValueOnce(ok({ jobQueue: [] }))
        .mockResolvedValueOnce(ok({ metadataIdentify: '42' }));

      await expect(
        adapter.startLibraryTask(config, 'identify', ['5', '6']),
      ).resolves.toBe('42');
      expect(sentBody(2).variables).toEqual({
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
