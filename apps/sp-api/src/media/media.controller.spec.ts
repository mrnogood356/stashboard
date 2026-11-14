import type { Response } from 'express';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

describe('MediaController', () => {
  function fakeResponse() {
    const headers: Record<string, string> = {};
    const response = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      status: () => response,
      end: () => response,
    };
    return { response: response as unknown as Response, headers };
  }

  const service = {
    getStashSceneScreenshot: jest.fn().mockResolvedValue({
      body: Buffer.from('x'),
      contentType: 'image/jpeg',
    }),
  } as unknown as MediaService;
  const controller = new MediaController(service, {
    colorOf: jest.fn(),
  } as never);

  it('lets the browser keep a versioned image for good, an unversioned one for a day', async () => {
    const versioned = fakeResponse();
    await controller.getStashSceneScreenshot(
      '12',
      '480',
      '1712345678',
      versioned.response,
    );
    expect(versioned.headers['Cache-Control']).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(service.getStashSceneScreenshot).toHaveBeenLastCalledWith(
      '12',
      480,
      '1712345678',
    );

    const plain = fakeResponse();
    await controller.getStashSceneScreenshot(
      '12',
      undefined,
      undefined,
      plain.response,
    );
    expect(plain.headers['Cache-Control']).toBe('private, max-age=86400');
  });
});

describe('MediaController accent', () => {
  it('reads one address only, and no list of them', async () => {
    const artworkColor = { colorOf: jest.fn().mockResolvedValue('#123456') };
    const controller = new MediaController({} as never, artworkColor as never);

    await expect(
      controller.getAccent(['https://cdn.stashdb.org/a', 'https://x/b']),
    ).resolves.toEqual({ color: null });
    await expect(controller.getAccent(undefined)).resolves.toEqual({
      color: null,
    });
    expect(artworkColor.colorOf).not.toHaveBeenCalled();

    await expect(
      controller.getAccent('https://cdn.stashdb.org/a'),
    ).resolves.toEqual({ color: '#123456' });
  });
});
