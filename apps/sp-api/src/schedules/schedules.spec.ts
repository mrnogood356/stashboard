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
    expect(isDue(daily, at(2026, 11, 8, 3, 59), null)).toBe(false);
    expect(isDue({ ...daily, days: [1, 2] }, fourAm, null)).toBe(false);
    expect(isDue({ ...daily, days: [0] }, fourAm, null)).toBe(true);
    // Already run since 4:00.
    expect(isDue(daily, fourAm, new Date(fourAm.getTime() - 3_000))).toBe(
      false,
    );
    // Yesterday's run doesn't count for today.
    expect(isDue(daily, fourAm, at(2026, 11, 7, 4, 0))).toBe(true);
  });

  it('catches up on a time it missed, for an hour', () => {
    // The check slipped past 4:00, or another job was still running.
    expect(isDue(daily, at(2026, 11, 8, 4, 1), null)).toBe(true);
    expect(isDue(daily, at(2026, 11, 8, 4, 59), null)).toBe(true);
    expect(isDue(daily, at(2026, 11, 8, 5, 0), null)).toBe(false);
    // Just after midnight, a 23:30 job from yesterday.
    const late = { ...daily, hour: 23, minute: 30 };
    expect(isDue(late, at(2026, 11, 9, 0, 10), null)).toBe(true);
    // Its time set to a minute ago: waits for tomorrow's.
    expect(
      isDue(daily, at(2026, 11, 8, 4, 2), null, at(2026, 11, 8, 4, 1)),
    ).toBe(false);
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
    const organizer = {
      getSettings: jest
        .fn()
        .mockResolvedValue({ autoMatchNightly: false, sendToWhisparr: true }),
      nightly: jest.fn().mockResolvedValue('Off: Every night is switched off'),
      sendMissingDaily: jest.fn().mockResolvedValue('Nothing to send'),
    };
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
    // What it actually did is what's shown, not just "Started".
    expect(four.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { job: 'organizer-match' },
        update: expect.objectContaining({
          lastStatus: 'Off: Every night is switched off',
        }),
      }),
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
    expect(on.library.startJob).toHaveBeenCalledWith('scan', { now: false });
  });

  it('still runs a job whose minute went by while another ran', async () => {
    const { service, organizer } = setup([
      {
        job: 'send-missing',
        enabled: true,
        hour: 4,
        minute: 5,
        days: [],
        lastRunAt: null,
        lastStatus: null,
      },
    ]);
    // The check after 4:05 came at 4:12: the 4:00 match ran long.
    service.now = () => at(2026, 11, 8, 4, 12);
    await service.tick();
    expect(organizer.sendMissingDaily).toHaveBeenCalled();
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
    // Stash's jobs report back once they start (or don't), after the tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastStatus: 'Failed: Stash is down',
        }),
      }),
    );
  });

  it('doesn’t hold up the schedule while Stash’s job waits its turn', async () => {
    const { service, upsert, library } = setup([
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
    // Stash never has room.
    library.startJob.mockReturnValue(new Promise(() => undefined));
    service.now = () => at(2026, 11, 8, 3, 0);
    await service.tick();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { job: 'stash-scan' },
        update: expect.objectContaining({
          lastStatus: 'Waiting its turn in Stash',
        }),
      }),
    );
    // The next check isn't blocked by the one still waiting.
    await service.tick();
    expect(library.startJob).toHaveBeenCalledTimes(2);
  });

  it('notes Stash’s job as waiting before it starts, so a quick start is what stays', async () => {
    const { service, upsert } = setup([
      {
        job: 'stash-generate',
        enabled: true,
        hour: 3,
        minute: 0,
        days: [],
        lastRunAt: null,
        lastStatus: null,
      },
    ]);
    // The "waiting" write is slow to land; whichever lands last is what's kept.
    let saved: string | null = null;
    upsert.mockImplementation(
      async (args: { update: { lastStatus: string } }) => {
        const status = args.update.lastStatus;
        await new Promise((resolve) =>
          setTimeout(resolve, status.startsWith('Waiting') ? 20 : 0),
        );
        saved = status;
        return {};
      },
    );
    service.now = () => at(2026, 11, 8, 3, 0);
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(saved).toBe('Started');
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

  it('shows no next run for an organizer job switched off in its settings', async () => {
    const { service } = setup();
    service.now = () => at(2026, 11, 8, 1, 0);
    const { schedules } = await service.list();
    const match = schedules.find((s) => s.job === 'organizer-match')!;
    const send = schedules.find((s) => s.job === 'send-missing')!;
    expect(match.enabled).toBe(false);
    expect(match.nextRunAt).toBeNull();
    expect(send.enabled).toBe(true);
    expect(send.nextRunAt).not.toBeNull();
  });
});
