import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { AppUpdatesService } from '../../core/pwa/app-updates.service';

/** A small notice at the bottom: offline, or a newer Stashboard is ready. */
@Component({
  selector: 'app-status',
  template: `
    @if (updates.offline() && !onUnreachablePage()) {
      <p class="app-status" role="status" data-testid="offline-notice">
        <i class="pi pi-wifi" aria-hidden="true"></i>
        You’re offline. Stashboard picks up again when you’re back online.
      </p>
    } @else if (updates.updateReady()) {
      <p class="app-status" role="status" data-testid="update-notice">
        <i class="pi pi-refresh" aria-hidden="true"></i>
        Stashboard has been updated.
        <button type="button" data-testid="update-reload" (click)="updates.reload()">Reload</button>
      </p>
    }
  `,
  styles: `
    :host {
      position: fixed;
      left: 50%;
      bottom: calc(1rem + env(safe-area-inset-bottom));
      transform: translateX(-50%);
      z-index: 1100;
      width: max-content;
      max-width: calc(100vw - 2rem);
      pointer-events: none;
    }

    .app-status {
      pointer-events: auto;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.6rem 0.75rem 0.6rem 0.9rem;
      border-radius: 999px;
      background: var(--surface-elevated);
      color: var(--text-primary);
      border: 1px solid var(--border-subtle);
      font-size: 0.86rem;
      line-height: 1.3;
      box-shadow: 0 8px 24px rgb(0 0 0 / 0.28);
    }

    button {
      flex: none;
      border: 0;
      border-radius: 999px;
      padding: 0.35rem 0.8rem;
      background: var(--accent);
      color: var(--accent-contrast);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }

    /* Above the phone tab bar. */
    @media (max-width: 720px) {
      :host {
        bottom: calc(5.25rem + env(safe-area-inset-bottom));
      }

      .app-status {
        border-radius: var(--radius-md, 14px);
      }
    }
  `,
})
export class AppStatusComponent {
  protected readonly updates = inject(AppUpdatesService);
  private readonly router = inject(Router);

  /** That page says it already. */
  protected readonly onUnreachablePage = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url.startsWith('/unreachable')),
    ),
    { initialValue: false },
  );
}
