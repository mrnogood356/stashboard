/**
 * Stops the page scrolling behind a sheet or menu. Hiding the overflow is
 * enough on a computer, but an iPhone scrolls the page anyway, so the page
 * is pinned where it was and put back on unlock. Counted: two things open at
 * once (a menu and a sheet from it) unlock when both have closed.
 */
const LOCKED = 'app-sheet-open';
let locks = 0;
let savedScroll = 0;

export function lockPageScroll(document: Document): void {
  locks += 1;
  if (locks > 1) {
    return;
  }
  const view = document.defaultView;
  const body = document.body;
  savedScroll = view?.scrollY ?? 0;
  body.classList.add(LOCKED);
  body.style.top = `-${savedScroll}px`;
}

export function unlockPageScroll(document: Document): void {
  if (locks === 0) {
    return;
  }
  locks -= 1;
  if (locks > 0) {
    return;
  }
  const body = document.body;
  body.classList.remove(LOCKED);
  body.style.top = '';
  document.defaultView?.scrollTo?.({ top: savedScroll, behavior: 'instant' as ScrollBehavior });
}

/** For tests: back to nothing locked. */
export function resetPageScrollLock(document: Document): void {
  locks = 0;
  document.body.classList.remove(LOCKED);
  document.body.style.top = '';
}
