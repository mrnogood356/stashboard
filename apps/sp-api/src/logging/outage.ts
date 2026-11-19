import type { Logger } from '@nestjs/common';

/**
 * Services that can't be reached right now (by address), with when that
 * started. Shared by every client of a service, so an outage is reported
 * once, not once per request or per class.
 */
const unreachableSince = new Map<string, number>();

/** The part of a URL an outage is about: the server, not the path. */
function keyOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** True the first time a service is found out of reach. */
export function markUnreachable(url: string, now: number): boolean {
  const key = keyOf(url);
  if (unreachableSince.has(key)) {
    return false;
  }
  unreachableSince.set(key, now);
  return true;
}

/** How long it was out of reach, in ms; null when it wasn't. */
export function markReachable(url: string, now: number): number | null {
  const key = keyOf(url);
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
  url: string,
  line: string,
  now = Date.now(),
): void {
  if (markUnreachable(url, now)) {
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
  url: string,
  name: string,
  now = Date.now(),
): void {
  const downFor = markReachable(url, now);
  if (downFor !== null) {
    logger.log(
      `${name} answers again, after ${formatOutage(downFor)} out of reach.`,
    );
  }
}
