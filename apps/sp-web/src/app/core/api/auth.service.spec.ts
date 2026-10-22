import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';

const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
}));

describe('AuthService', () => {
  let service: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    startAuthentication.mockReset();
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('sends "keep me signed in" with the password', () => {
    service.login({ username: 'admin', password: 'pw', rememberMe: false }).subscribe();
    const request = http.expectOne('/api/auth/login');
    expect(request.request.body).toEqual({ username: 'admin', password: 'pw', rememberMe: false });
    request.flush({ bootstrapRequired: false, authenticated: true, username: 'admin' });
  });

  it('signs in with a passkey: options, the Face ID prompt, then the check', async () => {
    const assertion = { id: 'cred-1', response: {} };
    startAuthentication.mockResolvedValue(assertion);

    const done = service.loginWithPasskey(true);
    await vi.waitFor(() =>
      http.expectOne('/api/auth/login/passkey/options').flush({ challenge: 'c' }),
    );
    await vi.waitFor(() => {
      const verify = http.expectOne('/api/auth/login/passkey');
      expect(verify.request.body).toEqual({ response: assertion, rememberMe: true });
      verify.flush({
        bootstrapRequired: false,
        authenticated: true,
        username: 'admin',
        passkeySignIn: false,
      });
    });

    await expect(done).resolves.toMatchObject({ authenticated: true });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(service.status()?.username).toBe('admin');
  });

  it('stops when the Face ID prompt is cancelled', async () => {
    startAuthentication.mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }),
    );
    const done = service.loginWithPasskey(true);
    await vi.waitFor(() =>
      http.expectOne('/api/auth/login/passkey/options').flush({ challenge: 'c' }),
    );
    await expect(done).rejects.toMatchObject({ name: 'NotAllowedError' });
    http.expectNone('/api/auth/login/passkey');
  });
});
