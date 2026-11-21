import { Injectable, inject } from '@angular/core';
import { Confirmation, ConfirmationService } from 'primeng/api';

/**
 * The confirm dialog's code loads just after the first page. PrimeNG hands a
 * confirmation only to a dialog already listening, so one asked for in that
 * moment would be lost: this keeps the last one until the dialog is up.
 */
@Injectable({ providedIn: 'root' })
export class EarlyConfirmations {
  private readonly confirmations = inject(ConfirmationService);
  private ready = false;
  private pending: Confirmation | null = null;

  /** Starts listening; called once at app start. */
  start(): void {
    this.confirmations.requireConfirmation$.subscribe((confirmation) => {
      if (!this.ready) {
        // A close (null) before the dialog was up cancels the waiting one.
        this.pending = confirmation;
      }
    });
  }

  /** The dialog is listening now: hand it what was asked meanwhile. */
  dialogReady(): void {
    this.ready = true;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.confirmations.confirm(pending);
    }
  }
}
