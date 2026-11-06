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
  /** At the target but bigger than this: replace. */
  maxFileSizeGb: number | null;
  /** Leave files smaller than this alone. */
  minFileSizeGb: number | null;
  /** The new copy's size cap. */
  maxNewSizeGb: number | null;
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
  maxFileSizeGb: null,
  minFileSizeGb: null,
  maxNewSizeGb: null,
  minSavingsPercent: 10,
  codec: 'any',
  prefer: 'largest',
  matchStrength: 'strong',
  studioMode: 'all',
  studioNames: [],
};

export type ReplaceReason = 'above-target' | 'below-target' | 'too-big';

/** Whether a library file is one the rules say to look for another copy of, and why. */
export function needsReplacing(
  file: {
    width: number | null;
    height: number | null;
    size: number | null;
    studioName?: string | null;
  },
  rules: SmallerCopyRules,
): ReplaceReason | null {
  const resolution = fileResolution(file.width, file.height);
  if (!resolution || !file.size) {
    return null;
  }
  if (rules.minFileSizeGb && file.size < rules.minFileSizeGb * GB) {
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
  return rules.maxFileSizeGb && file.size > rules.maxFileSizeGb * GB
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
  file: { size: number },
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
    if (rules.maxNewSizeGb && release.size > rules.maxNewSizeGb * GB) {
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
