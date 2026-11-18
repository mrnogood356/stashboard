import { Directive, ElementRef, OnDestroy, OnInit, inject } from '@angular/core';
import { Location } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter, take } from 'rxjs';
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
  private readonly router = inject(Router);
  /** A Back already on its way: a second tap meanwhile would go back twice. */
  private goingBack = false;

  // Capture: it runs before the link's own navigation and can stop it.
  private readonly onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (this.goingBack) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Only when the browser's own Back leads there; otherwise the link opens it.
    const behind = this.history.behind();
    const target = this.element.nativeElement.getAttribute('href');
    if (!behind || !target || !sameUrl(behind, target)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.goingBack = true;
    this.router.events
      .pipe(
        filter((routerEvent) => routerEvent instanceof NavigationEnd),
        take(1),
      )
      .subscribe(() => (this.goingBack = false));
    this.location.back();
  };

  ngOnInit(): void {
    this.element.nativeElement.addEventListener('click', this.onClick, true);
  }

  ngOnDestroy(): void {
    this.element.nativeElement.removeEventListener('click', this.onClick, true);
  }
}

/**
 * The same page and query, whatever the order of the query's keys. A key
 * given more than once keeps its values in order: ?q=a&q=b isn't ?q=b&q=a.
 */
export function sameUrl(a: string, b: string): boolean {
  const normalize = (url: string) => {
    const [path, query = ''] = url.split('#', 1)[0].split('?');
    const byKey = new Map<string, string[]>();
    for (const part of query.split('&').filter(Boolean)) {
      const key = part.split('=', 1)[0];
      byKey.set(key, [...(byKey.get(key) ?? []), part]);
    }
    const keys = [...byKey.keys()].sort();
    return `${path}?${keys.map((key) => byKey.get(key)!.join('&')).join('&')}`;
  };
  return normalize(a) === normalize(b);
}
