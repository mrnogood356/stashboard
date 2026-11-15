import { CanDeactivateFn } from '@angular/router';

/** A page with edits you save with a button. */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

/** Leaving a page with edits not saved asks first, instead of dropping them. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (page) =>
  !page?.hasUnsavedChanges?.() ||
  window.confirm('Leave without saving? The changes on this page will be lost.');
