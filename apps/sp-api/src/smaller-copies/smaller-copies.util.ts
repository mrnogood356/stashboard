/** The settings as Prisma stores them, as far as the rules go. */
export interface StoredRules {
  targetResolution: string;
  replaceHigher: boolean;
  upgradeLower: boolean;
  maxGbPerHour: number | null;
  minGbPerHour: number | null;
  maxNewGbPerHour: number | null;
  minNewGbPerHour: number | null;
  minSavingsPercent: number;
  codec: string;
  prefer: string;
  matchStrength: string;
  studioMode: string;
  studioNames: string[];
}

/** Resolutions a rule can aim for, by the short side of the picture. */
export const TARGETS = ['2160p', '1080p', '720p'] as const;
export type Target = (typeof TARGETS)[number];
export type Resolution = Target | '480p';

export const CODEC_RULES = [
  'any',
  'prefer-efficient',
  'efficient-only',
] as const;
export const PREFER = ['largest', 'smallest'] as const;
export const MATCH = ['strong', 'partial'] as const;
export const STUDIO_MODES = ['all', 'only', 'skip'] as const;
export const OLD_COPY = ['delete', 'keep'] as const;

const RANK: Record<Resolution, number> = {
  '2160p': 4,
  '1080p': 3,
  '720p': 2,
  '480p': 1,
};
const GB = 1024 ** 3;

/** A release's resolution from its title ("…2160p…", "…4K…", "…1080p…"); null when it doesn't say. */
export function releaseResolution(title: string): Resolution | null {
  if (/\b(2160p|4k|uhd)\b/i.test(title)) {
    return '2160p';
  }
  if (/\b1080[pi]\b/i.test(title)) {
    return '1080p';
  }
  if (/\b720p\b/i.test(title)) {
    return '720p';
  }
  if (/\b(480p|576p|sd|xvid)\b/i.test(title)) {
    return '480p';
  }
  return null;
}

/** HEVC and AV1 fit the same picture in less space. */
export function releaseIsEfficient(title: string): boolean {
  return /\b(hevc|x265|h\.?265|av1)\b/i.test(title);
}

/** A file's resolution by its short side, as Library stats counts it. */
export function fileResolution(
  width: number | null,
  height: number | null,
): Resolution | null {
  const short = Math.min(width ?? 0, height ?? 0);
  if (!short) {
    return null;
  }
  return short >= 2000
    ? '2160p'
    : short >= 1000
      ? '1080p'
      : short >= 700
        ? '720p'
        : '480p';
}

export interface SmallerCopyRules {
  target: Target;
  replaceHigher: boolean;
  upgradeLower: boolean;
  /**
   * Sizes are per hour of video, so a rule means the same for a 20-minute
   * scene and a 2-hour one. At the target but heavier than this: replace.
   */
  maxGbPerHour: number | null;
  /** Leave files lighter than this alone. */
  minGbPerHour: number | null;
  /** The new copy's cap. */
  maxNewGbPerHour: number | null;
  /** The new copy's floor: anything lighter is too squeezed to swap in. */
  minNewGbPerHour: number | null;
  minSavingsPercent: number;
  codec: (typeof CODEC_RULES)[number];
  prefer: (typeof PREFER)[number];
  matchStrength: (typeof MATCH)[number];
  studioMode: (typeof STUDIO_MODES)[number];
  studioNames: string[];
}

export const DEFAULT_RULES: SmallerCopyRules = {
  target: '1080p',
  replaceHigher: true,
  upgradeLower: false,
  maxGbPerHour: null,
  minGbPerHour: null,
  maxNewGbPerHour: null,
  minNewGbPerHour: null,
  minSavingsPercent: 10,
  codec: 'any',
  prefer: 'largest',
  matchStrength: 'strong',
  studioMode: 'all',
  studioNames: [],
};

export type ReplaceReason = 'above-target' | 'below-target' | 'too-big';

/** GB per hour of video; null when the length isn't known. */
export function gbPerHour(
  size: number | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (!size || !durationSeconds || durationSeconds <= 0) {
    return null;
  }
  return size / GB / (durationSeconds / 3600);
}

