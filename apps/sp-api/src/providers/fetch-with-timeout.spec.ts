import { fetchWithTimeout } from './fetch-with-timeout';

describe('fetchWithTimeout', () => {
  let originalFetch: typeof fetch;
  const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();

  beforeAll(() => {
    originalFetch = global.fetch;
    Object.assign(global, { fetch: fetchMock });
  });

  afterAll(() => {
    Object.assign(global, { fetch: originalFetch });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('passes an abort signal to fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    await fetchWithTimeout('http://provider.local/graphql', {
      method: 'POST',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://provider.local/graphql',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('aborts a provider request after the timeout', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal;

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const request = fetchWithTimeout('http://provider.local/graphql', {}, 25);
    const expectation = expect(request).rejects.toMatchObject({
      name: 'AbortError',
    });

    await jest.advanceTimersByTimeAsync(25);
    await expectation;
  });

  it('preserves cancellation from a caller abort signal', async () => {
    const callerController = new AbortController();
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal;

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('Caller aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const request = fetchWithTimeout(
      'http://provider.local/graphql',
      {
        signal: callerController.signal,
      },
      30_000,
    );
    const expectation = expect(request).rejects.toMatchObject({
      name: 'AbortError',
    });

    callerController.abort();

    await expectation;
  });
});

describe('fetchWithTimeout against a real server', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http') as typeof import('node:http');
  let server: import('node:http').Server;
  let url: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/stall') {
        // Headers, then nothing: the body never finishes.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as import('node:net').AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads a normal response', async () => {
    const response = await fetchWithTimeout(`${url}/ok`, {}, 1_000);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('gives up on a body that stalls after the headers', async () => {
    const started = Date.now();
    const response = await fetchWithTimeout(`${url}/stall`, {}, 200);
    await expect(response.text()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
