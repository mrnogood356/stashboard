import { HttpErrorResponse, HttpEvent, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';
import { AppLockService } from '../app-lock/app-lock.service';

/**
 * Tells the server when this is the app installed on a phone, where App Lock
 * applies. When the server says it is locked (423), shows the lock screen and
 * holds the request until it is unlocked, then sends it again, so pages never
 * see the refusal as an error.
 */
export const appLockInterceptor: HttpInterceptorFn = (request, next) => {
  const appLock = inject(AppLockService);
  const sent = appLock.isPhoneApp()
    ? request.clone({ setHeaders: { 'X-Stashboard-App': 'phone' } })
    : request;
  const key = `${sent.method} ${sent.urlWithParams} ${bodyKey(sent.body)}`;
  const send = (): Observable<HttpEvent<unknown>> =>
    next(sent).pipe(
      catchError((error: unknown) => {
        if (
          error instanceof HttpErrorResponse &&
          error.status === 423 &&
          (error.error as { code?: unknown } | null)?.code === 'APP_LOCKED'
        ) {
          appLock.markLocked();
          return appLock.afterUnlock(key, send);
        }
        return throwError(() => error);
      }),
    );
  return send();
};

/** The body as text, so the same request is recognised; files are never the same. */
function bodyKey(body: unknown): string {
  if (body === null || body === undefined) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Blob || body instanceof FormData || body instanceof ArrayBuffer) {
    return `upload-${Math.random()}`;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return `body-${Math.random()}`;
  }
}