/** Whether a library file is one the rules say to look for another copy of, and why. */
export function needsReplacing(
  file: {
    width: number | null;
    height: number | null;
    size: number | null;
    duration?: number | null;
    studioName?: string | null;
  },
  rules: SmallerCopyRules,
): ReplaceReason | null {
  const resolution = fileResolution(file.width, file.height);
  if (!resolution || !file.size) {
    return null;
  }
  const density = gbPerHour(file.size, file.duration);
  if (rules.minGbPerHour && density !== null && density < rules.minGbPerHour) {
    return null;
  }
  if (rules.studioMode !== 'all') {
    const names = new Set(rules.studioNames.map(studioKey));
    const listed = names.has(studioKey(file.studioName ?? ''));
    if (rules.studioMode === 'only' ? !listed : listed) {
      return null;
    }
  }
  if (RANK[resolution] > RANK[rules.target]) {
    return rules.replaceHigher ? 'above-target' : null;
  }
  if (RANK[resolution] < RANK[rules.target]) {
    return rules.upgradeLower ? 'below-target' : null;
  }
  return rules.maxGbPerHour && density !== null && density > rules.maxGbPerHour
    ? 'too-big'
    : null;
}

function studioKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface CandidateRelease {
  guid: string;
  indexerId: number;
  title: string;
  size: number | null;
  protocol: 'torrent' | 'usenet' | null;
  match: { strength: 'strong' | 'partial' | 'weak' } | null;
}

/**
 * The release to grab, or null. It must be the same scene (as sure as the
 * rules ask), from usenet (so it comes back through Finished downloads), at
 * the target resolution, within the size cap, in an efficient codec when
 * the rules insist, and, unless it's an upgrade, smaller by at least the
 * saving asked for. Of those: efficient codecs first when preferred, then
 * the biggest or the smallest.
 */
export function pickRelease(
  releases: CandidateRelease[],
  file: { size: number; duration?: number | null },
  reason: ReplaceReason,
  rules: SmallerCopyRules,
): CandidateRelease | null {
  const strengths =
    rules.matchStrength === 'partial' ? ['strong', 'partial'] : ['strong'];
  const fits = releases.filter((release) => {
    if (!release.match || !strengths.includes(release.match.strength)) {
      return false;
    }
    if (release.protocol !== 'usenet' || !release.size) {
      return false;
    }
    if (releaseResolution(release.title) !== rules.target) {
      return false;
    }
    if (
      rules.codec === 'efficient-only' &&
      !releaseIsEfficient(release.title)
    ) {
      return false;
    }
    // The release's own size over the scene's length: its weight per hour.
    const density = gbPerHour(release.size, file.duration);
    if (
      rules.maxNewGbPerHour &&
      density !== null &&
      density > rules.maxNewGbPerHour
    ) {
      return false;
    }
    if (
      rules.minNewGbPerHour &&
      density !== null &&
      density < rules.minNewGbPerHour
    ) {
      return false;
    }
    if (
      reason !== 'below-target' &&
      release.size > file.size * (1 - rules.minSavingsPercent / 100)
    ) {
      return false;
    }
    return true;
  });
  const bySize = (a: CandidateRelease, b: CandidateRelease) =>
    rules.prefer === 'smallest'
      ? (a.size ?? 0) - (b.size ?? 0)
      : (b.size ?? 0) - (a.size ?? 0);
  return (
    [...fits].sort((a, b) => {
      if (rules.codec === 'prefer-efficient') {
        const diff =
          Number(releaseIsEfficient(b.title)) -
          Number(releaseIsEfficient(a.title));
        if (diff !== 0) {
          return diff;
        }
      }
      if (a.match?.strength !== b.match?.strength) {
        return a.match?.strength === 'strong' ? -1 : 1;
      }
      return bySize(a, b);
    })[0] ?? null
  );
}

