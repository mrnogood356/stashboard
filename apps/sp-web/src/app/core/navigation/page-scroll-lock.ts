/**
 * Stops the page scrolling behind a sheet or menu. Hiding the page's
 * overflow is enough on a computer; an iPhone scrolls it anyway, so while
 * locked a swipe only goes through inside the open sheet or menu (marked
 * data-scroll-region, or a PrimeNG popup such as a sheet's dropdown, which
 * PrimeNG appends to body), where something can actually scroll. Two-finger
 * moves always go through, so pinch still zooms. The page itself
 * isn't moved or pinned. Counted: a sheet opened from the menu keeps it
 * locked until both have closed.
 */
const LOCKED = 'app-sheet-open';
let locks = 0;
/** Where a swipe may scroll while locked: the sheet or menu, or its popups. */
const SCROLL_REGIONS = '[data-scroll-region], .p-overlay';

function scrollsWithin(start: EventTarget | null): boolean {
  let node = start instanceof Element ? start : null;
  const region = node?.closest(SCROLL_REGIONS);
  if (!node || !region) {
    return false;
  }
  while (node && region.contains(node)) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    const scrolls =
      node.scrollHeight > node.clientHeight + 1 &&
      (style?.overflowY === 'auto' || style?.overflowY === 'scroll');
    if (scrolls) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

const holdPage = (event: TouchEvent) => {
  if ((event.touches?.length ?? 1) < 2 && !scrollsWithin(event.target)) {
    event.preventDefault();
  }
};

export function lockPageScroll(document: Document): void {
  locks += 1;
  if (locks > 1) {
    return;
  }
  document.documentElement.classList.add(LOCKED);
  document.body.classList.add(LOCKED);
  document.addEventListener('touchmove', holdPage, { passive: false });
}

export function unlockPageScroll(document: Document): void {
  if (locks === 0) {
    return;
  }
  locks -= 1;
  if (locks > 0) {
    return;
  }
  document.documentElement.classList.remove(LOCKED);
  document.body.classList.remove(LOCKED);
  document.removeEventListener('touchmove', holdPage);
}

/** For tests: back to nothing locked. */
export function resetPageScrollLock(document: Document): void {
  locks = 0;
  document.documentElement.classList.remove(LOCKED);
  document.body.classList.remove(LOCKED);
  document.removeEventListener('touchmove', holdPage);
}
