import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockPageScroll, resetPageScrollLock, unlockPageScroll } from './page-scroll-lock';

describe('page scroll lock', () => {
  afterEach(() => resetPageScrollLock(document));

  it('pins the page where it was, and puts it back once everything has closed', () => {
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 600 });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    lockPageScroll(document); // the More menu
    lockPageScroll(document); // a sheet opened from it
    expect(document.body.classList.contains('app-sheet-open')).toBe(true);
    expect(document.body.style.top).toBe('-600px');

    unlockPageScroll(document);
    expect(document.body.classList.contains('app-sheet-open')).toBe(true);
    unlockPageScroll(document);
    expect(document.body.classList.contains('app-sheet-open')).toBe(false);
    expect(document.body.style.top).toBe('');
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 600 }));
  });
});
