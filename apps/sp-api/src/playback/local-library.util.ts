import type { StashProblemScene } from '../providers/stash/stash.types';
import {
  type StashDuplicateScene,
  type StashLibraryTask,
  type StashLocalSceneCard,
} from '../providers/stash/stash.adapter';
import type { LocalSceneSort } from './dto/local-library.dto';
import { stashMediaUrl } from '../media/media-url.util';
import { LocalSceneCardDto } from './local-library.types';

export function toStashSort(
  sort: LocalSceneSort,
  seed: number,
): { stashSort: string; direction: 'ASC' | 'DESC' } {
  switch (sort) {
    case 'PRODUCED':
      return { stashSort: 'production_date', direction: 'DESC' };
    case 'ADDED':
      return { stashSort: 'created_at', direction: 'DESC' };
    case 'PLAYS':
      return { stashSort: 'play_count', direction: 'DESC' };
    case 'TITLE':
      return { stashSort: 'title', direction: 'ASC' };
    case 'RANDOM':
      return { stashSort: `random_${seed || 1}`, direction: 'ASC' };
    case 'DATE':
    default:
      return { stashSort: 'date', direction: 'DESC' };
  }
}

export function seedFrom(value: string): number {
  let hash = 7;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2_147_483_647;
  }
  return hash || 1;
}

/**
 * Related scenes, most in common first: sharing performers counts most, then
 * the studio, then the tags, adding up when a scene shares more than one.
 * Unplayed ones come before played ones with the same score.
 */
export function rankRelated(
  selfId: string,
  groups: Array<{ items: StashLocalSceneCard[]; weight: number }>,
): StashLocalSceneCard[] {
  const scored = new Map<
    string,
    { item: StashLocalSceneCard; score: number; order: number }
  >();
  let order = 0;
  for (const { items, weight } of groups) {
    for (const item of items) {
      if (item.id === selfId) {
        continue;
      }
      const seen = scored.get(item.id);
      if (seen) {
        seen.score += weight;
      } else {
        scored.set(item.id, { item, score: weight, order: order++ });
      }
    }
  }
  return [...scored.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(left.item.playCount > 0) - Number(right.item.playCount > 0) ||
        left.order - right.order,
    )
    .map((entry) => entry.item);
}

/** The same key for the same set of scenes, in any order. */
export function duplicateKey(sceneIds: string[]): string {
  return [...new Set(sceneIds)]
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
    .join(',');
}

export function toCard(scene: StashLocalSceneCard): LocalSceneCardDto {
  const screenshotPath = `scenes/${encodeURIComponent(scene.id)}/screenshot`;
  const screenshot = scene.screenshotVersion
    ? stashMediaUrl(screenshotPath, scene.screenshotVersion)
    : null;
  const progress =
    scene.duration && scene.resumeTime > 0
      ? Math.min(1, scene.resumeTime / scene.duration)
      : null;
  return {
    id: scene.id,
    title: scene.title,
    imageUrl: screenshot,
    cardImageUrl: screenshot
      ? stashMediaUrl(screenshotPath, scene.screenshotVersion, 480)
      : null,
    studioId: scene.studio?.id ?? null,
    studio: scene.studio?.name ?? null,
    studioImageUrl: scene.studio?.imageVersion
      ? stashMediaUrl(
          `studios/${encodeURIComponent(scene.studio.id)}/logo`,
          scene.studio.imageVersion,
        )
      : null,
    releaseDate: scene.date,
    duration: scene.duration,
    width: scene.width ?? null,
    height: scene.height ?? null,
    playCount: scene.playCount,
    progress,
    lastPlayedAt: scene.lastPlayedAt ?? null,
    type: 'SCENE',
    source: 'STASH',
  };
}

/**
 * How much picture a codec gets from each bit: HEVC needs about 60% of
 * H.264's bit rate for the same picture, AV1 about half.
 */
export const CODEC_EFFICIENCY: Record<string, number> = {
  av1: 2,
  hevc: 1.6,
  h265: 1.6,
  vp9: 1.5,
  h264: 1,
  avc: 1,
};

export function pixels(scene: StashDuplicateScene): number {
  return (scene.file?.width ?? 0) * (scene.file?.height ?? 0);
}

/** Bit rate as if it were H.264, so an HEVC copy isn't beaten by a bigger H.264 one. */
export function effectiveBitRate(scene: StashDuplicateScene): number {
  const codec = (scene.file?.videoCodec ?? '').toLowerCase();
  const factor = CODEC_EFFICIENCY[codec] ?? 0.8;
  return (scene.file?.bitRate ?? 0) * factor;
}

