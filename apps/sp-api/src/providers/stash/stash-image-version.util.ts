import { createHash } from 'node:crypto';

/**
 * A version for one of Stash's images, or null when there is none. Stash adds
 * ?t=<last update> to its image paths, so the value changes whenever the
 * picture can have; a path without it is versioned by its own text.
 * With realOnly, Stash's generated placeholders (default=true) count as none.
 */
export function stashImageVersion(
  path: unknown,
  options: { realOnly?: boolean } = {},
): string | null {
  if (typeof path !== 'string' || !path.trim()) {
    return null;
  }
  if (options.realOnly && /[?&]default=true\b/.test(path)) {
    return null;
  }
  const stamp = /[?&]t=(\d+)/.exec(path)?.[1];
  return stamp ?? createHash('sha1').update(path).digest('hex').slice(0, 12);
}
