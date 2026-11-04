import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, UrlTree, convertToParamMap } from '@angular/router';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../api/discover.service';
import { LocalLibraryService } from '../api/local-library.service';
import { libraryStudioRedirectGuard } from './library-studio-redirect.guard';

function run(catalogIds: string[] | undefined, known: string[], fails = false): Promise<string> {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: LocalLibraryService,
        useValue: {
          studio: () =>
            fails ? throwError(() => new Error('down')) : of({ id: '5', name: 'S', catalogIds }),
        },
      },
      {
        provide: DiscoverService,
        useValue: {
          getStudioDetails: vi.fn((id: string) =>
            known.includes(id) ? of({ id }) : throwError(() => new Error('404')),
          ),
        },
      },
    ],
  });
  const route = {
    paramMap: convertToParamMap({ id: '5' }),
    queryParams: { returnTo: '/library' },
  } as unknown as ActivatedRouteSnapshot;
  const result = TestBed.runInInjectionContext(() =>
    libraryStudioRedirectGuard(route, {} as never),
  ) as Observable<UrlTree>;
  const router = TestBed.inject(Router);
  return firstValueFrom(result).then((tree) => router.serializeUrl(tree));
}

describe('libraryStudioRedirectGuard', () => {
  it('opens the catalog page of a linked studio, the first one the catalog knows', async () => {
    expect(await run(['fansdb-id', 'stashdb-id'], ['stashdb-id'])).toBe(
      '/studio/stashdb-id?returnTo=%2Flibrary',
    );
  });

  it('falls back to the library page when it isn’t linked or can’t be read', async () => {
    expect(await run([], [])).toBe('/library/studio/5?returnTo=%2Flibrary');
    TestBed.resetTestingModule();
    expect(await run(['x'], [])).toBe('/library/studio/5?returnTo=%2Flibrary');
    TestBed.resetTestingModule();
    expect(await run(undefined, [], true)).toBe('/library/studio/5?returnTo=%2Flibrary');
  });
});
