import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { PlaybackSettingsService } from './playback-settings.service';
import { PlaybackTokenService } from './playback-token.service';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';

/** A tiny stand-in for Stash's /scene routes. */
function startFakeStash(): Promise<{
  server: Server;
  baseUrl: string;
  requests: IncomingMessage[];
}> {
  const video = Buffer.from('0123456789abcdefghij'); // 20 bytes
  const requests: IncomingMessage[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push(req);
    const url = new URL(req.url ?? '/', 'http://stash');
    if (req.headers.apikey !== 'stash-key') {
      res.writeHead(401).end();
      return;
    }

    if (url.pathname === '/scene/12/stream') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range && Number(range[1]) >= video.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${video.length}` });
        res.end();
        return;
      }
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : video.length - 1;
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${video.length}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        });
        res.end(video.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      });
      res.end(video);
      return;
    }

    if (url.pathname === '/scene/12/stream.m3u8') {
      // Like Stash: segment URLs are built from X-Forwarded-Prefix + request path.
      const prefix = req.headers['x-forwarded-prefix'];
      const base = `${typeof prefix === 'string' ? prefix : ''}${url.pathname}`;
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(
        `#EXTM3U\n#EXTINF:2,\n${base}/0.ts?resolution=${url.searchParams.get('resolution')}\n`,
      );
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requests,
      }),
    ),
  );
}

describe('PlaybackController stream proxy', () => {
  let app: INestApplication;
  let stash: Awaited<ReturnType<typeof startFakeStash>>;
  let tokens: PlaybackTokenService;
  const playbackSettings = {
    enabled: true,
    feedEnabled: true,
    previewsEnabled: true,
  };

  beforeAll(async () => {
    stash = await startFakeStash();
    const moduleRef = await Test.createTestingModule({
      controllers: [PlaybackController],
      providers: [
        PlaybackTokenService,
        {
          provide: PlaybackSettingsService,
          useValue: {
            get: () => Promise.resolve({ ...playbackSettings }),
          },
        },
        {
          provide: StashAdapter,
          useValue: { openSceneStream: StashAdapter.prototype.openSceneStream },
        },
        {
          provide: PlaybackService,
          useValue: {
            getStashConfig: () =>
              Promise.resolve({ baseUrl: stash.baseUrl, apiKey: 'stash-key' }),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tokens = app.get(PlaybackTokenService);
  });

  afterEach(() => {
    playbackSettings.enabled = true;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => stash.server.close(resolve));
  });

  it('streams the file and forwards Range so seeking works', async () => {
    const { token } = tokens.issue('12', 'abcdef0123456789');

    const full = await request(app.getHttpServer()).get(
      `/api/playback/stream/${token}/scene/12/stream`,
    );
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(Buffer.from(full.body as Buffer).toString()).toBe(
      '0123456789abcdefghij',
    );

    const part = await request(app.getHttpServer())
      .get(`/api/playback/stream/${token}/scene/12/stream`)
      .set('Range', 'bytes=10-14');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-14/20');
    expect(Buffer.from(part.body as Buffer).toString()).toBe('abcde');
  });

  it('lets the browser keep streamed media, but never an error', async () => {
    const { token } = tokens.issue('12', 'abcdef0123456789');
    const url = `/api/playback/stream/${token}/scene/12/stream`;

    const ok = await request(app.getHttpServer())
      .get(url)
      .set('Range', 'bytes=0-4');
    expect(ok.status).toBe(206);
    expect(ok.headers['cache-control']).toBe('private, max-age=3600');

    const failed = await request(app.getHttpServer())
      .get(url)
      .set('Range', 'bytes=99-');
    expect(failed.status).toBe(416);
    expect(failed.headers['cache-control']).toBe('no-store');
  });

  it('rewrites HLS segment links to come back through the token path', async () => {
    const { token } = tokens.issue('12', null);
    const res = await request(app.getHttpServer())
      .get(
        `/api/playback/stream/${token}/scene/12/stream.m3u8?resolution=FULL_HD&apikey=evil`,
      )
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString()));
        r.on('end', () => cb(null, text));
      });

    expect(res.status).toBe(200);
    expect(res.body).toContain(
      `/api/playback/stream/${token}/scene/12/stream.m3u8/0.ts?resolution=FULL_HD`,
    );
    const last = stash.requests[stash.requests.length - 1];
    expect(last.url).toBe('/scene/12/stream.m3u8?resolution=FULL_HD'); // apikey query dropped
  });

  it('refuses bad, expired or mismatched tokens and unknown paths', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/api/playback/stream/nonsense/scene/12/stream')
      .expect(403);

    const expired = tokens.issue('12', null, -10).token;
    await request(server)
      .get(`/api/playback/stream/${expired}/scene/12/stream`)
      .expect(403);

    const other = tokens.issue('99', null).token;
    await request(server)
      .get(`/api/playback/stream/${other}/scene/12/stream`)
      .expect(403);

    const ok = tokens.issue('12', null).token;
    await request(server)
      .get(`/api/playback/stream/${ok}/scene/12/../../graphql`)
      .expect(404);
    await request(server)
      .get(`/api/playback/stream/${ok}/scene/12/settings`)
      .expect(404);
  });

  it('refuses streams, previews and player info while playback is off', async () => {
    playbackSettings.enabled = false;
    const server = app.getHttpServer();
    const { token } = tokens.issue('12', 'abcdef0123456789');
    const before = stash.requests.length;

    const stream = await request(server)
      .get(`/api/playback/stream/${token}/scene/12/stream`)
      .expect(403);
    expect((stream.body as { message: string }).message).toBe(
      'Playback is turned off. Turn it on in Settings → Playback.',
    );
    await request(server).get('/api/playback/scenes/12/preview').expect(403);
    await request(server).post('/api/playback/scenes/12/play').expect(403);
    expect(stash.requests.length).toBe(before);
  });
});
