import { formatTime } from '../../pages/watch/player.utils';

/**
 * A video's quality as Stash labels it on its cards: the short side decides,
 * so a portrait 1080×1920 video is 1080p, and 4K starts at 1920.
 */
export function qualityLabel(width?: number | null, height?: number | null): string | null {
  if (!width || !height || width <= 0 || height <= 0) {
    return null;
  }
  const short = Math.min(width, height);
  const steps: Array<[number, string]> = [
    [6144, 'HUGE'],
    [3840, '8K'],
    [3584, '7K'],
    [3000, '6K'],
    [2560, '5K'],
    [1920, '4K'],
    [1440, '1440p'],
    [1080, '1080p'],
    [720, '720p'],
    [540, '540p'],
    [480, '480p'],
    [360, '360p'],
    [240, '240p'],
    [144, '144p'],
  ];
  return steps.find(([size]) => short >= size)?.[1] ?? null;
}

/** A length as Stash shows it on cards: 40:51, or 1:02:03 past an hour. */
export function lengthLabel(seconds?: number | null): string | null {
  return seconds && seconds > 0 ? formatTime(seconds) : null;
}
