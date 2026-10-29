import { describe, expect, it } from 'vitest';
import { addMonths, dayKey, monthGrid, monthRange } from './calendar.model';

describe('calendar model', () => {
  it('gives a month as its first and last day', () => {
    expect(monthRange(new Date(2026, 1, 14))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange(new Date(2028, 1, 3))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('lays a month out in Sunday-to-Saturday weeks, padded with the months around it', () => {
    // November 2026 starts on a Sunday and has 30 days: five weeks.
    const weeks = monthGrid(new Date(2026, 10, 1), new Date(2026, 10, 18));
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toMatchObject({ key: '2026-11-01', inMonth: true });
    expect(weeks[4][1]).toMatchObject({ key: '2026-11-30', inMonth: true });
    expect(weeks[4][2]).toMatchObject({ key: '2026-12-01', inMonth: false });
    expect(
      weeks
        .flat()
        .filter((day) => day.isToday)
        .map((day) => day.key),
    ).toEqual(['2026-11-18']);
  });

  it('moves between months from any day of one', () => {
    expect(dayKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-01');
    expect(dayKey(addMonths(new Date(2026, 0, 15), -1))).toBe('2025-12-01');
  });
});
