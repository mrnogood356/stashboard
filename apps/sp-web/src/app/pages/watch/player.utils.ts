import { PlaybackInfo, PlaybackSource } from '../../core/api/playback.service';

/** How a source is played: by the browser itself, or through hls.js. */
export type PlaybackEngine = 'native' | 'hls.js';

export interface PlaybackCandidate {
  source: PlaybackSource;
  engine: PlaybackEngine;
}

export interface PlayerEnvironment {
  /** HTMLMediaElement.canPlayType for this browser. */
  canPlayType: (type: string) => string;
  /** Whether hls.js can run here (Media Source Extensions available). */
  hlsJsSupported: boolean;
}

const VIDEO_CODECS: Record<string, string> = {
  h264: 'avc1.640028',
  avc1: 'avc1.640028',
  hevc: 'hvc1.1.6.L120.90',
  h265: 'hvc1.1.6.L120.90',
  vp9: 'vp09.00.10.08',
  vp8: 'vp8',
  av1: 'av01.0.05M.08',
};

const AUDIO_CODECS: Record<string, string> = {
  aac: 'mp4a.40.2',
  mp3: 'mp4a.40.34',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
  ac3: 'ac-3',
  eac3: 'ec-3',
};

const MP4_CONTAINERS = new Set(['mp4', 'm4v', 'mov']);

/**
 * Whether the browser can play the original file without Stash converting it.
 * Unknown codecs count as "maybe": the player tries it and falls back on error.
 */
export function canPlayOriginal(info: PlaybackInfo, env: PlayerEnvironment): boolean {
  const container = (info.container ?? '').toLowerCase();
  const mime = MP4_CONTAINERS.has(container)
    ? 'video/mp4'
    : container === 'webm'
      ? 'video/webm'
      : null;
  if (!mime) {
    return false; // MKV, WMV, AVI, FLV… browsers can't open these directly
  }

  const codecs = [
    VIDEO_CODECS[(info.videoCodec ?? '').toLowerCase()],
    AUDIO_CODECS[(info.audioCodec ?? '').toLowerCase()],
  ].filter((codec): codec is string => !!codec);

  const type = codecs.length > 0 ? `${mime}; codecs="${codecs.join(', ')}"` : mime;
  return env.canPlayType(type) !== '';
}

function canPlayHlsNatively(env: PlayerEnvironment): boolean {
  return env.canPlayType('application/vnd.apple.mpegurl') !== '';
}

function hlsCandidate(source: PlaybackSource, env: PlayerEnvironment): PlaybackCandidate | null {
  if (canPlayHlsNatively(env)) {
    return { source, engine: 'native' };
  }
  return env.hlsJsSupported ? { source, engine: 'hls.js' } : null;
}

/**
 * Sources to try, best first: the original file if the browser can play it,
 * then Stash's live conversion (HLS, then MP4). The player moves down the list
 * when a source fails, keeping the playback position.
 */
export function buildSourceChain(info: PlaybackInfo, env: PlayerEnvironment): PlaybackCandidate[] {
  const chain: PlaybackCandidate[] = [];
  const direct = info.sources.find((source) => source.kind === 'direct');
  if (direct && canPlayOriginal(info, env)) {
    chain.push({ source: direct, engine: 'native' });
  }

  const hls = preferOriginal(info.sources.filter((source) => source.kind === 'hls'));
  const hlsFirst = hls ? hlsCandidate(hls, env) : null;
  if (hlsFirst) {
    chain.push(hlsFirst);
  }

  const mp4 = preferOriginal(info.sources.filter((source) => source.kind === 'mp4'));
  if (mp4) {
    chain.push({ source: mp4, engine: 'native' });
  }

  // Last resort: the original even if the browser claims it can't play it.
  if (direct && !chain.some((candidate) => candidate.source === direct)) {
    chain.push({ source: direct, engine: 'native' });
  }

  return chain;
}

function preferOriginal(sources: PlaybackSource[]): PlaybackSource | null {
  return sources.find((source) => source.resolution === 'ORIGINAL') ?? sources[0] ?? null;
}

export interface QualityOption {
  id: string;
  label: string;
  candidate: PlaybackCandidate;
}

const RESOLUTION_LABELS: Record<string, string> = {
  ORIGINAL: 'Original quality',
  FOUR_K: '4K (2160p)',
  FULL_HD: '1080p',
  STANDARD_HD: '720p',
  STANDARD: '480p',
  LOW: '240p',
};

/** Choices for the quality menu: the original file, then converted resolutions. */
export function qualityOptions(info: PlaybackInfo, env: PlayerEnvironment): QualityOption[] {
  const options: QualityOption[] = [];
  const direct = info.sources.find((source) => source.kind === 'direct');
  if (direct) {
    options.push({
      id: 'direct',
      label: 'Original file',
      candidate: { source: direct, engine: 'native' },
    });
  }

  // Converted streams: prefer HLS (adapts better), else MP4.
  const converted = info.sources.filter((source) => source.kind === 'hls');
  const fallback = info.sources.filter((source) => source.kind === 'mp4');
  for (const source of converted.length > 0 ? converted : fallback) {
    const candidate =
      source.kind === 'hls' ? hlsCandidate(source, env) : { source, engine: 'native' as const };
    if (!candidate) {
      continue;
    }
    const resolution = source.resolution ?? 'ORIGINAL';
    options.push({
      id: `${source.kind}-${resolution}`,
      label: `${RESOLUTION_LABELS[resolution] ?? resolution} (converted)`,
      candidate,
    });
  }

  return options;
}

export interface ThumbnailCue {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function parseVttTime(value: string): number {
  const parts = value.trim().split(':').map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Parses Stash's sprite VTT ("image.jpg#xywh=x,y,w,h" cues) for scrub previews. */
export function parseThumbnailVtt(text: string, vttUrl: string): ThumbnailCue[] {
  const cues: ThumbnailCue[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const timing = /^\s*([\d:.]+)\s+-->\s+([\d:.]+)/.exec(lines[i]);
    if (!timing) {
      continue;
    }
    const target = (lines[i + 1] ?? '').trim();
    const match = /^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(target);
    if (!match) {
      continue;
    }
    let url: string;
    try {
      url = new URL(match[1], new URL(vttUrl, 'http://placeholder.invalid')).pathname;
    } catch {
      continue;
    }
    cues.push({
      start: parseVttTime(timing[1]),
      end: parseVttTime(timing[2]),
      url,
      x: Number(match[2]),
      y: Number(match[3]),
      width: Number(match[4]),
      height: Number(match[5]),
    });
  }

  return cues;
}

export function cueAt(cues: ThumbnailCue[], time: number): ThumbnailCue | null {
  return cues.find((cue) => time >= cue.start && time < cue.end) ?? cues[cues.length - 1] ?? null;
}

/** Resume where playback stopped, unless it was right at the start or the end. */
export function resumePosition(resumeTime: number, duration: number | null): number | null {
  if (!resumeTime || resumeTime < 10) {
    return null;
  }
  if (duration && resumeTime > duration - 30) {
    return null;
  }
  return resumeTime;
}

/** A watch counts as a play after 10% of the scene, but never more than two minutes. */
export function playCountThreshold(duration: number | null): number {
  if (!duration || duration <= 0) {
    return 60;
  }
  return Math.min(120, Math.max(10, duration * 0.1));
}

/** Near the end counts as finished, so the scene leaves Continue Watching. */
export function isFinished(position: number, duration: number | null): boolean {
  return !!duration && (position >= duration - 20 || position / duration >= 0.95);
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
