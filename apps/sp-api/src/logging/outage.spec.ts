import { formatOutage, logReachable, logUnreachable } from './outage';

describe('outage logging', () => {
  const logger = () => ({ warn: jest.fn(), debug: jest.fn(), log: jest.fn() });

  it('warns once per outage, then debug, and says when it answers again', () => {
    const log = logger();
    logUnreachable(
      log,
      'svc',
      'http://whisparr:6969/api/v3/movie',
      'Couldn’t reach Whisparr',
      0,
    );
    logUnreachable(
      log,
      'svc',
      'http://whisparr:6969/api/v3/queue',
      'Couldn’t reach Whisparr',
      1_000,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledTimes(1);

    logReachable(
      log,
      'svc',
      'http://whisparr:6969/api/v3/movie',
      'Whisparr',
      300_000,
    );
    expect(log.log).toHaveBeenCalledWith(
      'Whisparr answers again, after 5 min out of reach.',
    );
    // Answering as usual says nothing.
    logReachable(
      log,
      'svc',
      'http://whisparr:6969/api/v3/movie',
      'Whisparr',
      301_000,
    );
    expect(log.log).toHaveBeenCalledTimes(1);
    // A new outage warns again.
    logUnreachable(
      log,
      'svc',
      'http://whisparr:6969/api/v3/movie',
      'Couldn’t reach Whisparr',
      400_000,
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
    logReachable(log, 'svc', 'http://whisparr:6969', 'Whisparr', 400_000);
  });

  it('keeps two services behind the same proxy apart', () => {
    const log = logger();
    logUnreachable(
      log,
      'stash',
      'https://proxy.lan/stash/graphql',
      'Couldn’t reach Stash',
      0,
    );
    // Whisparr answering doesn't mean Stash is back.
    logReachable(
      log,
      'whisparr',
      'https://proxy.lan/whisparr/api',
      'Whisparr',
      1_000,
    );
    expect(log.log).not.toHaveBeenCalled();
    logUnreachable(
      log,
      'whisparr',
      'https://proxy.lan/whisparr/api',
      'Couldn’t reach Whisparr',
      2_000,
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
    logReachable(
      log,
      'stash',
      'https://proxy.lan/stash/graphql',
      'Stash',
      3_000,
    );
    logReachable(
      log,
      'whisparr',
      'https://proxy.lan/whisparr/api',
      'Whisparr',
      3_000,
    );
    expect(log.log).toHaveBeenCalledTimes(2);
  });

  it('keeps each service’s outage apart', () => {
    const log = logger();
    logUnreachable(
      log,
      'svc',
      'http://stash:9999/graphql',
      'Couldn’t reach Stash',
      0,
    );
    logUnreachable(
      log,
      'svc',
      'https://fansdb.cc/graphql',
      'Couldn’t reach the catalog',
      0,
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
    logReachable(log, 'svc', 'http://stash:9999/graphql', 'Stash', 0);
    logReachable(log, 'svc', 'https://fansdb.cc/graphql', 'The catalog', 0);
  });

  it('says how long in seconds, minutes or hours', () => {
    expect(formatOutage(42_000)).toBe('42s');
    expect(formatOutage(14 * 60_000)).toBe('14 min');
    expect(formatOutage(3 * 3_600_000)).toBe('3.0 h');
  });
});
