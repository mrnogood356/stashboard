import { ImageObscurationToggleComponent } from '../image-obscuration-toggle/image-obscuration-toggle.component';
import {
  Component,
  DestroyRef,
  Input,
  OnInit,
  booleanAttribute,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged, map } from 'rxjs';

export interface PageTab {
  label: string;
  route: string;
  testId: string;
}

/** Browse: Scenes, Performers and Studios, one page with a tab each. */
export const BROWSE_TABS: readonly PageTab[] = [
  { label: 'Scenes', route: '/scenes', testId: 'browse-tab-scenes' },
  { label: 'Performers', route: '/performers', testId: 'browse-tab-performers' },
  { label: 'Studios', route: '/studios', testId: 'browse-tab-studios' },
];

/** Queue: Requests, and the downloads they turn into, as two tabs. */
export const REQUESTS_TABS: readonly PageTab[] = [
  { label: 'Requests', route: '/acquisition', testId: 'requests-tab-requests' },
  { label: 'Downloads', route: '/processing', testId: 'requests-tab-downloads' },
];

/**
 * The top of a page made of tabs (Browse, Requests): its title, Search when
 * asked for, and underline tabs that are links, so each keeps its own URL,
 * filters and Back.
 */
@Component({
  selector: 'app-page-tabs',
  imports: [ImageObscurationToggleComponent, RouterLink, RouterLinkActive],
  template: `
    <div class="page-tabs-head">
      <div class="page-tabs-title">
        <h1>{{ title }}</h1>
        <app-image-obscuration-toggle class="phone-eye" />
      </div>
      @if (search) {
        <label class="page-tabs-search" data-testid="page-tabs-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <input
            type="search"
            enterkeyhint="search"
            autocomplete="off"
            [placeholder]="'Search ' + searchHint"
            [attr.aria-label]="'Search ' + searchHint"
            [value]="query()"
            (input)="onType($any($event.target).value)"
            (keydown.enter)="onType($any($event.target).value, true)"
            data-testid="page-tabs-search-input"
          />
          @if (query()) {
            <button
              type="button"
              class="page-tabs-clear"
              aria-label="Clear search"
              (click)="onType('', true)"
            >
              <i class="pi pi-times" aria-hidden="true"></i>
            </button>
          }
        </label>
      }
      <nav class="page-tabs" [attr.aria-label]="title">
        @for (tab of tabs; track tab.route) {
          <a
            class="page-tab"
            [routerLink]="tab.route"
            [queryParams]="query() ? { q: query() } : {}"
            routerLinkActive="is-active"
            [routerLinkActiveOptions]="{
              paths: 'exact',
              queryParams: 'ignored',
              matrixParams: 'ignored',
              fragment: 'ignored',
            }"
            #active="routerLinkActive"
            [attr.aria-current]="active.isActive ? 'page' : null"
            [attr.data-testid]="tab.testId"
            >{{ tab.label }}</a
          >
        }
      </nav>
    </div>
  `,
  styleUrl: './page-tabs.component.scss',
})
export class PageTabsComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly typed = new Subject<string>();

  @Input({ required: true }) title = '';
  @Input({ required: true }) tabs: readonly PageTab[] = [];
  /**
   * A search box that searches the tab you're on, as you type ("q" in the
   * URL, which Scenes, Performers and Studios each read), and goes with you to
   * the other tabs.
   */
  @Input({ transform: booleanAttribute }) search = false;
  /** What the search box looks through, said in it: "scenes", "people"... */
  @Input() searchHint = 'this list';

  protected readonly query = signal('');

  ngOnInit(): void {
    this.route.queryParamMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => this.query.set(params.get('q') ?? ''));
    this.typed
      .pipe(
        map((value) => value.trim()),
        debounceTime(350),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((value) => this.apply(value));
  }

  protected onType(value: string, now = false): void {
    if (now) {
      this.query.set(value.trim());
      this.apply(value.trim());
      return;
    }
    this.typed.next(value);
  }

  private apply(value: string): void {
    if ((this.route.snapshot.queryParamMap.get('q') ?? '') === value) {
      return;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: value || null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
