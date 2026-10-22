import { describe, expect, it } from 'vitest';
import { PlaybackInfo } from '../../core/api/playback.service';
import {
  buildSourceChain,
  canPlayOriginal,
  cueAt,
  formatTime,
  isFinished,
  parseThumbnailVtt,
  playCountThreshold,
  qualityOptions,
  resumePosition,
} from './player.utils';

function info(overrides: Partial<PlaybackInfo> = {}): PlaybackInfo {
  return {
    sceneId: '12',
    title: 'Scene',
    studio: null,
    duration: 1800,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mp4',
    resumeTime: 0,
    playCount: 0,
    posterUrl: null,
    thumbnailsVttUrl: null,
    viewUrl: 'http://stash/scenes/12',
    expiresAt: 0,
    sources: [
      {
        kind: 'direct',
        label: 'Direct stream',
        mimeType: 'video/mp4',
        resolution: null,
        url: '/s/12/stream',
      },
      {
        kind: 'hls',
        label: 'HLS',
        mimeType: 'application/vnd.apple.mpegurl',
        resolution: 'ORIGINAL',
        url: '/s/12/stream.m3u8?resolution=ORIGINAL',
      },
      {
        kind: 'hls',
        label: 'HLS 720p',
        mimeType: 'application/vnd.apple.mpegurl',
        resolution: 'STANDARD_HD',
        url: '/s/12/stream.m3u8?resolution=STANDARD_HD',
      },
      {
        kind: 'mp4',
        label: 'MP4',
        mimeType: 'video/mp4',
        resolution: 'ORIGINAL',
        url: '/s/12/stream.mp4?resolution=ORIGINAL',
      },
    ],
    ...overrides,
  };
}

const chrome = {
  canPlayType: (type: string) =>
    type.startsWith('video/mp4') && !type.includes('hvc1') ? 'probably' : '',
  hlsJsSupported: true,
};
const safari = {
  canPlayType: (type: string) =>
    type.startsWith('video/mp4') || type === 'application/vnd.apple.mpegurl' ? 'probably' : '',
  hlsJsSupported: false,
};

describe('player source selection', () => {
  it('plays a browser-friendly file directly, with conversion as the fallback', () => {
    const chain = buildSourceChain(info(), chrome);
    expect(chain.map((c) => [c.source.kind, c.engine])).toEqual([
      ['direct', 'native'],
      ['hls', 'hls.js'],
      ['mp4', 'native'],
    ]);
  });

  it('uses Stash conversion first for files the browser cannot open (MKV, HEVC on Chrome)', () => {
    expect(canPlayOriginal(info({ container: 'matroska' }), chrome)).toBe(false);
    expect(canPlayOriginal(info({ videoCodec: 'hevc' }), chrome)).toBe(false);
    expect(canPlayOriginal(info({ videoCodec: 'hevc' }), safari)).toBe(true);

    const chain = buildSourceChain(info({ container: 'matroska' }), chrome);
    expect(chain[0].source.kind).toBe('hls');
    // The original is still tried last.
    expect(chain[chain.length - 1].source.kind).toBe('direct');
  });

  it('uses native HLS on Safari/iPhone instead of hls.js', () => {
    const chain = buildSourceChain(info({ container: 'avi' }), safari);
    expect(chain[0]).toEqual(expect.objectContaining({ engine: 'native' }));
    expect(chain[0].source.kind).toBe('hls');
  });

  it('offers the original and each converted resolution in the quality menu', () => {
    expect(qualityOptions(info(), chrome).map((option) => option.label)).toEqual([
      'Original file',
      'Original quality (converted)',
      '720p (converted)',
    ]);
  });
});

describe('scrub previews', () => {
  it('parses sprite cues relative to the VTT location', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:10.000',
      'abc_sprite.jpg#xywh=0,0,160,90',
      '',
      '00:00:10.000 --> 00:00:20.000',
      'abc_sprite.jpg#xywh=160,0,160,90',
    ].join('\n');
    const cues = parseThumbnailVtt(vtt, '/api/playback/stream/TOKEN/scene/abc_thumbs.vtt');

    expect(cues).toHaveLength(2);
    expect(cues[1]).toEqual({
      start: 10,
      end: 20,
      url: '/api/playback/stream/TOKEN/scene/abc_sprite.jpg',
      x: 160,
      y: 0,
      width: 160,
      height: 90,
    });
    expect(cueAt(cues, 12)?.x).toBe(160);
  });
});

describe('resume and play counting', () => {
  it('resumes only from a meaningful position', () => {
    expect(resumePosition(95, 1800)).toBe(95);
    expect(resumePosition(5, 1800)).toBeNull();
    expect(resumePosition(1790, 1800)).toBeNull();
  });

  it('counts a play after 10% of the scene, capped at two minutes', () => {
    expect(playCountThreshold(600)).toBe(60);
    expect(playCountThreshold(3600)).toBe(120);
    expect(playCountThreshold(null)).toBe(60);
  });

  it('treats the last moments as finished', () => {
    expect(isFinished(1785, 1800)).toBe(true);
    expect(isFinished(900, 1800)).toBe(false);
  });

  it('formats times', () => {
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
  });
});
