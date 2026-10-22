import { stashImageVersion } from '../providers/stash/stash-image-version.util';
import { normalizeImageVersion } from './media.controller';
import { stashMediaUrl } from './media-url.util';

describe('image versions', () => {
  it('uses the update stamp Stash puts on its image paths', () => {
    expect(
      stashImageVersion('http://stash:9999/scene/12/screenshot?t=1712345678'),
    ).toBe('1712345678');
    expect(
      stashImageVersion('http://stash:9999/scene/12/screenshot?t=1712399999'),
    ).toBe('1712399999');
  });

  it('versions a path without a stamp by its text, and has none without a path', () => {
    const version = stashImageVersion('http://stash/s.jpg');
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(stashImageVersion('http://stash/other.jpg')).not.toBe(version);
    expect(stashImageVersion(null)).toBeNull();
    expect(stashImageVersion('  ')).toBeNull();
  });

  it('treats Stash’s placeholder pictures as no picture when asked', () => {
    const placeholder = 'http://stash/performer/1/image?t=5&default=true';
    expect(stashImageVersion(placeholder, { realOnly: true })).toBeNull();
    expect(stashImageVersion(placeholder)).toBe('5');
  });

  it('builds proxy addresses with the version and width', () => {
    expect(stashMediaUrl('scenes/12/screenshot', '171', 480)).toBe(
      '/api/media/stash/scenes/12/screenshot?v=171&w=480',
    );
    expect(stashMediaUrl('studios/5/logo', '9')).toBe(
      '/api/media/stash/studios/5/logo?v=9',
    );
    expect(stashMediaUrl('studios/5/logo', null)).toBe(
      '/api/media/stash/studios/5/logo',
    );
  });

  it('accepts only plain versions from a request', () => {
    expect(normalizeImageVersion('1712345678')).toBe('1712345678');
    expect(normalizeImageVersion('../../etc')).toBeNull();
    expect(normalizeImageVersion(['1', '2'])).toBeNull();
    expect(normalizeImageVersion(undefined)).toBeNull();
  });
});
