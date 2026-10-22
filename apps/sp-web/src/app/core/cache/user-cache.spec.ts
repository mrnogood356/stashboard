import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearUserCaches, readUserCache, writeUserCache } from './user-cache';

describe('user cache', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps values per user and drops old ones', () => {
    writeUserCache('admin', 'home.rails', [1, 2], 1_000);

    expect(readUserCache('admin', 'home.rails', 500, 1_200)).toEqual([1, 2]);
    expect(readUserCache('other', 'home.rails', 500, 1_200)).toBeNull();
    expect(readUserCache('admin', 'home.rails', 500, 2_000)).toBeNull();
    expect(readUserCache(null, 'home.rails', 500, 1_200)).toBeNull();
  });

  it('does nothing without a user', () => {
    writeUserCache(null, 'home.rails', [1]);

    expect(localStorage.length).toBe(0);
  });

  it('clears every user but leaves other settings alone', () => {
    localStorage.setItem('sp-images', 'obscured');
    writeUserCache('admin', 'a', 1);
    writeUserCache('other', 'b', 2);

    clearUserCaches();

    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem('sp-images')).toBe('obscured');
  });

  it('survives broken or full storage', () => {
    localStorage.setItem('stashboard.user.admin.bad', '{not json');
    expect(readUserCache('admin', 'bad', 1_000)).toBeNull();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => writeUserCache('admin', 'big', 'x')).not.toThrow();
  });
});
