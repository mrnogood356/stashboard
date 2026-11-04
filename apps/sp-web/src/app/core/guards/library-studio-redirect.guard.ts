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
 * A studio from your library, everywhere it's linked from: its catalog page
 * (every scene it has made, the ones you have marked) when Stash links it
 * to the catalog, else its page in your library.
 */
export const libraryStudioRedirectGuard: CanActivateFn = (
  route: ActivatedRouteSnapshot,
): Observable<UrlTree> => {
  const router = inject(Router);
  const local = inject(LocalLibraryService);
  const discover = inject(DiscoverService);
  const id = route.paramMap.get('id') ?? '';
  const queryParams = route.queryParams;
  const libraryPage = router.createUrlTree(['/library/studio', id], { queryParams });
  return local.studio(id).pipe(
    // Linked to more than one stash-box: the first the catalog knows.
    switchMap((studio) =>
      concat(
        ...(studio.catalogIds ?? []).map((catalogId) =>
          discover.getStudioDetails(catalogId).pipe(
            map(() => catalogId),
            catchError(() => of(null)),
          ),
        ),
      ).pipe(
        filter((catalogId): catalogId is string => catalogId !== null),
        take(1),
        map((catalogId) => router.createUrlTree(['/studio', catalogId], { queryParams })),
        defaultIfEmpty(libraryPage),
      ),
    ),
    catchError(() => of(libraryPage)),
  );
};
