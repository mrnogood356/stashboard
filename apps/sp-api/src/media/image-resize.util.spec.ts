import sharp from 'sharp';
import { normalizeThumbnailWidth, resizeToWebp } from './image-resize.util';

describe('image resize util', () => {
  it('snaps requested widths to the supported set and ignores junk', () => {
    expect(normalizeThumbnailWidth('480')).toBe(480);
    expect(normalizeThumbnailWidth('500')).toBe(480);
    expect(normalizeThumbnailWidth('5000')).toBe(960);
    expect(normalizeThumbnailWidth('10')).toBe(320);
    expect(normalizeThumbnailWidth(undefined)).toBeNull();
    expect(normalizeThumbnailWidth('abc')).toBeNull();
    expect(normalizeThumbnailWidth('-5')).toBeNull();
  });

  it('shrinks an image to WebP at the requested width', async () => {
    const original = await sharp({
      create: { width: 1600, height: 1000, channels: 3, background: '#335' },
    })
      .jpeg()
      .toBuffer();

    const resized = await resizeToWebp(original, 480);

    expect(resized?.contentType).toBe('image/webp');
    const info = await sharp(resized!.body).metadata();
    expect(info.width).toBe(480);
    expect(info.format).toBe('webp');
  });

  it('never enlarges small images', async () => {
    const small = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();

    const resized = await resizeToWebp(small, 960);
    expect((await sharp(resized!.body).metadata()).width).toBe(200);
  });

  it('returns null for data that is not an image', async () => {
    await expect(
      resizeToWebp(Buffer.from('not an image'), 480),
    ).resolves.toBeNull();
  });
});
