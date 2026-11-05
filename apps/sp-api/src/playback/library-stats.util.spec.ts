import {
  type StatsFile,
  computeLibraryStats,
  resolutionOf,
} from './library-stats.util';

const GB = 1024 ** 3;
const file = (over: Partial<StatsFile>): StatsFile => ({
  sceneId: '1',
  title: 'A',
  studioId: 's1',
  studioName: 'Studio One',
  size: GB,
  width: 1920,
  height: 1080,
  codec: 'h264',
  duration: 1800,
  ...over,
});

describe('library stats', () => {
  it('goes by the short side, so portrait video isn’t called 4K', () => {
    expect(resolutionOf(3840, 2160)).toBe('4k');
    expect(resolutionOf(1080, 1920)).toBe('1080p');
    expect(resolutionOf(1280, 720)).toBe('720p');
    expect(resolutionOf(854, 480)).toBe('sd');
    expect(resolutionOf(null, 480)).toBe('unknown');
  });

  it('adds up size by resolution, codec and studio', () => {
    const stats = computeLibraryStats([
      file({
        sceneId: '1',
        size: 4 * GB,
        width: 3840,
        height: 2160,
        codec: 'hevc',
      }),
      file({ sceneId: '2', size: 2 * GB }),
      // A second file of scene 2: counted as a file, not another scene.
      file({ sceneId: '2', size: GB, studioId: 's2', studioName: 'Two' }),
      file({
        sceneId: '3',
        size: GB / 2,
        width: 640,
        height: 360,
        studioId: null,
      }),
    ]);
    expect(stats).toMatchObject({ scenes: 3, files: 4, bytes: 7.5 * GB });
    expect(
      stats.byResolution.map((bucket) => [bucket.label, bucket.files]),
    ).toEqual([
      ['4K', 1],
      ['1080p', 2],
      ['Below 720p', 1],
    ]);
    expect(stats.byCodec.map((bucket) => bucket.label)).toEqual([
      'HEVC (H.265)',
      'H.264',
    ]);
    expect(
      stats.topStudios.map((studio) => [studio.label, studio.bytes]),
    ).toEqual([
      ['Studio One', 6 * GB],
      ['Two', GB],
    ]);
    expect(stats.biggest[0]).toMatchObject({
      sceneId: '1',
      resolution: '4K',
      codec: 'HEVC (H.265)',
    });
    expect(stats.biggest.at(-1)).toMatchObject({ resolution: '360p' });
  });

  it('estimates what re-encoding older codecs would save, ignoring small files', () => {
    const stats = computeLibraryStats([
      file({ sceneId: '1', size: 10 * GB, codec: 'h264' }),
      file({ sceneId: '2', size: 4 * GB, codec: 'hevc' }),
      file({ sceneId: '3', size: 100 * 1024 * 1024, codec: 'h264' }),
    ]);
    expect(stats.reencode.files).toBe(1);
    expect(stats.reencode.saving).toBe(Math.round(10 * GB * 0.45));
    expect(stats.reencode.top[0]).toMatchObject({ sceneId: '1' });
  });
});
