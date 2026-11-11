import { HealthHistoryService, summarize } from './health-history.service';

const HOUR = 60 * 60_000;
const at = (ms: number) => new Date(ms);

describe('health history', () => {
  const start = Date.UTC(2026, 10, 1, 0, 0, 0);

  it('sums each service by hour: checks, failures and answer time', () => {
    const samples = [
      {
        service: 'STASH',
        at: at(start + 5 * 60_000),
        ok: true,
        ms: 100,
        error: null,
      },
      {
        service: 'STASH',
        at: at(start + 10 * 60_000),
        ok: true,
        ms: 300,
        error: null,
      },
      {
        service: 'STASH',
        at: at(start + HOUR + 1),
        ok: false,
        ms: null,
        error: 'ECONNREFUSED',
      },
      { service: 'DATABASE', at: at(start + 1), ok: true, ms: 2, error: null },
    ];
    const [database, stash] = summarize(samples, start, start + 2 * HOUR);

    expect(database.label).toBe('Database');
    expect(stash.hours).toEqual([
      {
        at: new Date(start).toISOString(),
        checks: 2,
        failed: 0,
        averageMs: 200,
      },
      {
        at: new Date(start + HOUR).toISOString(),
        checks: 1,
        failed: 1,
        averageMs: null,
      },
    ]);
    expect(stash.upPercent).toBe(66.7);
    expect(stash.averageMs).toBe(200);
    expect(stash.lastProblem).toEqual({
      at: new Date(start + HOUR + 1).toISOString(),
      error: 'ECONNREFUSED',
    });
  });

  it('records one check of everything and drops checks older than 7 days', async () => {
    const createMany = jest.fn().mockResolvedValue({});
    const deleteMany = jest.fn().mockResolvedValue({});
    const about = {
      sample: jest.fn().mockResolvedValue([
        { service: 'DATABASE', ok: true, ms: 3, error: null },
        { service: 'STASH', ok: false, ms: null, error: 'down' },
      ]),
    };
    const history = new HealthHistoryService(
      { healthSample: { createMany, deleteMany } } as never,
      about as never,
    );
    history.now = () => start + 8 * 24 * HOUR;

    await history.record();

    expect(createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { at: { lt: new Date(start + 24 * HOUR) } },
    });
  });

  it('never throws from the timer', async () => {
    const history = new HealthHistoryService(
      {} as never,
      {
        sample: jest.fn().mockRejectedValue(new Error('boom')),
      } as never,
    );
    await expect(history.record()).resolves.toBeUndefined();
  });

  it('logs memory at start and each time it climbs 50 MB past the last high', () => {
    const history = new HealthHistoryService({} as never);
    const logger = (
      history as unknown as { logger: { log: jest.Mock; warn: jest.Mock } }
    ).logger;
    logger.log = jest.fn();
    logger.warn = jest.fn();
    const mb = 1024 * 1024;
    let rss = 300;
    history.memoryUsage = () => ({
      rss: rss * mb,
      heapUsed: 120 * mb,
      external: 11 * mb,
      arrayBuffers: 8 * mb,
    });

    history.noteMemory();
    expect(logger.log).toHaveBeenCalledWith(
      'Memory: 300 MB in use (120 MB of it JavaScript, 8 MB buffers, 3 MB other outside JavaScript).',
    );
    rss = 340;
    history.noteMemory();
    expect(logger.warn).not.toHaveBeenCalled();
    rss = 360;
    history.noteMemory();
    expect(logger.warn).toHaveBeenCalledWith(
      'Memory: 360 MB in use (120 MB of it JavaScript, 8 MB buffers, 3 MB other outside JavaScript), up from 300 MB.',
    );
  });
});
