import { Component, Input, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HideOwnedService } from '../../core/preferences/hide-owned.service';

/**
 * Says why a catalog list looks empty when every scene in it is one you
 * already have, and Settings → Hidden is leaving those out. Shows nothing
 * otherwise: the setting itself lives in Settings, not on each list.
 */
@Component({
  selector: 'app-owned-note',
  imports: [RouterLink],
  template: `
    @if (allHidden()) {
      <p class="owned-note" role="status" data-testid="owned-note">
        <i class="pi pi-check-circle" aria-hidden="true"></i>
        You already have every scene here.
        <a routerLink="/settings/hidden">Show scenes you have</a>
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .owned-note {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.5rem;
      margin: 0.75rem 0;
      font-size: 0.88rem;
      color: var(--text-muted);
    }

    a {
      color: var(--accent-text);
      font-weight: 600;
      text-decoration: none;
    }
  `,
})
export class OwnedNoteComponent {
  private readonly hideOwned = inject(HideOwnedService);
  /** Scenes loaded in the list, before leaving out the ones you have. */
  @Input() total = 0;
  /** How many of those are in your library. */
  @Input() owned = 0;

  protected allHidden(): boolean {
    return this.hideOwned.hideOwned() && this.total > 0 && this.owned === this.total;
  }
}
