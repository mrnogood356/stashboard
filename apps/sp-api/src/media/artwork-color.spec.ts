import sharp from 'sharp';
import { ArtworkColorService } from './artwork-color.service';
import { allowedImageHost, vividColor } from './artwork-color.util';

describe('artwork colour', () => {
  it('only fetches from the catalog’s own sites', () => {
    const hosts = ['stashdb.org'];
    expect(
      allowedImageHost(new URL('https://cdn.stashdb.org/images/a'), hosts),
    ).toBe(true);
    expect(
      allowedImageHost(new URL('https://stashdb.org/images/a'), hosts),
    ).toBe(true);
    expect(allowedImageHost(new URL('https://evilstashdb.org/a'), hosts)).toBe(
      false,
    );
    expect(allowedImageHost(new URL('http://192.168.1.10/a'), hosts)).toBe(
      false,
    );
    expect(allowedImageHost(new URL('file:///etc/passwd'), hosts)).toBe(false);
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
