import { Component, Input, inject } from '@angular/core';
import { HideOwnedService } from '../../core/preferences/hide-owned.service';

/**
 * "Hide ones I have" for a catalog list, or, while it's on, "Hiding 4 you
 * have · Show them". The choice is shared by every catalog list.
 */
@Component({
  selector: 'app-owned-toggle',
  template: `
    <p class="owned-toggle" data-testid="owned-toggle">
      <i
        class="pi"
        [class.pi-check-circle]="!hiding()"
        [class.pi-eye-slash]="hiding()"
        aria-hidden="true"
      ></i>
      @if (hiding()) {
        <span role="status">{{ label() }}</span>
      }
      <button type="button" class="link" [attr.aria-pressed]="hiding()" (click)="toggle()">
        {{ hiding() ? 'Show them' : 'Hide ones I have' }}
      </button>
    </p>
  `,
  styles: `
    :host {
      display: block;
    }

    .owned-toggle {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.6rem;
      margin: 0.35rem 0 0;
      font-size: 0.82rem;
      color: var(--text-muted);
    }

    .link {
      padding: 0;
      min-height: 2rem;
      border: 0;
      background: none;
      color: var(--accent-text);
      font: inherit;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
    }
  `,
})
export class OwnedToggleComponent {
  private readonly hideOwned = inject(HideOwnedService);
  /** Scenes in the loaded list that are in your library. */
  @Input() count = 0;

  protected readonly hiding = this.hideOwned.hideOwned;

  protected label(): string {
    return this.count === 0 ? 'Hiding ones you have' : `Hiding ${this.count} you have`;
  }

  protected toggle(): void {
    this.hideOwned.set(!this.hiding());
  }
}
