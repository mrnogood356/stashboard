import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { GuardResult, Router, UrlTree, provideRouter } from '@angular/router';
import { firstValueFrom, isObservable, of, throwError } from 'rxjs';
import { AuthService } from '../api/auth.service';
import {
  bootstrapOnlyWhenRequiredGuard,
  loginOnlyWhenLoggedOutGuard,
  requireAuthenticatedGuard,
} from './auth-route.guard';

describe('auth route guards', () => {
  let router: Router;
  let authService: { refreshStatus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    authService = {
      refreshStatus: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: authService,
        },
      ],
    });

    router = TestBed.inject(Router);
  });

  it('routes fresh installs to /bootstrap', async () => {
    authService.refreshStatus.mockReturnValue(
      of({
        bootstrapRequired: true,
        authenticated: false,
        username: null,
      }),
    );

    const result = await runGuard(requireAuthenticatedGuard);

    expect(router.serializeUrl(result as UrlTree)).toBe('/bootstrap');
  });

  it('says Stashboard can’t be reached, instead of asking to sign in, when offline or restarting', async () => {
    for (const status of [0, 502, 503]) {
      authService.refreshStatus.mockReturnValue(
        throwError(() => new HttpErrorResponse({ status })),
      );

      const result = await runGuard(requireAuthenticatedGuard, '/library?sort=new');

      expect(router.serializeUrl(result as UrlTree)).toBe(
        '/unreachable?next=%2Flibrary%3Fsort%3Dnew',
      );
    }
  });

  it('still asks to sign in for other errors', async () => {
    authService.refreshStatus.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 500 })),
    );

    const result = await runGuard(requireAuthenticatedGuard);

    expect(router.serializeUrl(result as UrlTree)).toBe('/login');
  });

  it('routes existing installs without a session to /login', async () => {
    authService.refreshStatus.mockReturnValue(
      of({
        bootstrapRequired: false,
        authenticated: false,
        username: null,
      }),
    );

    const result = await runGuard(requireAuthenticatedGuard);

    expect(router.serializeUrl(result as UrlTree)).toBe('/login');
  });

  it('allows authenticated users through protected app routes', async () => {
    authService.refreshStatus.mockReturnValue(
      of({
        bootstrapRequired: false,
        authenticated: true,
        username: 'admin',
      }),
    );

    const result = await runGuard(requireAuthenticatedGuard);

    expect(result).toBe(true);
  });

  it('allows /bootstrap only while no admin exists', async () => {
    authService.refreshStatus.mockReturnValue(
      of({
        bootstrapRequired: true,
        authenticated: false,
        username: null,
      }),
    );

    const result = await runGuard(bootstrapOnlyWhenRequiredGuard);

    expect(result).toBe(true);
  });

  it('redirects /login to the app when the admin is already authenticated', async () => {
    authService.refreshStatus.mockReturnValue(
      of({
        bootstrapRequired: false,
        authenticated: true,
        username: 'admin',
      }),
    );

    const result = await runGuard(loginOnlyWhenLoggedOutGuard);

    expect(router.serializeUrl(result as UrlTree)).toBe('/');
  });
});

async function runGuard(
  guard: typeof requireAuthenticatedGuard,
  url = '/scenes',
): Promise<GuardResult> {
  const result = TestBed.runInInjectionContext(() => guard({} as never, { url } as never));

  if (isObservable(result)) {
    return firstValueFrom(result);
  }

  return result;
}
