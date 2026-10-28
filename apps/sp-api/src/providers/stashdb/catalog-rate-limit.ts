/**
 * Keeps requests to each stash-box server (StashDB, FansDB) polite: a few at
 * a time, spaced out, and none while the server has asked to wait (HTTP 429).
 * Neither publishes a hard limit; this stays well under what the Stash
 * community treats as considerate.
 */

/** Requests in flight to one server at once. */
const MAX_IN_FLIGHT = 2;
/** At least this long between the starts of two requests to one server. */
const MIN_SPACING_MS = 200;
/** How long to wait after a 429 that doesn't say. */
const DEFAULT_BACKOFF_MS = 30_000;
/** The longest a server's "Retry-After" is honoured for. */
const MAX_BACKOFF_MS = 5 * 60_000;

interface HostState {
  inFlight: number;
  nextStartAt: number;
  pausedUntil: number;
  waiting: Array<() => void>;
}

const hosts = new Map<string, HostState>();

function stateFor(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = { inFlight: 0, nextStartAt: 0, pausedUntil: 0, waiting: [] };
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
    const now = Date.now();
    const startAt = Math.max(now, state.nextStartAt, state.pausedUntil);
    state.nextStartAt = startAt + MIN_SPACING_MS;
    if (startAt > now) {
      await sleep(startAt - now);
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
