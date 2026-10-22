import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Observable, Subject, of, throwError } from 'rxjs';
import { AuthService } from '../../core/api/auth.service';
import type { AuthStatusResponse } from '../../core/api/auth.types';
import { HealthService } from '../../core/api/health.service';
import { LoginPageComponent } from './login-page.component';
import { PASSKEY_SUPPORT } from './passkey-support';

const signedOut: AuthStatusResponse = {
  bootstrapRequired: false,
  authenticated: false,
  username: null,
  passkeySignIn: false,
};

describe('LoginPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function render(
    login: () => Observable<unknown> = () => of({ authenticated: true }),
    options: {
      status?: Partial<AuthStatusResponse> | null;
      passkeysWork?: boolean;
      loginWithPasskey?: () => Promise<unknown>;
      version?: string;
    } = {},
  ) {
    const status = signal<AuthStatusResponse | null>(
      options.status === null ? null : { ...signedOut, ...options.status },
    );
    const authService = {
      status,
      login: vi.fn(login),
      loginWithPasskey: vi.fn(
        options.loginWithPasskey ?? (() => Promise.resolve({ authenticated: true })),
      ),
      refreshStatus: vi.fn(() => of(signedOut)),
    };
    const healthService = {
      getStatus: vi.fn(() =>
        of({
          status: 'ok',
          database: 'ok',
          service: 'sp-api',
          version: options.version ?? '1.4.2',
        }),
      ),
    };
    await TestBed.configureTestingModule({
      imports: [LoginPageComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authService },
        { provide: HealthService, useValue: healthService },
        { provide: PASSKEY_SUPPORT, useValue: () => options.passkeysWork ?? false },
      ],
    }).compileComponents();
    const navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(LoginPageComponent);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const fill = (username: string, password: string) => {
      const user = root.querySelector<HTMLInputElement>('#login-username')!;
      const pass = root.querySelector<HTMLInputElement>('#login-password')!;
      user.value = username;
      user.dispatchEvent(new Event('input'));
      pass.value = password;
      pass.dispatchEvent(new Event('input'));
    };
    const signIn = async (username: string, password: string) => {
      fill(username, password);
      root.querySelector('form')!.dispatchEvent(new Event('submit'));
      await settle();
    };
    const faceIdButton = () =>
      Array.from(root.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Face ID'),
      );
    return {
      authService,
      healthService,
      navigateByUrl,
      fixture,
      root,
      status,
      settle,
      fill,
      signIn,
      faceIdButton,
    };
  }

  const httpError = (status: number, message?: string) =>
    throwError(() => new HttpErrorResponse({ status, error: message ? { message } : null }));

  it('greets with the app name and icon, without developer wording', async () => {
    const { root } = await render();
    expect(root.querySelector('h1')?.textContent).toContain('Stashboard');
    expect(root.textContent).toContain('Welcome back. Sign in to your library.');
    expect(root.querySelector('img.brand-icon')?.getAttribute('src')).toBe('/icons/icon-192.png');
    expect(root.textContent).not.toContain('Protected local access');
    expect(root.textContent).not.toContain('protected API routes');
  });

  it('keeps the autocomplete hints password managers rely on', async () => {
    const { root } = await render();
    expect(root.querySelector('#login-username')?.getAttribute('autocomplete')).toBe('username');
    expect(root.querySelector('#login-password')?.getAttribute('autocomplete')).toBe(
      'current-password',
    );
  });

  it('signs in, kept signed in by default, and opens the app', async () => {
    const { authService, navigateByUrl, signIn } = await render();
    await signIn('admin', 'correct horse');

    expect(authService.login).toHaveBeenCalledWith({
      username: 'admin',
      password: 'correct horse',
      rememberMe: true,
    });
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('sends "keep me signed in" unticked when the box is cleared', async () => {
    const { authService, root, signIn } = await render();
    const remember = root.querySelector<HTMLInputElement>('.remember input')!;
    expect(remember.checked).toBe(true);
    expect(remember.closest('label')?.textContent).toContain('Keep me signed in');
    remember.click();

    await signIn('admin', 'correct horse');
    expect(authService.login).toHaveBeenCalledWith(expect.objectContaining({ rememberMe: false }));
  });

  it('shows and hides the password with an accessible toggle', async () => {
    const { root, settle } = await render();
    const password = root.querySelector<HTMLInputElement>('#login-password')!;
    const toggle = root.querySelector<HTMLButtonElement>('.reveal-toggle')!;

    expect(password.type).toBe('password');
    expect(toggle.type).toBe('button');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show password');
    expect(toggle.getAttribute('aria-controls')).toBe('login-password');

    toggle.click();
    await settle();
    expect(password.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide password');

    toggle.click();
    await settle();
    expect(password.type).toBe('password');
  });

  it('does not send an incomplete form, and says what is missing', async () => {
    const { authService, root, signIn } = await render(() => of({}));
    await signIn('admin', '');
    expect(authService.login).not.toHaveBeenCalled();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Enter your password.');
  });

  it('explains a wrong password without saying which part was wrong', async () => {
    const { navigateByUrl, root, signIn } = await render(() =>
      httpError(401, 'Invalid username or password.'),
    );
    await signIn('admin', 'wrong');

    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Invalid username or password.',
    );
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it("shows the server's lockout wait, which grows with each block", async () => {
    const { root, signIn } = await render(() =>
      httpError(429, 'Too many wrong tries. Wait 4 minutes and try again.'),
    );
    await signIn('admin', 'wrong');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Wait 4 minutes');
  });

  it('points a fresh install to first-run setup', async () => {
    const { root, signIn } = await render(() => httpError(409));
    expect(root.textContent).not.toContain('Create the first admin account');
    await signIn('admin', 'whatever');
    expect(root.textContent).toContain('Complete first-run bootstrap instead.');
    expect(root.querySelector('a[href="/bootstrap"]')?.textContent).toContain(
      'Create the first admin account',
    );
  });

  it('offers first-run setup only when the server says it is needed', async () => {
    const { root } = await render(undefined, { status: { bootstrapRequired: true } });
    expect(root.textContent).toContain('Create the first admin account');
  });

  it('disables the button while signing in', async () => {
    const pending = new Subject<unknown>();
    const { fixture, root, signIn } = await render(() => pending);
    await signIn('admin', 'correct horse');

    const button = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Signing in');
    pending.error(new HttpErrorResponse({ status: 500 }));
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(root.textContent).toContain('Failed to sign in.');
  });

  it('shows the app version in the footer', async () => {
    const { root, healthService } = await render(undefined, { version: '2.3.4' });
    expect(healthService.getStatus).toHaveBeenCalled();
    expect(root.querySelector('footer')?.textContent).toContain('Stashboard 2.3.4');
  });

  it('asks for the sign-in status itself when the route guard could not', async () => {
    const { authService } = await render(undefined, { status: null });
    expect(authService.refreshStatus).toHaveBeenCalled();
  });

  describe('Face ID', () => {
    it('is offered when a passkey exists and this browser and site support it', async () => {
      const { faceIdButton } = await render(undefined, {
        status: { passkeySignIn: true },
        passkeysWork: true,
      });
      expect(faceIdButton()).toBeDefined();
    });

    it('is hidden when no passkey has been added', async () => {
      const { faceIdButton } = await render(undefined, {
        status: { passkeySignIn: false },
        passkeysWork: true,
      });
      expect(faceIdButton()).toBeUndefined();
    });

    it('is hidden where passkeys cannot work, even with one added', async () => {
      const { faceIdButton } = await render(undefined, {
        status: { passkeySignIn: true },
        passkeysWork: false,
      });
      expect(faceIdButton()).toBeUndefined();
    });

    it('is hidden by an older server that does not say', async () => {
      const { faceIdButton } = await render(undefined, {
        status: { passkeySignIn: undefined },
        passkeysWork: true,
      });
      expect(faceIdButton()).toBeUndefined();
    });

    it('signs in with the "keep me signed in" choice and opens the app', async () => {
      const { authService, faceIdButton, navigateByUrl, root, settle } = await render(undefined, {
        status: { passkeySignIn: true },
        passkeysWork: true,
      });
      root.querySelector<HTMLInputElement>('.remember input')!.click();
      faceIdButton()!.click();
      await settle();

      expect(authService.loginWithPasskey).toHaveBeenCalledWith(false);
      expect(authService.login).not.toHaveBeenCalled();
      expect(navigateByUrl).toHaveBeenCalledWith('/');
    });

    it('explains a cancelled Face ID prompt and a refused passkey', async () => {
      const cancelled = Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
      const { faceIdButton, navigateByUrl, root, settle, authService } = await render(undefined, {
        status: { passkeySignIn: true },
        passkeysWork: true,
        loginWithPasskey: () => Promise.reject(cancelled),
      });
      faceIdButton()!.click();
      await settle();
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        'Face ID was cancelled or timed out.',
      );

      authService.loginWithPasskey.mockImplementation(() =>
        Promise.reject(
          new HttpErrorResponse({
            status: 429,
            error: { message: 'Too many wrong tries. Wait 2 minutes and try again.' },
          }),
        ),
      );
      faceIdButton()!.click();
      await settle();
      expect(root.querySelector('[role="alert"]')?.textContent).toContain('Wait 2 minutes');
      expect(navigateByUrl).not.toHaveBeenCalled();
    });
  });
});
