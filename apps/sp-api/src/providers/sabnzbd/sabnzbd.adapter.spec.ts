import { BadGatewayException, Logger } from '@nestjs/common';
import { SabnzbdAdapter } from './sabnzbd.adapter';

describe('SabnzbdAdapter', () => {
  const config = { baseUrl: 'http://sab:8080/sabnzbd/', apiKey: ' key ' };
  let adapter: SabnzbdAdapter;
  let originalFetch: typeof fetch;
  const fetchMock = jest.fn();

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const calledUrl = (index = 0) =>
    new URL((fetchMock.mock.calls[index] as [string])[0]);

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
    adapter = new SabnzbdAdapter();
  });

  it('asks for the version with the API key', async () => {
    fetchMock.mockResolvedValue(reply({ version: '4.3.2' }));

    await expect(adapter.getVersion(config)).resolves.toBe('4.3.2');

    const url = calledUrl();
    expect(url.pathname).toBe('/sabnzbd/api');
    expect(url.searchParams.get('mode')).toBe('version');
    expect(url.searchParams.get('output')).toBe('json');
    expect(url.searchParams.get('apikey')).toBe('key');
  });

  it('says plainly when the API key is wrong (SABnzbd answers 200)', async () => {
    fetchMock.mockResolvedValue(
      reply({ status: false, error: 'API Key Incorrect' }),
    );
    await expect(adapter.listCategories(config)).rejects.toThrow(
      'SABnzbd refused the API key',
    );
  });

  it('says plainly when SABnzbd can’t be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(adapter.testConnection(config)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('lists categories', async () => {
    fetchMock.mockResolvedValue(
      reply({ categories: ['*', 'xxx', 'stashboard', 7] }),
    );
    await expect(adapter.listCategories(config)).resolves.toEqual([
      '*',
      'xxx',
      'stashboard',
    ]);
    expect(calledUrl().searchParams.get('mode')).toBe('get_cats');
  });

  it('works out a category’s folder under the completed folder', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new URL(url).searchParams.get('section') === 'misc'
          ? reply({
              config: { misc: { complete_dir: '/downloads/complete/' } },
            })
          : reply({
              config: {
                categories: [
                  { name: 'xxx', dir: 'xxx' },
                  { name: 'stashboard', dir: 'stashboard-downloads' },
                  { name: 'abs', dir: '/elsewhere/abs' },
                ],
              },
            }),
      ),
    );
    await expect(adapter.categoryFolder(config, 'Stashboard')).resolves.toBe(
      '/downloads/complete/stashboard-downloads',
    );
    await expect(adapter.categoryFolder(config, 'abs')).resolves.toBe(
      '/elsewhere/abs',
    );
    await expect(
      adapter.categoryFolders(config, 'stashboard'),
    ).resolves.toEqual({
      completed: '/downloads/complete',
      category: '/downloads/complete/stashboard-downloads',
      found: true,
      ownFolder: true,
      jobFolders: true,
    });
  });

  it('leaves the “no job folders” star off a category’s folder, and says when one is missing', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new URL(url).searchParams.get('section') === 'misc'
          ? reply({ config: { misc: { complete_dir: '/downloads/complete' } } })
          : reply({
              config: {
                categories: [
                  { name: 'stashboard', dir: 'stashboard-downloads*' },
                  { name: 'abs', dir: '/elsewhere/abs/*' },
                  { name: 'plain', dir: '' },
                ],
              },
            }),
      ),
    );
    // SABnzbd's folder is “stashboard-downloads”; looking in
    // “stashboard-downloads*” found nothing, so drop-ins were never seen.
    await expect(
      adapter.categoryFolders(config, 'stashboard'),
    ).resolves.toEqual({
      completed: '/downloads/complete',
      category: '/downloads/complete/stashboard-downloads',
      found: true,
      ownFolder: true,
      jobFolders: false,
    });
    await expect(adapter.categoryFolder(config, 'abs')).resolves.toBe(
      '/elsewhere/abs',
    );
    await expect(adapter.categoryFolders(config, 'plain')).resolves.toEqual({
      completed: '/downloads/complete',
      category: '/downloads/complete',
      found: true,
      ownFolder: false,
      jobFolders: true,
    });
    await expect(adapter.categoryFolders(config, 'missing')).resolves.toEqual({
      completed: '/downloads/complete',
      category: '/downloads/complete',
      found: false,
      ownFolder: false,
      jobFolders: true,
    });
  });

  it('uploads an NZB to one category and returns its id', async () => {
    fetchMock.mockResolvedValue(
      reply({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }),
    );

    await expect(
      adapter.addNzb(config, {
        content: new TextEncoder().encode('<nzb></nzb>'),
        fileName: 'Release.nzb',
        category: 'stashboard',
        name: 'Release',
      }),
    ).resolves.toBe('SABnzbd_nzo_abc');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = calledUrl();
    expect(init.method).toBe('POST');
    expect(url.searchParams.get('mode')).toBe('addfile');
    expect(url.searchParams.get('cat')).toBe('stashboard');
    expect(url.searchParams.get('nzbname')).toBe('Release');
    const file = (init.body as FormData).get('name') as File;
    expect(file.name).toBe('Release.nzb');
  });

  it('fails plainly when SABnzbd doesn’t take the NZB', async () => {
    fetchMock.mockResolvedValue(
      reply({ status: false, error: 'Unknown category' }),
    );
    await expect(
      adapter.addNzb(config, {
        content: new Uint8Array([1]),
        fileName: 'x.nzb',
        category: 'stashboard',
        name: 'x',
      }),
    ).rejects.toThrow('SABnzbd didn’t take the download: Unknown category');
  });

  it('reads one category’s history and queue', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        new URL(url).searchParams.get('mode') === 'history'
          ? reply({
              history: {
                slots: [
                  {
                    nzo_id: 'SABnzbd_nzo_1',
                    name: 'Release',
                    category: 'stashboard',
                    status: 'Completed',
                    storage: '/downloads/complete/stashboard-downloads/Release',
                    fail_message: '',
                    completed: 1792656000,
                  },
                  { name: 'no id' },
                ],
              },
            })
          : reply({
              queue: {
                slots: [
                  {
                    nzo_id: 'SABnzbd_nzo_2',
                    filename: 'Other.Release',
                    cat: 'stashboard',
                    status: 'Downloading',
                    percentage: '42',
                    timeleft: '0:12:30',
                  },
                ],
              },
            }),
      ),
    );

    await expect(adapter.history(config, 'stashboard')).resolves.toEqual([
      {
        nzoId: 'SABnzbd_nzo_1',
        name: 'Release',
        category: 'stashboard',
        status: 'Completed',
        storage: '/downloads/complete/stashboard-downloads/Release',
        failMessage: null,
        completedAt: new Date(1792656000 * 1000),
      },
    ]);
    expect(calledUrl().searchParams.get('category')).toBe('stashboard');
    expect(calledUrl().searchParams.has('start')).toBe(false);
    await adapter.history(config, 'stashboard', 200);
    expect(calledUrl().searchParams.get('start')).toBe('200');
    await expect(adapter.queue(config, 'stashboard')).resolves.toEqual([
      {
        nzoId: 'SABnzbd_nzo_2',
        name: 'Other.Release',
        category: 'stashboard',
        status: 'Downloading',
        percentage: 42,
        timeLeft: '0:12:30',
      },
    ]);
  });
});
