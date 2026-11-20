import type { Logger } from '@nestjs/common';

/**
 * Services that can't be reached right now (by address), with when that
 * started. Shared by every client of a service, so an outage is reported
 * once, not once per request or per class.
 */
const unreachableSince = new Map<string, number>();

/**
 * What an outage is about: one service at one server. Every request path of
 * that service shares it; another service behind the same reverse proxy
 * doesn't.
 */
function keyOf(service: string, url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // Not a URL: the text itself.
  }
  return `${service} ${origin}`;
}

/** True the first time a service is found out of reach. */
export function markUnreachable(
  service: string,
  url: string,
  now: number,
): boolean {
  const key = keyOf(service, url);
  if (unreachableSince.has(key)) {
    return false;
  }
  unreachableSince.set(key, now);
  return true;
}

/** How long it was out of reach, in ms; null when it wasn't. */
export function markReachable(
  service: string,
  url: string,
  now: number,
): number | null {
  const key = keyOf(service, url);
  const since = unreachableSince.get(key);
  if (since === undefined) {
    return null;
  }
  unreachableSince.delete(key);
  return now - since;
}

export function formatOutage(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

type OutageLogger = Pick<Logger, 'warn' | 'debug' | 'log'>;

/**
 * A request that couldn't reach a service: a warning the first time while
 * it's out of reach, debug for every retry after that.
 */
export function logUnreachable(
  logger: OutageLogger,
  service: string,
  url: string,
  line: string,
  now = Date.now(),
): void {
  if (markUnreachable(service, url, now)) {
    logger.warn(
      `${line}. Until it answers again, further failures are logged at debug.`,
    );
  } else {
    logger.debug(line);
  }
}

/** A request that reached the service: says so once after an outage. */
export function logReachable(
  logger: OutageLogger,
  service: string,
  url: string,
  name: string,
  now = Date.now(),
): void {
  const downFor = markReachable(service, url, now);
  if (downFor !== null) {
    logger.log(
      `${name} answers again, after ${formatOutage(downFor)} out of reach.`,
    );
  }
}
