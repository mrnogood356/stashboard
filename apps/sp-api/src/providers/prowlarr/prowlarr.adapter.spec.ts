import { BadGatewayException, Logger } from '@nestjs/common';
import { ProwlarrAdapter } from './prowlarr.adapter';

describe('ProwlarrAdapter', () => {
  const config = { baseUrl: 'http://prowlarr:9696/', apiKey: ' key ' };
  let adapter: ProwlarrAdapter;
  let originalFetch: typeof fetch;
  const fetchMock = jest.fn();

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  beforeAll(() => {
    originalFetch = global.fetch;
    Object.assign(global, { fetch: fetchMock });
  });

  afterAll(() => {
    Object.assign(global, { fetch: originalFetch });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    adapter = new ProwlarrAdapter();
  });

  it('tests the connection with system/status and the API key header', async () => {
    fetchMock.mockResolvedValue(reply({ version: '1.30.2' }));

    await expect(adapter.getSystemStatus(config)).resolves.toEqual({
      version: '1.30.2',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://prowlarr:9696/api/v1/system/status');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('key');
  });

  it('says plainly when the API key is refused', async () => {
    fetchMock.mockResolvedValue(reply({ message: 'Unauthorized' }, 401));

    await expect(adapter.testConnection(config)).rejects.toThrow(
      'Prowlarr refused the API key',
    );
  });

  it('says plainly when Prowlarr can’t be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(adapter.testConnection(config)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('searches with type=search and the XXX categories, and keeps usable releases', async () => {
    fetchMock.mockResolvedValue(
      reply([
        {
          guid: 'g1',
          indexerId: 4,
          indexer: 'Tracker',
          title: 'Jane.Doe.24.03.15.Beach.Day.1080p',
          size: 2_000_000_000,
          protocol: 'torrent',
          seeders: 12,
          leechers: 1,
          ageHours: 30.5,
          publishDate: '2024-03-15T10:00:00Z',
          infoUrl: 'https://tracker/t/1',
          downloadUrl: 'http://prowlarr:9696/4/download?apikey=key&link=x',
        },
        { guid: 'g2', title: 'No indexer id' },
      ]),
    );

    const releases = await adapter.search(config, 'Jane Doe 24.03.15');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/api/v1/search');
    expect(url.searchParams.get('query')).toBe('Jane Doe 24.03.15');
    expect(url.searchParams.get('type')).toBe('search');
    expect(url.searchParams.getAll('categories')).toContain('6000');
    expect(releases).toEqual([
      {
        guid: 'g1',
        indexerId: 4,
        indexer: 'Tracker',
        title: 'Jane.Doe.24.03.15.Beach.Day.1080p',
        size: 2_000_000_000,
        protocol: 'torrent',
        seeders: 12,
        leechers: 1,
        ageHours: 30.5,
        publishDate: '2024-03-15T10:00:00Z',
        infoUrl: 'https://tracker/t/1',
        downloadUrl: 'http://prowlarr:9696/4/download?apikey=key&link=x',
      },
    ]);
  });

  it('grabs by POSTing the guid and indexer to /api/v1/search', async () => {
    fetchMock.mockResolvedValue(reply({ guid: 'g1' }));

    await adapter.grab(config, { guid: 'g1', indexerId: 4 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://prowlarr:9696/api/v1/search');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      guid: 'g1',
      indexerId: 4,
    });
  });

  describe('fetchNzb', () => {
    const nzb = (body = '<?xml version="1.0"?><nzb xmlns="x"></nzb>') =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-nzb',
          'Content-Disposition': 'attachment; filename="Jane.Doe.Beach.nzb"',
        },
      });

    it('fetches the NZB through Prowlarr, with its key only to Prowlarr', async () => {
      fetchMock.mockResolvedValue(nzb());

      const result = await adapter.fetchNzb(
        config,
        'http://prowlarr:9696/4/download?link=x',
      );

      expect(result.fileName).toBe('Jane.Doe.Beach.nzb');
      expect(new TextDecoder().decode(result.content)).toContain('<nzb');
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('key');

      fetchMock.mockResolvedValue(nzb());
      await adapter.fetchNzb(config, 'https://indexer.example/get/1');
      const [, other] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(
        (other.headers as Record<string, string>)['X-Api-Key'],
      ).toBeUndefined();
    });

    it('refuses something that isn’t an NZB', async () => {
      fetchMock.mockResolvedValue(nzb('<html>Login required</html>'));
      await expect(
        adapter.fetchNzb(config, 'http://prowlarr:9696/4/download'),
      ).rejects.toThrow('didn’t send an NZB');
    });

    it('refuses a link that isn’t a web address', async () => {
      await expect(
        adapter.fetchNzb(config, 'file:///etc/passwd'),
      ).rejects.toThrow('unusable download link');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('counts enabled indexers and names enabled download clients', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        reply(
          url.endsWith('/indexer')
            ? [{ enable: true }, { enable: false }, { enable: true }]
            : [
                { enable: true, name: 'qBittorrent' },
                { enable: false, name: 'SABnzbd' },
              ],
        ),
      ),
    );

    await expect(adapter.countEnabledIndexers(config)).resolves.toBe(2);
    await expect(adapter.listEnabledDownloadClients(config)).resolves.toEqual([
      'qBittorrent',
    ]);
  });
});
