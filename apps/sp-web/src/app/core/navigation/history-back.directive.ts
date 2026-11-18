import { Directive, ElementRef, OnDestroy, OnInit, inject } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationHistoryService } from './navigation-history.service';

/**
 * On a page's back link: when it goes to the page you just came from, it
 * goes back in history instead of opening that page afresh, so the page
 * comes back as you left it (your search, filters and place in the list).
 * Otherwise the link works as usual.
 */
@Directive({ selector: 'a[appHistoryBack]' })
export class HistoryBackDirective implements OnInit, OnDestroy {
  private readonly element = inject<ElementRef<HTMLAnchorElement>>(ElementRef);
  private readonly location = inject(Location);
  private readonly history = inject(NavigationHistoryService);

  // Capture: it runs before the link's own navigation and can stop it.
  private readonly onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const previous = this.history.previous();
    const target = this.element.nativeElement.getAttribute('href');
    if (!previous || !target || !sameUrl(previous, target)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.location.back();
  };

  ngOnInit(): void {
    this.element.nativeElement.addEventListener('click', this.onClick, true);
  }

  ngOnDestroy(): void {
    this.element.nativeElement.removeEventListener('click', this.onClick, true);
  }
}

/** The same page and query, whatever the order of the query's parts. */
export function sameUrl(a: string, b: string): boolean {
  const normalize = (url: string) => {
    const [path, query = ''] = url.split('#', 1)[0].split('?');
    return `${path}?${query.split('&').filter(Boolean).sort().join('&')}`;
  };
  return normalize(a) === normalize(b);
}
