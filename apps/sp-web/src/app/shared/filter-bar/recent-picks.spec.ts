import { afterEach, describe, expect, it } from 'vitest';
import { readRecentPicks, rememberRecentPicks } from './recent-picks';

describe('recent picks', () => {
  afterEach(() => localStorage.clear());

  it('keeps the newest first, once each, up to twelve', () => {
    rememberRecentPicks('tags', [{ id: 'a', name: 'Outdoor' }]);
    rememberRecentPicks('tags', [{ id: 'b', name: 'POV' }]);
    rememberRecentPicks('tags', [{ id: 'a', name: 'Outdoor' }]);
    expect(readRecentPicks('tags').map((pick) => pick.id)).toEqual(['a', 'b']);

    for (let i = 0; i < 20; i++) {
      rememberRecentPicks('tags', [{ id: `t${i}`, name: `Tag ${i}` }]);
    }
    const picks = readRecentPicks('tags');
    expect(picks).toHaveLength(12);
    expect(picks[0].id).toBe('t19');
  });

  it('reads nothing from a broken or foreign value', () => {
    localStorage.setItem('stashboard.recent.tags', '{not json');
    expect(readRecentPicks('tags')).toEqual([]);
    localStorage.setItem('stashboard.recent.tags', JSON.stringify([{ id: 1 }, 'x']));
    expect(readRecentPicks('tags')).toEqual([]);
  });
});
