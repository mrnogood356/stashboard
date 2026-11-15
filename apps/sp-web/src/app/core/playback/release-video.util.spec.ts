import { describe, expect, it, vi } from 'vitest';
import { releaseVideo } from './release-video.util';

describe('releaseVideo', () => {
  it('pauses, drops the source and loads empty, so nothing keeps playing', () => {
    const video = document.createElement('video');
    video.setAttribute('src', '/api/stream/1');
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const load = vi.spyOn(video, 'load').mockImplementation(() => undefined);
    releaseVideo(video);
    expect(pause).toHaveBeenCalled();
    expect(video.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalled();
    expect(() => releaseVideo(null)).not.toThrow();
  });
});
