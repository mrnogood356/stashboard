import { RuntimeHealthService } from '../../runtime-health/runtime-health.service';
import { StashdbAdapter } from './stashdb.adapter';
import { resetCatalogRateLimit } from './catalog-rate-limit';

describe('StashdbAdapter.getSceneFacets', () => {
  const fetchMock = jest.fn();
  let originalFetch: typeof fetch;
  let adapter: StashdbAdapter;

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
    adapter = new StashdbAdapter({
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeHealthService);
  });

  const scene = (tags: string[], studio: string) => ({
    tags: tags.map((name) => ({ id: `t-${name}`, name })),
    studio: { id: `s-${studio}`, name: studio },
  });
  const page = (count: number, scenes: unknown[]) =>
    new Response(JSON.stringify({ data: { queryScenes: { count, scenes } } }), {
      headers: { 'content-type': 'application/json' },
    });

  it('counts categories and studios over the pages, the most used first', async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      scene(
        i % 2 === 0 ? ['Outdoor', 'POV'] : ['Outdoor'],
        i < 60 ? 'Alpha' : 'Beta',
      ),
    );
    fetchMock
      .mockResolvedValueOnce(page(103, first))
      .mockResolvedValueOnce(
        page(103, [
          scene(['Romantic'], 'Alpha'),
          scene([], 'Beta'),
          scene(['POV'], 'Beta'),
        ]),
      );

    const facets = await adapter.getSceneFacets({
      baseUrl: 'http://stashdb.local/graphql',
      performerId: 'p1',
      maxScenes: 500,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(facets.total).toBe(103);
    expect(facets.scanned).toBe(103);
    expect(facets.tags).toEqual([
      { id: 't-Outdoor', name: 'Outdoor', count: 100 },
      { id: 't-POV', name: 'POV', count: 51 },
      { id: 't-Romantic', name: 'Romantic', count: 1 },
    ]);
    expect(facets.studios).toEqual([
      { id: 's-Alpha', name: 'Alpha', count: 61 },
      { id: 's-Beta', name: 'Beta', count: 42 },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.query).toContain('performers: { value: $ids');
    expect(body.variables).toEqual({ ids: ['p1'], page: 1, perPage: 100 });
  });

  it('stops at the newest few hundred for a big studio', async () => {
    const full = Array.from({ length: 100 }, () => scene(['POV'], 'Alpha'));
    fetchMock.mockImplementation(() => Promise.resolve(page(5000, full)));

    const facets = await adapter.getSceneFacets({
      baseUrl: 'http://stashdb.local/graphql',
      studioId: 's1',
      maxScenes: 250,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(facets).toMatchObject({ total: 5000, scanned: 250 });
    expect(facets.tags).toEqual([{ id: 't-POV', name: 'POV', count: 250 }]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.query).toContain('studios: { value: $ids');
  });
});
