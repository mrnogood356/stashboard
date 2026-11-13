import { Component, Input, booleanAttribute } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export interface PageTab {
  label: string;
  route: string;
  testId: string;
}

/** Browse: Scenes, People and Studios, one page with a tab each. */
export const BROWSE_TABS: readonly PageTab[] = [
  { label: 'Scenes', route: '/scenes', testId: 'browse-tab-scenes' },
  { label: 'People', route: '/performers', testId: 'browse-tab-people' },
  { label: 'Studios', route: '/studios', testId: 'browse-tab-studios' },
];

/** Requests, with the downloads they turn into folded in as a tab. */
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
  imports: [RouterLink, RouterLinkActive],
  template: `
    <div class="page-tabs-head">
      <h1>{{ title }}</h1>
      @if (search) {
        <a class="page-tabs-search" routerLink="/search" data-testid="page-tabs-search">
          <i class="pi pi-search" aria-hidden="true"></i>
          <span>Search scenes, people and studios</span>
        </a>
      }
      <nav class="page-tabs" [attr.aria-label]="title">
        @for (tab of tabs; track tab.route) {
          <a
            class="page-tab"
            [routerLink]="tab.route"
            routerLinkActive="is-active"
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
export class PageTabsComponent {
  @Input({ required: true }) title = '';
  @Input({ required: true }) tabs: readonly PageTab[] = [];
  @Input({ transform: booleanAttribute }) search = false;
}
