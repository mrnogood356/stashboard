/** One video file from Stash, as the stats need it. */
export interface StatsFile {
  sceneId: string;
  title: string;
  studioId: string | null;
  studioName: string | null;
  size: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  duration: number | null;
}

export type ResolutionBucket = '4k' | '1080p' | '720p' | 'sd' | 'unknown';

export interface StatsBucket<K extends string = string> {
  key: K;
  label: string;
  files: number;
  bytes: number;
}

export interface StatsFileEntry {
  sceneId: string;
  title: string;
  studioName: string | null;
  bytes: number;
  resolution: string | null;
  codec: string | null;
  duration: number | null;
  /** For re-encode candidates: about how much smaller it could get. */
  saving?: number;
}

export interface LibraryStatsDto {
  computedAt: string;
  scenes: number;
  files: number;
  bytes: number;
  /** Seconds of video in all. */
  duration: number;
  byResolution: StatsBucket<ResolutionBucket>[];
  byCodec: StatsBucket[];
  topStudios: Array<StatsBucket & { studioId: string }>;
  biggest: StatsFileEntry[];
  reencode: {
    /** About how much H.264 and older files would shrink in all. */
    saving: number;
    files: number;
    top: StatsFileEntry[];
  };
}

/**
 * How much smaller a file gets, roughly, re-encoded to HEVC or AV1 at the
 * same quality. Only a rule of thumb: it depends on the encoder and settings.
 */
const REENCODE_SAVING: Record<string, number> = {
  h264: 0.45,
  mpeg4: 0.6,
  mpeg2video: 0.65,
  wmv3: 0.6,
  vc1: 0.55,
  msmpeg4v3: 0.6,
};
/** Files smaller than this aren't worth re-encoding. */
const REENCODE_MIN_BYTES = 500 * 1024 * 1024;
const LIST = 20;
const TOP_STUDIOS = 12;

const RESOLUTIONS: Array<{ key: ResolutionBucket; label: string }> = [
  { key: '4k', label: '4K' },
  { key: '1080p', label: '1080p' },
  { key: '720p', label: '720p' },
  { key: 'sd', label: 'Below 720p' },
  { key: 'unknown', label: 'Unknown' },
];

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC (H.265)',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  wmv3: 'WMV',
  vc1: 'VC-1',
};

/** The short side decides, so a portrait 1080×1920 video counts as 1080p. */
export function resolutionOf(
  width: number | null,
  height: number | null,
): ResolutionBucket {
  if (!width || !height) {
    return 'unknown';
  }
  const short = Math.min(width, height);
  return short >= 2000
    ? '4k'
    : short >= 1000
      ? '1080p'
      : short >= 700
        ? '720p'
        : 'sd';
}

export function codecLabel(codec: string | null): string {
  if (!codec) {
    return 'Unknown';
  }
  return CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function computeLibraryStats(
  files: StatsFile[],
  now = new Date(),
): LibraryStatsDto {
  const scenes = new Set<string>();
  const resolution = new Map<ResolutionBucket, StatsBucket<ResolutionBucket>>(
    RESOLUTIONS.map(({ key, label }) => [
      key,
      { key, label, files: 0, bytes: 0 },
    ]),
  );
  const codecs = new Map<string, StatsBucket>();
  const studios = new Map<string, StatsBucket & { studioId: string }>();
  let bytes = 0;
  let duration = 0;
  let reencodeSaving = 0;
  let reencodeFiles = 0;
  const candidates: StatsFileEntry[] = [];

  for (const file of files) {
    scenes.add(file.sceneId);
    bytes += file.size;
    duration += file.duration ?? 0;

    const res = resolution.get(resolutionOf(file.width, file.height))!;
    res.files += 1;
    res.bytes += file.size;

    const codecKey = file.codec?.toLowerCase() ?? 'unknown';
    const codec = codecs.get(codecKey) ?? {
      key: codecKey,
      label: codecLabel(file.codec),
      files: 0,
      bytes: 0,
    };
    codec.files += 1;
    codec.bytes += file.size;
    codecs.set(codecKey, codec);

    if (file.studioId) {
      const studio = studios.get(file.studioId) ?? {
        key: file.studioId,
        studioId: file.studioId,
        label: file.studioName ?? 'Unknown studio',
        files: 0,
        bytes: 0,
      };
      studio.files += 1;
      studio.bytes += file.size;
      studios.set(file.studioId, studio);
    }

    const share = REENCODE_SAVING[codecKey];
    if (share && file.size >= REENCODE_MIN_BYTES) {
      const saving = Math.round(file.size * share);
      reencodeSaving += saving;
      reencodeFiles += 1;
      candidates.push({ ...entry(file), saving });
    }
  }

  const bySize = (left: { bytes: number }, right: { bytes: number }) =>
    right.bytes - left.bytes;
  return {
    computedAt: now.toISOString(),
    scenes: scenes.size,
    files: files.length,
    bytes,
    duration: Math.round(duration),
    byResolution: [...resolution.values()].filter((bucket) => bucket.files > 0),
    byCodec: [...codecs.values()].sort(bySize),
    topStudios: [...studios.values()].sort(bySize).slice(0, TOP_STUDIOS),
    biggest: files.map(entry).sort(bySize).slice(0, LIST),
    reencode: {
      saving: reencodeSaving,
      files: reencodeFiles,
      top: candidates
        .sort((left, right) => (right.saving ?? 0) - (left.saving ?? 0))
        .slice(0, LIST),
    },
  };
}

function entry(file: StatsFile): StatsFileEntry {
  const bucket = resolutionOf(file.width, file.height);
  return {
    sceneId: file.sceneId,
    title: file.title,
    studioName: file.studioName,
    bytes: file.size,
    resolution:
      bucket === 'unknown'
        ? null
        : bucket === 'sd'
          ? `${Math.min(file.width!, file.height!)}p`
          : RESOLUTIONS.find((entry) => entry.key === bucket)!.label,
    codec: file.codec ? codecLabel(file.codec) : null,
    duration: file.duration,
  };
}
