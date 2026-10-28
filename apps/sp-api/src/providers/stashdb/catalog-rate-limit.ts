/**
 * Follows each stash-box server's (StashDB, FansDB) own rules: neither
 * publishes a limit, and Stashboard's lookups are few and mostly one at a
 * time, so requests go straight through, except while a server has asked
 * to wait (HTTP 429, Retry-After).
 */

/** How long to wait after a 429 that doesn't say. */
const DEFAULT_BACKOFF_MS = 30_000;
/** The longest a server's "Retry-After" is honoured for. */
const MAX_BACKOFF_MS = 5 * 60_000;

/** When each server said it would take requests again. */
const pausedUntil = new Map<string, number>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/** Runs one request to the host, once any pause it asked for is over. */
export async function withCatalogSlot<T>(
  host: string,
  request: () => Promise<T>,
): Promise<T> {
  // Re-read after each wait: another answer may have made the pause longer.
  for (;;) {
    const wait = (pausedUntil.get(host) ?? 0) - Date.now();
    if (wait <= 0) {
      return request();
    }
    await sleep(wait);
  }
}

/**
 * The server said "too many requests": nothing more goes to it until the
 * time it gave (Retry-After, in seconds or as a date) or half a minute.
 * Returns how long that is.
 */
export function pauseCatalog(
  host: string,
  retryAfter: string | null,
  now = Date.now(),
): number {
  let wait = DEFAULT_BACKOFF_MS;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      wait = seconds * 1000;
    } else if (Number.isFinite(at)) {
      wait = Math.max(0, at - now);
    }
  }
  wait = Math.min(wait, MAX_BACKOFF_MS);
  pausedUntil.set(host, Math.max(pausedUntil.get(host) ?? 0, now + wait));
  return wait;
}

/** For tests: forget every host's state. */
export function resetCatalogRateLimit(): void {
  pausedUntil.clear();
}
