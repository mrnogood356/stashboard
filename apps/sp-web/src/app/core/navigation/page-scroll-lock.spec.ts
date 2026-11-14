import { afterEach, describe, expect, it } from 'vitest';
import { lockPageScroll, resetPageScrollLock, unlockPageScroll } from './page-scroll-lock';

function swipe(target: Element): TouchEvent {
  const event = new Event('touchmove', { bubbles: true, cancelable: true }) as TouchEvent;
  target.dispatchEvent(event);
  return event;
}

describe('page scroll lock', () => {
  afterEach(() => {
    resetPageScrollLock(document);
    document.body.innerHTML = '';
  });

  it('holds swipes outside the open sheet, never moves the page, and lets go once all have closed', () => {
    const page = document.createElement('p');
    const sheet = document.createElement('div');
    sheet.setAttribute('data-scroll-region', '');
    const list = document.createElement('ul');
    list.style.overflowY = 'auto';
    Object.defineProperty(list, 'scrollHeight', { value: 900 });
    Object.defineProperty(list, 'clientHeight', { value: 300 });
    const row = document.createElement('li');
    list.append(row);
    sheet.append(list);
    document.body.append(page, sheet);

    lockPageScroll(document); // the More menu
    lockPageScroll(document); // a sheet opened from it
    expect(document.body.classList.contains('app-sheet-open')).toBe(true);
    expect(document.body.style.position).toBe('');
    expect(swipe(page).defaultPrevented).toBe(true);
    expect(swipe(row).defaultPrevented).toBe(false);

    unlockPageScroll(document);
    expect(swipe(page).defaultPrevented).toBe(true);
    unlockPageScroll(document);
    expect(document.body.classList.contains('app-sheet-open')).toBe(false);
    expect(swipe(page).defaultPrevented).toBe(false);
  });
});
