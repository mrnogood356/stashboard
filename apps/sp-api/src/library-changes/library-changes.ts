import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, finalize } from 'rxjs';

/**
 * A counter that goes up whenever something may have changed the library:
 * a scene matched, renamed, deleted, merged, requested or brought in. Kept
 * answers (Home's rows) carry the count they were built at, and are built
 * again once it moves, instead of waiting out their time.
 */
let version = 0;

export const libraryChanges = {
  get version(): number {
    return version;
  },
  bump(): void {
    version += 1;
  },
};

/** Routes whose changes can change what's in the library or its scenes. */
const LIBRARY_ROUTES = [
  '/api/organizer',
  '/api/local',
  '/api/library',
  '/api/scenes',
  '/api/requests',
  '/api/downloads',
  '/api/smaller-copies',
  '/api/acquisition',
  '/api/hooks',
];

/** After any change made through those routes, the library counter goes up. */
@Injectable()
export class LibraryChangesInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request | undefined>();
    const method = request?.method?.toUpperCase();
    const path = (request?.originalUrl ?? request?.url ?? '').split('?')[0];
    const changes =
      !!method &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      method !== 'OPTIONS' &&
      LIBRARY_ROUTES.some(
        (route) => path === route || path.startsWith(`${route}/`),
      );
    if (!changes) {
      return next.handle();
    }
    // Failed ones too: a request can change things and then fail part-way.
    return next.handle().pipe(finalize(() => libraryChanges.bump()));
  }
}
