import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { CatalogBrowseService } from '../catalog/catalog-browse.service';

const CATALOG_API_PATTERN = /^\/api\/(scenes|performers|studios|discover)(\/|\?|$)/;

/**
 * Tells the server which catalog provider the current page is showing, for
 * catalog lookups only. Request submissions (/api/requests), Home, acquisition
 * and settings never carry it, so they always use the instance provider.
 */
export const catalogProviderInterceptor: HttpInterceptorFn = (request, next) => {
  if (!CATALOG_API_PATTERN.test(request.url)) {
    return next(request);
  }

  const provider = inject(CatalogBrowseService).providerForRequest();
  return provider
    ? next(request.clone({ setHeaders: { 'X-Catalog-Provider': provider } }))
    : next(request);
};
