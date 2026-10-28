import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from '../api/auth.service';
import { isUnreachableError, unreachableUrl } from '../network/unreachable';

export const requireAuthenticatedGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.refreshStatus().pipe(
    map((status) => {
      if (status.bootstrapRequired) {
        return router.createUrlTree(['/bootstrap']);
      }

      return status.authenticated ? true : router.createUrlTree(['/login']);
    }),
    catchError((error: unknown) =>
      of(
        isUnreachableError(error)
          ? unreachableUrl(router, state.url)
          : router.createUrlTree(['/login']),
      ),
    ),
  );
};

export const loginOnlyWhenLoggedOutGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.refreshStatus().pipe(
    map((status) => {
      if (status.bootstrapRequired) {
        return router.createUrlTree(['/bootstrap']);
      }

      return status.authenticated ? router.createUrlTree(['/']) : true;
    }),
    catchError(() => of(true)),
  );
};

export const bootstrapOnlyWhenRequiredGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  return authService.refreshStatus().pipe(
    map((status) => {
      if (status.bootstrapRequired) {
        return true;
      }

      return status.authenticated ? router.createUrlTree(['/']) : router.createUrlTree(['/login']);
    }),
    catchError(() => of(true)),
  );
};
