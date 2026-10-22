import { Component, EventEmitter, Input, Output } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * "Hiding 3 scenes · Show anyway": how many scenes in a catalog list
 * Settings → Hidden content left out, with a switch to show them for this
 * list only. Shows nothing while nothing is hidden.
 */
@Component({
  selector: 'app-hidden-count',
  imports: [RouterLink],
  template: `
    @if (count > 0 || showing) {
      <p class="hidden-count" data-testid="hidden-count">
        <i
          class="pi"
          [class.pi-eye-slash]="!showing"
          [class.pi-eye]="showing"
          aria-hidden="true"
        ></i>
        <span role="status">{{ label() }}</span>
        <button type="button" class="link" [attr.aria-pressed]="showing" (click)="toggle()">
          {{ showing ? 'Hide again' : 'Show anyway' }}
        </button>
        <a class="link faint" routerLink="/settings/hidden">Edit list</a>
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .hidden-count {
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
      text-decoration: none;
      cursor: pointer;
    }

    .link.faint {
      color: var(--text-muted);
      font-weight: 500;
    }
  `,
})
export class HiddenCountComponent {
  /** Scenes left out of what's loaded so far. */
  @Input() count = 0;
  /** True while hidden scenes are being shown for this list. */
  @Input() showing = false;
  /** The new "show hidden" value. */
  @Output() readonly toggled = new EventEmitter<boolean>();

  protected label(): string {
    if (this.showing) {
      return 'Showing hidden scenes';
    }
    return `Hiding ${this.count} ${this.count === 1 ? 'scene' : 'scenes'}`;
  }

  protected toggle(): void {
    this.toggled.emit(!this.showing);
  }
}
