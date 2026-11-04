/**
 * On phones and tablets, as in Stash: the scene card nearest the middle of
 * the screen plays its preview clip while it's in view, with no need to
 * hold it. One at a time, so a page of cards doesn't play a dozen videos.
 */
export interface InViewPreviewCard {
  readonly element: Element;
  /** Has a clip that hasn't failed. */
  canPlay(): boolean;
  setActive(active: boolean): void;
}

/** How much of a card has to be on screen before it can play. */
const VISIBLE_RATIO = 0.6;

class InViewPreviews {
  private observer: IntersectionObserver | null = null;
  private readonly cards = new Map<Element, InViewPreviewCard>();
  private readonly visible = new Set<Element>();
  private active: InViewPreviewCard | null = null;
  private picking = false;
  private listening = false;
  private readonly onScroll = () => this.schedulePick();

  /** Whether cards should play on their own here: a touch screen, motion and data allowed. */
  applies(): boolean {
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      return false;
    }
    const media = (query: string) => window.matchMedia?.(query).matches ?? false;
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true;
    return (
      media('(hover: none) and (pointer: coarse)') &&
      !media('(prefers-reduced-motion: reduce)') &&
      !saveData
    );
  }

  register(card: InViewPreviewCard): void {
    this.observer ??= new IntersectionObserver((entries) => this.onIntersect(entries), {
      threshold: [0, VISIBLE_RATIO, 1],
    });
    this.cards.set(card.element, card);
    this.observer.observe(card.element);
  }

  unregister(card: InViewPreviewCard): void {
    this.observer?.unobserve(card.element);
    this.cards.delete(card.element);
    this.visible.delete(card.element);
    if (this.active === card) {
      this.active = null;
      this.schedulePick();
    }
    this.updateListening();
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO) {
        this.visible.add(entry.target);
      } else {
        this.visible.delete(entry.target);
      }
    }
    this.updateListening();
    this.schedulePick();
  }

  /** Scrolling moves which card is nearest the middle without crossing a threshold. */
  private updateListening(): void {
    const want = this.visible.size > 1;
    if (want !== this.listening) {
      this.listening = want;
      // Capture, so rails that scroll sideways count too.
      if (want) {
        window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
      } else {
        window.removeEventListener('scroll', this.onScroll, { capture: true });
      }
    }
  }

  /** For tests: forget every card and the observer. */
  reset(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.cards.clear();
    this.visible.clear();
    this.active = null;
    this.picking = false;
    this.updateListening();
  }

  /** Looks again, e.g. after a card's clip failed. */
  refresh(): void {
    this.schedulePick();
  }

  private schedulePick(): void {
    if (this.picking) {
      return;
    }
    this.picking = true;
    requestAnimationFrame(() => {
      this.picking = false;
      this.pick();
    });
  }

  private pick(): void {
    const middleX = window.innerWidth / 2;
    const middleY = window.innerHeight / 2;
    let best: InViewPreviewCard | null = null;
    let bestDistance = Infinity;
    for (const element of this.visible) {
      const card = this.cards.get(element);
      if (!card?.canPlay()) {
        continue;
      }
      const box = element.getBoundingClientRect();
      const distance = Math.hypot(
        box.left + box.width / 2 - middleX,
        box.top + box.height / 2 - middleY,
      );
      if (distance < bestDistance) {
        best = card;
        bestDistance = distance;
      }
    }
    if (best !== this.active) {
      this.active?.setActive(false);
      this.active = best;
      best?.setActive(true);
    }
  }
}

export const inViewPreviews = new InViewPreviews();
