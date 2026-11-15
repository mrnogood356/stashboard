import { afterEach, describe, expect, it } from 'vitest';
import { lockPageScroll, resetPageScrollLock, unlockPageScroll } from './page-scroll-lock';

function swipe(target: Element, fingers = 1): TouchEvent {
  const event = new Event('touchmove', { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', { value: { length: fingers } });
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

  it('lets a sheet’s dropdown list, appended to body, scroll', () => {
    const page = document.createElement('p');
    const popup = document.createElement('div');
    popup.className = 'p-overlay';
    const list = document.createElement('ul');
    list.style.overflowY = 'auto';
    Object.defineProperty(list, 'scrollHeight', { value: 900 });
    Object.defineProperty(list, 'clientHeight', { value: 256 });
    const option = document.createElement('li');
    list.append(option);
    popup.append(list);
    document.body.append(page, popup);

    lockPageScroll(document);
    expect(swipe(option).defaultPrevented).toBe(false);
    expect(swipe(page).defaultPrevented).toBe(true);
  });

  it('lets two-finger moves through, so pinch still zooms', () => {
    const page = document.createElement('p');
    document.body.append(page);

    lockPageScroll(document);
    expect(swipe(page, 2).defaultPrevented).toBe(false);
    expect(swipe(page).defaultPrevented).toBe(true);
  });
});
