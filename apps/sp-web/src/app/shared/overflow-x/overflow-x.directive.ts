import {
  AfterViewInit,
  Directive,
  ElementRef,
  NgZone,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';

/**
 * Tells whether a sideways-scrolling row holds more than it can show, so a
 * section can offer "See all" only when something is cut off. Rechecks when the
 * row is resized (window, rotation) or its items change.
 *
 *   <div class="rail" appOverflowX #rail="overflowX"> … rail.overflowing()
 */
@Directive({
  selector: '[appOverflowX]',
  exportAs: 'overflowX',
})
export class OverflowXDirective implements AfterViewInit, OnDestroy {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;

  readonly overflowing = signal(false);

  ngAfterViewInit(): void {
    this.check();
    this.zone.runOutsideAngular(() => {
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.check());
        this.resizeObserver.observe(this.element);
      }
      if (typeof MutationObserver !== 'undefined') {
        this.mutationObserver = new MutationObserver(() => this.check());
        this.mutationObserver.observe(this.element, { childList: true });
      }
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
  }

  /** One pixel of slack for sub-pixel rounding. */
  check(): void {
    const next = this.element.scrollWidth > this.element.clientWidth + 1;
    if (next !== this.overflowing()) {
      this.zone.run(() => this.overflowing.set(next));
    }
  }
}
