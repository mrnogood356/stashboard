import { fetchWithTimeout } from './fetch-with-timeout';
import {
  describeErrorResponse,
  ProviderResponseError,
  readJsonResponse,
  summarizeErrorBody,
} from './provider-response';

describe('provider responses', () => {
  it('parses a JSON body, and an empty one as null', async () => {
    await expect(
      readJsonResponse(new Response('{"data":{"a":1}}'), 'Stash'),
    ).resolves.toEqual({ data: { a: 1 } });
    await expect(
      readJsonResponse(new Response(''), 'Whisparr'),
    ).resolves.toBeNull();
  });

  it('explains a body that is not JSON, such as a proxy login page', async () => {
    const page =
      '<!doctype html><html><head><title>Sign in</title><style>body{}</style></head><body><h1>Please sign in</h1></body></html>';

    const error = await readJsonResponse(new Response(page), 'Stash').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as Error).message).toBe(
      `Stash replied with something that isn't JSON ("Sign in Please sign in"). Check its URL.`,
    );
  });

  it('cuts a long error page down to its text', async () => {
    const response = new Response(
      `<html><body><p>${'x'.repeat(5_000)}</p></body></html>`,
      { status: 502 },
    );

    const message = await describeErrorResponse(response, 'Stash provider');

    expect(message.startsWith('Stash provider returned 502: xxx')).toBe(true);
    expect(message).not.toContain('<');
    expect(message.length).toBeLessThan(250);
  });

  it('gives the status alone when there is no body', async () => {
    await expect(
      describeErrorResponse(new Response(null, { status: 401 }), 'Whisparr'),
    ).resolves.toBe('Whisparr returned 401');
    expect(summarizeErrorBody('  plain   text\n')).toBe('plain text');
  });

  describe('against a real server', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const http = require('node:http') as typeof import('node:http');
    let server: import('node:http').Server;
    let url: string;

    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        // Headers, then nothing: the body never finishes.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
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

    it('says a stalled reply timed out, not that it was bad JSON', async () => {
      const response = await fetchWithTimeout(url, {}, 200);

      await expect(readJsonResponse(response, 'Whisparr')).rejects.toThrow(
        new ProviderResponseError('Whisparr took too long to respond.'),
      );
    });
  });
});
