import { inject } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivateFn, Router, UrlTree } from '@angular/router';
import {
  Observable,
  catchError,
  concat,
  defaultIfEmpty,
  filter,
  map,
  of,
  switchMap,
  take,
} from 'rxjs';
import { DiscoverService } from '../api/discover.service';
import { LocalLibraryService } from '../api/local-library.service';

/**
 * A performer from a library scene: their catalog page (every scene they've
 * made, the ones you have marked, with sorting) when Stash links them to the
 * catalog, else their page in your library.
 */
export const libraryPerformerRedirectGuard: CanActivateFn = (
  route: ActivatedRouteSnapshot,
): Observable<UrlTree> => {
  const router = inject(Router);
  const local = inject(LocalLibraryService);
  const discover = inject(DiscoverService);
  const id = route.paramMap.get('id') ?? '';
  const queryParams = route.queryParams;
  const libraryPage = router.createUrlTree(['/library/performer', id], { queryParams });
  return local.performer(id).pipe(
    // Linked to more than one stash-box: the first the catalog knows.
    switchMap((performer) =>
      concat(
        ...(performer.catalogIds ?? []).map((catalogId) =>
          discover.getPerformerDetails(catalogId).pipe(
            map(() => catalogId),
            catchError(() => of(null)),
          ),
        ),
      ).pipe(
        filter((catalogId): catalogId is string => catalogId !== null),
        take(1),
        map((catalogId) => router.createUrlTree(['/performer', catalogId], { queryParams })),
        defaultIfEmpty(libraryPage),
      ),
    ),
    catchError(() => of(libraryPage)),
  );
};
