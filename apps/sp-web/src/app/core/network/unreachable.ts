import { HttpErrorResponse } from '@angular/common/http';
import { Router, UrlTree } from '@angular/router';

/**
 * No answer from Stashboard itself: offline, or the server restarting behind
 * a proxy (502–504). Not a reason to sign in again or to redo setup.
 */
export function isUnreachableError(error: unknown): boolean {
  return (
    error instanceof HttpErrorResponse &&
    (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)
  );
}

/** The "can't reach Stashboard" page, which comes back to `url` once it can. */
export function unreachableUrl(router: Router, url: string): UrlTree {
  return router.createUrlTree(['/unreachable'], {
    queryParams: url && url !== '/' && !url.startsWith('/unreachable') ? { next: url } : {},
  });
}

/** Only paths inside the app, so the page can't be used to send you elsewhere. */
export function safeNextUrl(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/unreachable')
    ? next
    : '/';
}
