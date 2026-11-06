import { PrismaService } from './prisma.service';

describe('PrismaService pool check', () => {
  // The check only reads the pool's counts and writes to the log.
  const withPool = (pool: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  }) => {
    const log = { log: jest.fn(), error: jest.fn() };
    const service = Object.assign(Object.create(PrismaService.prototype), {
      pool,
      poolLogger: log,
      poolFullChecks: 0,
    }) as PrismaService;
    return { service, log, pool };
  };

  it('says so once when every connection is taken and requests wait, and when they are free again', () => {
    const { service, log, pool } = withPool({
      totalCount: 20,
      idleCount: 0,
      waitingCount: 3,
    });
    service.checkPool();
    service.checkPool();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toContain(
      'Every database connection is in use (20 of 20) and 3 request(s) are waiting',
    );

    pool.waitingCount = 0;
    pool.idleCount = 5;
    service.checkPool();
    expect(log.log).toHaveBeenCalledWith(
      'Database connections are free again.',
    );
  });

  it('stays quiet while connections are free', () => {
    const { service, log } = withPool({
      totalCount: 20,
      idleCount: 2,
      waitingCount: 0,
    });
    service.checkPool();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
  });
});
