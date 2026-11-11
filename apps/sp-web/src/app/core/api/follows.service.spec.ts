import { sinceDayLabel, sinceOptionFor } from './follows.service';

describe('sinceOptionFor', () => {
  const now = new Date('2026-11-11T15:00:00Z');

  it('matches a start to the choice it was made with, counted from today', () => {
    expect(sinceOptionFor('2026-11-11', now)).toBe(0);
    expect(sinceOptionFor('2026-10-12', now)).toBe(30);
    expect(sinceOptionFor('2026-08-13', now)).toBe(90);
    expect(sinceOptionFor('2025-11-11', now)).toBe(365);
  });

  it('has no choice for a start chosen a while ago', () => {
    // "New scenes only", followed ten days ago.
    expect(sinceOptionFor('2026-11-01', now)).toBeNull();
    expect(sinceDayLabel('2026-11-01')).toContain('2026');
  });
});
