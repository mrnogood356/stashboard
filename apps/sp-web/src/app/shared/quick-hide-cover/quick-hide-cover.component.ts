import { Component, ElementRef, effect, inject } from '@angular/core';
import { QuickHideService } from '../../core/quick-hide/quick-hide.service';

/** A plain screen over everything after Quick hide; a tap, Enter or Space brings the app back. */
@Component({
  selector: 'app-quick-hide-cover',
  template: `
    @if (quickHide.hidden()) {
      <button
        type="button"
        class="quick-hide-cover"
        data-testid="quick-hide-cover"
        aria-label="Show Stashboard"
        (click)="quickHide.reveal()"
      >
        <span>Tap to continue</span>
      </button>
    }
  `,
  styles: `
    .quick-hide-cover {
      position: fixed;
      inset: 0;
      z-index: 2000;
      display: grid;
      place-items: center;
      width: 100%;
      border: 0;
      padding: 0;
      background: var(--app-bg, #0b0b0f);
      color: var(--text-muted, #8a8a96);
      font: inherit;
      font-size: 0.9rem;
      cursor: pointer;
    }
  `,
})
export class QuickHideCoverComponent {
  protected readonly quickHide = inject(QuickHideService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Focus moves onto the cover, so keys reach it and nothing behind it.
    effect(() => {
      if (this.quickHide.hidden()) {
        queueMicrotask(() =>
          this.host.nativeElement.querySelector<HTMLButtonElement>('button')?.focus(),
        );
      }
    });
  }
}
