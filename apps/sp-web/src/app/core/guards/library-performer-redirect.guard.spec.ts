import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, UrlTree, convertToParamMap } from '@angular/router';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DiscoverService } from '../api/discover.service';
import { LocalLibraryService } from '../api/local-library.service';
import { libraryPerformerRedirectGuard } from './library-performer-redirect.guard';

function run(
  catalogIds: string[] | undefined,
  known: string[],
  fails = false,
  provider?: string,
): Promise<string> {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: LocalLibraryService,
        useValue: {
          performer: () =>
            fails ? throwError(() => new Error('down')) : of({ id: '5', name: 'S', catalogIds }),
        },
      },
      {
        provide: DiscoverService,
        useValue: {
          getPerformerDetails: vi.fn((id: string) =>
            known.includes(id) ? of({ id, provider }) : throwError(() => new Error('404')),
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
    libraryPerformerRedirectGuard(route, {} as never),
  ) as Observable<UrlTree>;
  const router = TestBed.inject(Router);
  return firstValueFrom(result).then((tree) => router.serializeUrl(tree));
}

describe('libraryPerformerRedirectGuard', () => {
  it('opens the catalog page of a linked performer, the first one the catalog knows', async () => {
    expect(await run(['fansdb-id', 'stashdb-id'], ['stashdb-id'])).toBe(
      '/performer/stashdb-id?returnTo=%2Flibrary',
    );
  });

  it('keeps the catalog that had them, so their scenes come from it too', async () => {
    expect(await run(['fansdb-id'], ['fansdb-id'], false, 'FANSDB')).toBe(
      '/performer/fansdb-id?returnTo=%2Flibrary&provider=FANSDB',
    );
  });

  it('falls back to the library page when they aren’t linked or can’t be read', async () => {
    expect(await run([], [])).toBe('/library/performer/5?returnTo=%2Flibrary');
    TestBed.resetTestingModule();
    expect(await run(['x'], [])).toBe('/library/performer/5?returnTo=%2Flibrary');
    TestBed.resetTestingModule();
    expect(await run(undefined, [], true)).toBe('/library/performer/5?returnTo=%2Flibrary');
  });
});