/** Whether searching is allowed at this hour; both null is any time, and a window can wrap midnight. */
export function inActiveHours(
  hour: number,
  from: number | null,
  to: number | null,
): boolean {
  if (from === null || to === null || from === to) {
    return true;
  }
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Two pictures this close (bits that differ in Stash's phash) are the same video. */
export const SAME_VIDEO_PHASH_DISTANCE = 10;

export interface CopyFile {
  size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  /** Stash's perceptual hash, hex; null when not made yet. */
  phash: string | null;
}

/** Bits that differ between two hex phashes; null when either can't be read. */
export function phashDistance(
  a: string | null,
  b: string | null,
): number | null {
  if (!a || !b || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) {
    return null;
  }
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (diff > 0n) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits;
}

/** Why a file was looked for again, from its resolution against the target. */
export function reasonFor(
  file: { width: number | null; height: number | null },
  target: Target,
): ReplaceReason {
  const resolution = fileResolution(file.width, file.height);
  if (resolution && RANK[resolution] < RANK[target]) {
    return 'below-target';
  }
  return resolution && RANK[resolution] > RANK[target]
    ? 'above-target'
    : 'too-big';
}

/**
 * The downloaded file, checked against the one it would replace before
 * anything is deleted: the same video (Stash's picture fingerprints, or
 * and a length within 3%; either one when only one can be read), at the resolution its name promised,
 * really smaller by the saving asked for (or really higher for an upgrade),
 * and within the rules' weight per hour. Null when it passes; otherwise why
 * not, in a sentence, and both files are kept.
 */
export function checkNewCopy(
  old: CopyFile,
  next: CopyFile,
  reason: ReplaceReason,
  rules: SmallerCopyRules,
): string | null {
  if (!next.duration || next.duration <= 0) {
    return 'The new file reads as 0 seconds long.';
  }
  if (!next.size || next.size <= 0) {
    return 'Stash couldn’t read the new file’s size.';
  }
  const distance = phashDistance(old.phash, next.phash);
  if (distance !== null && distance > SAME_VIDEO_PHASH_DISTANCE) {
    return 'The new file’s picture doesn’t match the old one’s, so it may be a different video.';
  }
  // A matching picture is still checked for length: a cut-down copy of the
  // same video looks the same.
  if (old.duration && old.duration > 0) {
    const gap = Math.abs(next.duration - old.duration);
    if (gap > Math.max(20, old.duration * 0.03)) {
      return `The new file runs ${minutes(next.duration)} and the old one ${minutes(old.duration)}.`;
    }
  } else if (distance === null) {
    return 'The old file has no fingerprint or length to compare the new one with.';
  }
  const before = fileResolution(old.width, old.height);
  const after = fileResolution(next.width, next.height);
  if (!after) {
    return 'Stash couldn’t read the new file’s picture size.';
  }
  if (reason === 'below-target') {
    if (before && RANK[after] <= RANK[before]) {
      return `The new file is ${after}, no better than the old ${before}.`;
    }
  } else {
    if (after !== rules.target) {
      return `The new file is ${after}, not the ${rules.target} its name said.`;
    }
    if (!old.size || old.size <= 0) {
      return 'Stash couldn’t read the old file’s size to compare.';
    }
    if (next.size > old.size * (1 - rules.minSavingsPercent / 100)) {
      return `The new file saves less than ${rules.minSavingsPercent}% of the old one’s size.`;
    }
  }
  const density = gbPerHour(next.size, next.duration);
  if (density !== null) {
    if (rules.minNewGbPerHour && density < rules.minNewGbPerHour) {
      return `The new file is ${density.toFixed(1)} GB an hour, under the ${rules.minNewGbPerHour} GB floor.`;
    }
    if (rules.maxNewGbPerHour && density > rules.maxNewGbPerHour) {
      return `The new file is ${density.toFixed(1)} GB an hour, over the ${rules.maxNewGbPerHour} GB cap.`;
    }
  }
  return null;
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

/** The rules out of the stored settings, unknown values back to the defaults. */
export function rulesOf(settings: StoredRules): SmallerCopyRules {
  return {
    target: oneOf<Target>(
      TARGETS,
      settings.targetResolution,
      DEFAULT_RULES.target,
    ),
    replaceHigher: settings.replaceHigher,
    upgradeLower: settings.upgradeLower,
    maxGbPerHour: settings.maxGbPerHour,
    minGbPerHour: settings.minGbPerHour,
    maxNewGbPerHour: settings.maxNewGbPerHour,
    minNewGbPerHour: settings.minNewGbPerHour,
    minSavingsPercent: settings.minSavingsPercent,
    codec: oneOf(CODEC_RULES, settings.codec, DEFAULT_RULES.codec),
    prefer: oneOf(PREFER, settings.prefer, DEFAULT_RULES.prefer),
    matchStrength: oneOf(
      MATCH,
      settings.matchStrength,
      DEFAULT_RULES.matchStrength,
    ),
    studioMode: oneOf(
      STUDIO_MODES,
      settings.studioMode,
      DEFAULT_RULES.studioMode,
    ),
    studioNames: settings.studioNames,
  };
}

function oneOf<T extends string>(
  list: readonly T[],
  value: string,
  fallback: T,
): T {
  return (list as readonly string[]).includes(value) ? (value as T) : fallback;
}