/**
 * The copy to keep: highest resolution, then the most picture for its codec
 * (bit rate weighed by how efficient the codec is), then the longest, then
 * the most played. With why, in plain words.
 */
export function pickKeeperWithReason(group: StashDuplicateScene[]): {
  id: string;
  reason: string;
} {
  const { best, maxRate } = rankCopies(group);
  const rest = group.filter((scene) => scene !== best);
  const next = rest.length > 0 ? rankCopies(rest).best : null;
  return {
    id: best.id,
    reason: next ? keepReason(best, next, maxRate) : 'The only copy.',
  };
}

/**
 * The best copy, by stages measured against the whole group, never pair by
 * pair, so the answer is the same in any order: the highest resolution;
 * among those, any within 5% of the most picture for its codec; then the
 * longest, the most played, and the lowest id.
 */
export function rankCopies(group: StashDuplicateScene[]): {
  best: StashDuplicateScene;
  maxRate: number;
} {
  const topPixels = Math.max(...group.map(pixels));
  const sharpest = group.filter((scene) => pixels(scene) === topPixels);
  const maxRate = Math.max(...sharpest.map(effectiveBitRate));
  const finest = sharpest.filter(
    (scene) => effectiveBitRate(scene) >= maxRate * 0.95,
  );
  const best = [...finest].sort(
    (left, right) =>
      (right.file?.duration ?? 0) - (left.file?.duration ?? 0) ||
      right.playCount - left.playCount ||
      left.id.localeCompare(right.id, undefined, { numeric: true }),
  )[0];
  return { best, maxRate };
}

/** Highest resolution wins, then picture for the codec, then length, then most played. */
export function pickKeeper(group: StashDuplicateScene[]): string {
  return pickKeeperWithReason(group).id;
}

export function keepReason(
  best: StashDuplicateScene,
  next: StashDuplicateScene,
  maxRate: number,
): string {
  if (pixels(best) > pixels(next)) {
    return 'Highest resolution.';
  }
  // The same 5% line rankCopies drew: the runner-up fell outside it.
  if (effectiveBitRate(next) < maxRate * 0.95) {
    const bestCodec = (best.file?.videoCodec ?? '').toLowerCase();
    const nextCodec = (next.file?.videoCodec ?? '').toLowerCase();
    return (CODEC_EFFICIENCY[bestCodec] ?? 0) >
      (CODEC_EFFICIENCY[nextCodec] ?? 0)
      ? `Same resolution, and ${bestCodec.toUpperCase()} keeps more picture than ${nextCodec.toUpperCase() || 'the other'}.`
      : 'Same resolution, more picture (higher bit rate).';
  }
  if ((best.file?.duration ?? 0) > (next.file?.duration ?? 0)) {
    return 'Same quality, and the longest.';
  }
  if (best.playCount > next.playCount) {
    return 'Same quality, and the one you’ve played.';
  }
  return 'All copies look the same; this one is first.';
}

/** Each library task as the activity log names it. */
export const JOB_NAMES: Record<StashLibraryTask, string> = {
  scan: 'library scan',
  generate: 'Generate (previews, sprites, covers)',
  identify: 'Identify on the whole library',
  'auto-tag': 'Auto Tag',
  clean: 'Clean (removes scenes whose files are gone)',
};

/** What a background check found. */
export interface BackgroundFound {
  missing: number;
  checked: number;
  unanswered: number;
  unansweredWhy?: string;
  /** One address that wasn't answered, for the log. */
  unansweredExample?: string;
  /** Why it couldn't check at all; the count is then unknown. */
  note?: string;
  scenes: StashProblemScene[];
}

/** A size in plain words: 1.4 GB, 320 MB, 12 KB. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Categories and studios to narrow a performer's or studio's scenes to. */
export interface CollectionNarrowing {
  tagIds?: string[];
  studioIds?: string[];
}

/** Stash scene filter parts: every picked category, any picked studio. */
export function narrowingFilter(
  narrow: CollectionNarrowing,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (narrow.tagIds?.length) {
    filter.tags = { value: narrow.tagIds, modifier: 'INCLUDES_ALL', depth: 0 };
  }
  if (narrow.studioIds?.length) {
    filter.studios = {
      value: narrow.studioIds,
      modifier: 'INCLUDES',
      depth: -1,
    };
  }
  return filter;
}
