import { Logger } from '@nestjs/common';
import { inFlightRequests, type InFlightRequest } from './http-request-logger';

/** How often the watchdog's heartbeat should fire. */
const TICK_MS = 1_000;
/** A heartbeat this late means the server couldn't do anything else meanwhile. */
export const BLOCKED_AFTER_MS = 5_000;
/** An API request open this long is waiting on something that isn't answering. */
export const STUCK_AFTER_MS = 120_000;
/** Open for as long as the video or preview clip plays: never "stuck". */
const LONG_LIVED = [
  /^\/api\/playback\/stream\//,
  /^\/api\/playback\/scenes\/[^/]+\/preview$/,
  /^\/api\/playback\/scenes\/[^/]+\/markers\/[^/]+\/preview$/,
];
/** Requests named in one warning. */
const LISTED = 5;

type WatchdogLogger = Pick<Logger, 'warn'>;

/**
 * Says in the logs when Stashboard stops answering, which otherwise leaves
 * no trace:
 * - blocked: busy with one piece of work for seconds, so nothing else (the
 *   web app, the healthcheck) gets an answer; logged once it's over, with
 *   the requests that were open then;
 * - stuck: an API request waiting minutes on something that doesn't answer
 *   (Stash, Whisparr, the database), logged once per request.
 */
export class StallWatchdog {
  private lastTick: number;
  private readonly reported = new Set<InFlightRequest>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logger: WatchdogLogger = new Logger('Watchdog'),
    private readonly now: () => number = () => performance.now(),
    private readonly requests: Map<number, InFlightRequest> = inFlightRequests,
  ) {
    this.lastTick = now();
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never keeps the process alive on its own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One heartbeat; public for tests. */
  tick(): void {
    const at = this.now();
    const late = at - this.lastTick - TICK_MS;
    this.lastTick = at;
    if (late >= BLOCKED_AFTER_MS) {
      const open = this.open().slice(0, LISTED);
      this.logger.warn(
        `The server was blocked for ${seconds(late)}: nothing else could be answered meanwhile.` +
          (open.length
            ? ` Being answered then: ${open.map((entry) => describe(entry, at)).join('; ')}.`
            : ' No web request was open, so it was background work.'),
      );
    }

    for (const entry of this.open()) {
      if (at - entry.startedAt >= STUCK_AFTER_MS && !this.reported.has(entry)) {
        this.reported.add(entry);
        this.logger.warn(
          `${entry.method} ${entry.url} has waited ${seconds(at - entry.startedAt)} without an answer; it's waiting on something that doesn't respond (Stash, Whisparr, the database…).`,
        );
      }
    }
    // Forget requests that have finished.
    const current = new Set(this.requests.values());
    for (const entry of this.reported) {
      if (!current.has(entry)) {
        this.reported.delete(entry);
      }
    }
  }

  /** Open requests, oldest first, without video streams. */
  private open(): InFlightRequest[] {
    return [...this.requests.values()]
      .filter(
        (entry) => !LONG_LIVED.some((pattern) => pattern.test(entry.path)),
      )
      .sort((left, right) => left.startedAt - right.startedAt);
  }
}

function describe(entry: InFlightRequest, at: number): string {
  return `${entry.method} ${entry.url} (open ${seconds(at - entry.startedAt)})`;
}

function seconds(ms: number): string {
  return ms >= 60_000
    ? `${Math.round(ms / 6_000) / 10} min`
    : `${Math.round(ms / 100) / 10} s`;
}
