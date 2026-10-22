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
  const controller = new MediaController(service);

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
