import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStateStore } from '../api/auth-state.store';
import { authRedirectInterceptor } from './auth-redirect.interceptor';

describe('authRedirectInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  const navigateByUrl = vi.fn().mockResolvedValue(true);
  const clear = vi.fn();

  beforeEach(() => {
    navigateByUrl.mockClear();
    clear.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authRedirectInterceptor])),
        provideHttpClientTesting(),
        { provide: Router, useValue: { url: '/', navigateByUrl } },
        { provide: AuthStateStore, useValue: { clear } },
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  async function respond(url: string, status: number): Promise<void> {
    const request = firstValueFrom(http.post(url, {})).catch(() => undefined);
    controller.expectOne(url).flush({ message: 'x' }, { status, statusText: 'x' });
    await request;
  }

  it('sends a signed-out session to the login page', async () => {
    await respond('/api/app-lock/unlock/pin', 401);
    expect(clear).toHaveBeenCalled();
    expect(navigateByUrl).toHaveBeenCalledWith('/login');
  });

  it('keeps the session when only the PIN or Face ID was wrong', async () => {
    await respond('/api/app-lock/unlock/pin', 403);
    await respond('/api/app-lock/unlock/passkey', 403);
    expect(clear).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('leaves login errors to the login page', async () => {
    await respond('/api/auth/login', 401);
    expect(navigateByUrl).not.toHaveBeenCalled();
  });
});
