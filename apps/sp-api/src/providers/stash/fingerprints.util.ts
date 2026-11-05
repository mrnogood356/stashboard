import type { StashLocalSceneRecord } from './stash.types';

/**
 * A scene's file fingerprints as "OSHASH|…", "MD5|…" and "PHASH|…", the
 * same form as fingerprintKey, to find a catalog scene you have.
 */
export function fileFingerprints(
  files: StashLocalSceneRecord['files'],
): string[] {
  const keys = new Set<string>();
  for (const file of Array.isArray(files) ? files : []) {
    for (const print of Array.isArray(file?.fingerprints)
      ? file.fingerprints
      : []) {
      const key =
        typeof print?.type === 'string' && typeof print.value === 'string'
          ? fingerprintKey(print.type, print.value)
          : null;
      if (key) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/** "OSHASH|abc…" for an oshash, md5 or phash; null for any other kind. */
export function fingerprintKey(algorithm: string, hash: string): string | null {
  const kind = algorithm.trim().toUpperCase();
  const value = hash.trim().toLowerCase();
  return value && (kind === 'OSHASH' || kind === 'MD5' || kind === 'PHASH')
    ? `${kind}|${value}`
    : null;
}
