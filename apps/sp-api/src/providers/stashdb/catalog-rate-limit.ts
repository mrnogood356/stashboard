/**
 * Follows each stash-box server's (StashDB, FansDB) own rules: neither
 * publishes a hard limit, so requests go straight through, no more at once
 * than a browser would open, and none while the server has asked to wait
 * (HTTP 429, Retry-After).
 */

/** Requests in flight to one server at once, as a browser would allow. */
const MAX_IN_FLIGHT = 6;
/** How long to wait after a 429 that doesn't say. */
const DEFAULT_BACKOFF_MS = 30_000;
/** The longest a server's "Retry-After" is honoured for. */
const MAX_BACKOFF_MS = 5 * 60_000;

interface HostState {
  inFlight: number;
  pausedUntil: number;
  waiting: Array<() => void>;
}

const hosts = new Map<string, HostState>();

function stateFor(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = { inFlight: 0, pausedUntil: 0, waiting: [] };
    hosts.set(host, state);
  }
  return state;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Runs one request to the host when its turn comes, and lets the next one
 * go when it's done.
 */
export async function withCatalogSlot<T>(
  host: string,
  request: () => Promise<T>,
): Promise<T> {
  const state = stateFor(host);
  while (state.inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => state.waiting.push(resolve));
  }
  state.inFlight += 1;
  try {
    const wait = state.pausedUntil - Date.now();
    if (wait > 0) {
      await sleep(wait);
    }
    return await request();
  } finally {
    state.inFlight -= 1;
    state.waiting.shift()?.();
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
  const state = stateFor(host);
  state.pausedUntil = Math.max(state.pausedUntil, now + wait);
  return wait;
}

/** For tests: forget every host's state. */
export function resetCatalogRateLimit(): void {
  hosts.clear();
}
