import sharp from 'sharp';
import { ArtworkColorService } from './artwork-color.service';
import { catalogImageUrl, vividColor } from './artwork-color.util';

describe('artwork colour', () => {
  it('only fetches from the catalog’s own sites, at an address it builds', () => {
    const hosts = ['stashdb.org'];
    const at = (raw: string) =>
      catalogImageUrl(new URL(raw), hosts)?.href ?? null;
    expect(at('https://cdn.stashdb.org/images/a?x=1')).toBe(
      'https://cdn.stashdb.org/images/a?x=1',
    );
    expect(at('https://stashdb.org/images/a')).toBe(
      'https://stashdb.org/images/a',
    );
    expect(at('https://evilstashdb.org/a')).toBeNull();
    expect(at('https://evil.cdn.stashdb.org/a')).toBeNull();
    expect(at('https://user:pw@stashdb.org.evil.com/a')).toBeNull();
    expect(at('http://192.168.1.10/a')).toBeNull();
    expect(at('file:///etc/passwd')).toBeNull();
    // A self-hosted catalog on its own port.
    expect(
      catalogImageUrl(new URL('http://box.lan:9998/img/a'), ['box.lan:9998'])
        ?.href,
    ).toBe('http://box.lan:9998/img/a');
  });

  it('picks the vivid hue, and nothing from a grey picture', () => {
    const red = new Uint8Array(
      Array.from({ length: 64 }, () => [220, 30, 60]).flat(),
    );
    const color = vividColor(red, 3);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect(parseInt(color!.slice(1, 3), 16)).toBeGreaterThan(
      parseInt(color!.slice(3, 5), 16),
    );
    const grey = new Uint8Array(
      Array.from({ length: 64 }, () => [128, 128, 128]).flat(),
    );
    expect(vividColor(grey, 3)).toBeNull();
  });

  it('reads a catalog picture’s colour once, and refuses other hosts without asking', async () => {
    const png = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 3,
        background: { r: 30, g: 90, b: 220 },
      },
    })
      .png()
      .toBuffer();
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(new Uint8Array(png), { status: 200 }));
    const realFetch = global.fetch;
    global.fetch = fetchMock as never;
    try {
      const prisma = {
        integrationConfig: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ baseUrl: 'https://stashdb.org/graphql' }]),
        },
      };
      const service = new ArtworkColorService(prisma as never);

      const color = await service.colorOf(
        'https://cdn.stashdb.org/images/x.jpg',
      );
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      // Blue: the blue channel leads.
      expect(parseInt(color!.slice(5, 7), 16)).toBeGreaterThan(
        parseInt(color!.slice(1, 3), 16),
      );
      await service.colorOf('https://cdn.stashdb.org/images/x.jpg');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await expect(
        service.colorOf('http://10.0.0.5/secret.png'),
      ).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // No length sent, and more than the limit: dropped while reading.
      let pulled = 0;
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      fetchMock.mockResolvedValueOnce(new Response(endless, { status: 200 }));
      await expect(
        service.colorOf('https://cdn.stashdb.org/images/huge.jpg'),
      ).resolves.toBeNull();
      expect(pulled).toBeLessThan(20);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('stops reading a picture that runs past the size limit with no length given', async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024 * 1024;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const realFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(endless, { status: 200 })) as never;
    try {
      const prisma = {
        integrationConfig: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ baseUrl: 'https://stashdb.org/graphql' }]),
        },
      };
      const service = new ArtworkColorService(prisma as never);
      await expect(
        service.colorOf('https://cdn.stashdb.org/images/huge.jpg'),
      ).resolves.toBeNull();
      expect(sent).toBeLessThan(12 * 1024 * 1024);
    } finally {
      global.fetch = realFetch;
    }
  });
});
