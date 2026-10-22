import {
  filterStreamQuery,
  hashFromVttPath,
  parseStashStreamPath,
  toStreamSources,
} from './stash-stream.util';

describe('stash stream helpers', () => {
  it('only allows known scene and sprite paths', () => {
    expect(parseStashStreamPath('12/stream')).toEqual({
      kind: 'scene',
      sceneId: '12',
      rest: '12/stream',
    });
    expect(parseStashStreamPath('12/stream.m3u8/3.ts')).toMatchObject({
      kind: 'scene',
      sceneId: '12',
    });
    expect(parseStashStreamPath('abcdef0123456789_thumbs.vtt')).toMatchObject({
      kind: 'hash',
      hash: 'abcdef0123456789',
    });
    expect(parseStashStreamPath('12/../13/stream')).toBeNull();
    expect(parseStashStreamPath('12/funscript')).toBeNull();
    expect(parseStashStreamPath('graphql')).toBeNull();
  });

  it('forwards only safe query parameters', () => {
    expect(
      filterStreamQuery({
        resolution: 'FULL_HD',
        apikey: 'x',
        foo: 'y',
      }).toString(),
    ).toBe('resolution=FULL_HD');
  });

  it('maps Stash stream endpoints to player sources, skipping DASH, MKV and other scenes', () => {
    const sources = toStreamSources('12', [
      {
        url: 'http://stash:9999/scene/12/stream?apikey=k',
        mime_type: 'video/mp4',
        label: 'Direct stream',
      },
      {
        url: 'http://stash:9999/scene/12/stream.m3u8?resolution=FULL_HD',
        label: 'HLS Full HD (1080p)',
      },
      {
        url: 'http://stash:9999/scene/12/stream.mp4?resolution=STANDARD_HD',
        label: 'MP4 HD (720p)',
      },
      {
        url: 'http://stash:9999/scene/12/stream.mpd?resolution=ORIGINAL',
        label: 'DASH',
      },
      { url: 'http://stash:9999/scene/12/stream.mkv', label: 'MKV' },
      { url: 'http://stash:9999/scene/13/stream', label: 'Other' },
    ]);

    expect(sources).toEqual([
      expect.objectContaining({
        kind: 'direct',
        stashPath: '12/stream',
        resolution: null,
      }),
      expect.objectContaining({
        kind: 'hls',
        stashPath: '12/stream.m3u8?resolution=FULL_HD',
        mimeType: 'application/vnd.apple.mpegurl',
      }),
      expect.objectContaining({
        kind: 'mp4',
        stashPath: '12/stream.mp4?resolution=STANDARD_HD',
      }),
    ]);
  });

  it('reads the file hash from the sprite VTT path', () => {
    expect(
      hashFromVttPath('http://stash:9999/scene/abcdef0123456789_thumbs.vtt'),
    ).toBe('abcdef0123456789');
    expect(hashFromVttPath(null)).toBeNull();
  });
});
