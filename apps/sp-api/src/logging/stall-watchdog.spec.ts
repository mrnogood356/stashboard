import type { InFlightRequest } from './http-request-logger';
import {
  BLOCKED_AFTER_MS,
  STUCK_AFTER_MS,
  StallWatchdog,
} from './stall-watchdog';

function setup() {
  let clock = 10_000;
  const logger = { warn: jest.fn() };
  const requests = new Map<number, InFlightRequest>();
  const watchdog = new StallWatchdog(logger, () => clock, requests);
  const open = (id: number, method: string, url: string, startedAt = clock) =>
    requests.set(id, { method, url, path: url.split('?')[0], startedAt });
  return {
    logger,
    requests,
    watchdog,
    open,
    advance: (ms: number) => {
      clock += ms;
      watchdog.tick();
    },
  };
}

describe('StallWatchdog', () => {
  it('stays quiet while the heartbeat is on time', () => {
    const { logger, advance } = setup();
    for (let i = 0; i < 10; i++) {
      advance(1_000);
    }
    advance(1_000 + BLOCKED_AFTER_MS - 1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says when the server was blocked, and what was being answered', () => {
    const { logger, open, advance } = setup();
    open(1, 'POST', '/api/downloads/processing/clear-history');
    open(2, 'GET', '/api/playback/stream/t/scene/1/stream');
    advance(1_000 + 12_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain('blocked for 12 s');
    expect(line).toContain(
      'POST /api/downloads/processing/clear-history (open 13 s)',
    );
    // A video stream is open the whole time it plays: not a suspect.
    expect(line).not.toContain('/api/playback/stream');
  });

  it('says it was background work when no request was open', () => {
    const { logger, advance } = setup();
    advance(1_000 + 6_000);
    expect(logger.warn.mock.calls[0][0]).toContain('background work');
  });

  it('names a request that waits minutes for an answer, once', () => {
    const { logger, open, requests, advance } = setup();
    open(1, 'GET', '/api/scenes?page=1');
    for (let at = 0; at < STUCK_AFTER_MS + 5_000; at += 1_000) {
      advance(1_000);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(
      /^GET \/api\/scenes\?page=1 has waited 2 min/,
    );
    requests.delete(1);
    advance(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
