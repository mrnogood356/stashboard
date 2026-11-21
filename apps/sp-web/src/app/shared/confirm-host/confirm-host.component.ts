import { Component, afterNextRender, inject } from '@angular/core';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { EarlyConfirmations } from './early-confirmations.service';

/** The app's one destructive-confirm dialog, loaded after the first page. */
@Component({
  selector: 'app-confirm-host',
  imports: [ConfirmDialog],
  template: `<p-confirmdialog
    key="app-destructive"
    styleClass="app-confirm-dialog"
    [baseZIndex]="1250"
  />`,
})
export class ConfirmHostComponent {
  constructor() {
    const early = inject(EarlyConfirmations);
    afterNextRender(() => early.dialogReady());
  }
}
