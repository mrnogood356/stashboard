import { lastValueFrom, of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { LibraryChangesInterceptor, libraryChanges } from './library-changes';

function context(method: string, url: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, originalUrl: url }) }),
  } as unknown as ExecutionContext;
}

const handler = (result = of('ok')): CallHandler => ({ handle: () => result });

describe('LibraryChangesInterceptor', () => {
  const interceptor = new LibraryChangesInterceptor();

  it('counts a change made through a library route, even one that fails', async () => {
    const before = libraryChanges.version;
    await lastValueFrom(
      interceptor.intercept(
        context('POST', '/api/organizer/match-selected'),
        handler(),
      ),
    );
    expect(libraryChanges.version).toBe(before + 1);
    await expect(
      lastValueFrom(
        interceptor.intercept(
          context('DELETE', '/api/local/scenes/4?deleteFile=1'),
          handler(throwError(() => new Error('half done'))),
        ),
      ),
    ).rejects.toThrow('half done');
    expect(libraryChanges.version).toBe(before + 2);
  });

  it('leaves the count alone for reads and other routes', async () => {
    const before = libraryChanges.version;
    await lastValueFrom(
      interceptor.intercept(
        context('GET', '/api/organizer/proposals'),
        handler(),
      ),
    );
    await lastValueFrom(
      interceptor.intercept(
        context('POST', '/api/about/changes/seen'),
        handler(),
      ),
    );
    // A route that only starts with the same letters.
    await lastValueFrom(
      interceptor.intercept(context('POST', '/api/localx'), handler()),
    );
    expect(libraryChanges.version).toBe(before);
  });
});
