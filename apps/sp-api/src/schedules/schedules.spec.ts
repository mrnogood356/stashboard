import { SchedulesService } from './schedules.service';
import { isDue, nextRun } from './schedules.util';

// Local times: the schedules run on the server's clock.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi, 5);

describe('schedules', () => {
  const daily = { enabled: true, hour: 4, minute: 0, days: [] as number[] };

  it('is due at its minute, on its days, once', () => {
    const fourAm = at(2026, 11, 8, 4, 0); // a Sunday
    expect(isDue(daily, fourAm, null)).toBe(true);
    expect(isDue(daily, at(2026, 11, 8, 4, 1), null)).toBe(false);
    expect(isDue({ ...daily, days: [1, 2] }, fourAm, null)).toBe(false);
    expect(isDue({ ...daily, days: [0] }, fourAm, null)).toBe(true);
    // Already run this minute.
    expect(isDue(daily, fourAm, new Date(fourAm.getTime() - 3_000))).toBe(
      false,
    );
  });

  it('finds the next run, today or on a later listed day', () => {
    expect(nextRun(daily, at(2026, 11, 8, 3, 0))).toEqual(
      new Date(2026, 10, 8, 4, 0, 0, 0),
    );
    expect(nextRun(daily, at(2026, 11, 8, 5, 0))).toEqual(
      new Date(2026, 10, 9, 4, 0, 0, 0),
    );
    // Sunday only, asked on a Monday: next Sunday.
    expect(nextRun({ ...daily, days: [0] }, at(2026, 11, 9, 5, 0))).toEqual(
      new Date(2026, 10, 15, 4, 0, 0, 0),
    );
  });

  function setup(rows: Array<Record<string, unknown>> = []) {
    const upsert = jest.fn().mockResolvedValue({});
    const prisma = {
      jobSchedule: { findMany: jest.fn().mockResolvedValue(rows), upsert },
    };
    const organizer = { nightly: jest.fn(), sendMissingDaily: jest.fn() };
    const library = { startJob: jest.fn().mockResolvedValue({ jobId: '1' }) };
    const service = new SchedulesService(
      prisma as never,
      organizer as never,
      library as never,
    );
    return { service, upsert, organizer, library };
  }

  it('runs the organizer’s jobs at their usual times, and Stash jobs only when switched on', async () => {
    const four = setup();
    four.service.now = () => at(2026, 11, 8, 4, 0);
    await four.service.tick();
    expect(four.organizer.nightly).toHaveBeenCalled();
    expect(four.library.startJob).not.toHaveBeenCalled();
    expect(four.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { job: 'organizer-match' } }),
    );

    // Stash's scan is off by default; switched on at 3:00 it runs.
    const off = setup();
    off.service.now = () => at(2026, 11, 8, 3, 0);
    await off.service.tick();
    expect(off.library.startJob).not.toHaveBeenCalled();

    const on = setup([
      {
        job: 'stash-scan',
        enabled: true,
        hour: 3,
        minute: 0,
        days: [],
        lastRunAt: null,
        lastStatus: null,
      },
    ]);
    on.service.now = () => at(2026, 11, 8, 3, 0);
    await on.service.tick();
    expect(on.library.startJob).toHaveBeenCalledWith('scan');
  });

  it('records a failure and carries on', async () => {
    const { service, upsert, library } = setup([
      {
        job: 'stash-clean',
        enabled: true,
        hour: 2,
        minute: 30,
        days: [],
        lastRunAt: null,
        lastStatus: null,
      },
    ]);
    library.startJob.mockRejectedValue(new Error('Stash is down'));
    service.now = () => at(2026, 11, 8, 2, 30);
    await service.tick();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: 'Failed: Stash is down',
        }),
      }),
    );
  });

  it('saves a schedule, treating every day ticked as every day', async () => {
    const { service, upsert } = setup();
    await service.update('stash-generate', {
      enabled: true,
      hour: 1,
      minute: 15,
      days: [0, 1, 2, 3, 4, 5, 6, 6],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { enabled: true, hour: 1, minute: 15, days: [] },
      }),
    );
    await expect(service.update('rm-rf', daily)).rejects.toThrow('no such job');
  });
});
