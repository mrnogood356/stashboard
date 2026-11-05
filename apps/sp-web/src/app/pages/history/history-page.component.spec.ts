import { describe, expect, it } from 'vitest';
import type { LocalSceneCard } from '../../core/api/local-library.service';
import { groupByDay } from './history-page.component';

const played = (id: string, at: Date | null) =>
  ({ id, lastPlayedAt: at?.toISOString() ?? null }) as LocalSceneCard;

describe('groupByDay', () => {
  it('groups by Today, Yesterday, the weekday, then the date', () => {
    const now = new Date(2026, 10, 5, 20, 0);
    const days = groupByDay(
      [
        played('a', new Date(2026, 10, 5, 9, 0)),
        played('b', new Date(2026, 10, 5, 1, 0)),
        played('c', new Date(2026, 10, 4, 23, 0)),
        played('d', new Date(2026, 10, 2, 12, 0)),
        played('e', new Date(2026, 9, 1, 12, 0)),
        played('f', null),
      ],
      now,
    );
    expect(days.map((day) => [day.label, day.items.map((item) => item.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      [new Date(2026, 10, 2).toLocaleDateString([], { weekday: 'long' }), ['d']],
      [new Date(2026, 9, 1).toLocaleDateString([], { month: 'long', day: 'numeric' }), ['e']],
      ['Earlier', ['f']],
    ]);
  });
});
