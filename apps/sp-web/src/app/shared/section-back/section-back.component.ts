import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  NavigationHistoryService,
  pageLabel,
} from '../../core/navigation/navigation-history.service';

/**
 * The back button on sections the phone opens from More (Search, Performers,
 * Studios, Downloads, Tools, Settings), which aren't in the tab bar. It goes
 * back to the page you came from, or Home. Hidden on wider screens, where
 * the sidebar is always there.
 */
@Component({
  selector: 'app-section-back',
  template: `
    <button
      type="button"
      class="back-link app-back-link app-back-link--media section-back"
      data-testid="section-back"
      (click)="back()"
    >
      {{ label() }}
    </button>
  `,
  styles: `
    :host {
      display: none;
    }

    @media (max-width: 720px) {
      :host {
        display: block;
      }
    }

    .section-back {
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      cursor: pointer;
    }
  `,
})
export class SectionBackComponent {
  private readonly router = inject(Router);
  private readonly history = inject(NavigationHistoryService);

  protected readonly label = computed(() => pageLabel(this.history.previous()));

  protected back(): void {
    if (this.history.previous()) {
      window.history.back();
    } else {
      void this.router.navigateByUrl('/home');
    }
  }
}
