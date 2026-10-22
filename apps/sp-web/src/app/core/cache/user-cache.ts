/**
 * Small per-user cache in localStorage, for showing pages instantly on the
 * phone while fresh data loads. Every key carries the signed-in username, and
 * everything is wiped on sign-out, so one person never sees another's data.
 * Storage can be missing or full (private mode, quota): every call is safe.
 */
const PREFIX = 'stashboard.user.';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function fullKey(username: string, key: string): string {
  return `${PREFIX}${encodeURIComponent(username)}.${key}`;
}

interface Entry<T> {
  savedAt: number;
  value: T;
}

/** The stored value, or null if missing, unreadable or older than maxAgeMs. */
export function readUserCache<T>(
  username: string | null | undefined,
  key: string,
  maxAgeMs: number,
  now = Date.now(),
): T | null {
  if (!username) {
    return null;
  }
  try {
    const raw = storage()?.getItem(fullKey(username, key));
    if (!raw) {
      return null;
    }
    const entry = JSON.parse(raw) as Entry<T>;
    if (typeof entry?.savedAt !== 'number' || now - entry.savedAt > maxAgeMs) {
      return null;
    }
    return entry.value ?? null;
  } catch {
    return null;
  }
}

export function writeUserCache<T>(
  username: string | null | undefined,
  key: string,
  value: T,
  now = Date.now(),
): void {
  if (!username) {
    return;
  }
  try {
    const entry: Entry<T> = { savedAt: now, value };
    storage()?.setItem(fullKey(username, key), JSON.stringify(entry));
  } catch {
    // Full or blocked storage: the page still works, just without the head start.
  }
}

/** Removes every user's cached data (sign-out, expired session). */
export function clearUserCaches(): void {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      store.removeItem(key);
    }
  } catch {
    // Nothing more we can do.
  }
}
