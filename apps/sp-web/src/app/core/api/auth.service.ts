import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom, tap, timeout } from 'rxjs';
import { AuthStateStore } from './auth-state.store';
import {
  type AuthStatusResponse,
  type BootstrapAdminPayload,
  type ChangePasswordPayload,
  type LoginPayload,
} from './auth.types';

/** How long a page waits for the server to say who's signed in. */
const STATUS_TIMEOUT_MS = 20_000;

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly authStateStore = inject(AuthStateStore);

  readonly status = this.authStateStore.status;

  refreshStatus(): Observable<AuthStatusResponse> {
    // Every page waits on this: a server that never answers (its database
    // stuck, say) shows the "can't reach" page instead of a blank screen.
    return this.http.get<AuthStatusResponse>('/api/auth/status').pipe(
      timeout(STATUS_TIMEOUT_MS),
      tap((status) => this.authStateStore.sync(status)),
    );
  }

  bootstrap(payload: BootstrapAdminPayload): Observable<AuthStatusResponse> {
    return this.http
      .post<AuthStatusResponse>('/api/auth/bootstrap', payload)
      .pipe(tap((status) => this.authStateStore.sync(status)));
  }

  login(payload: LoginPayload): Observable<AuthStatusResponse> {
    return this.http
      .post<AuthStatusResponse>('/api/auth/login', payload)
      .pipe(tap((status) => this.authStateStore.sync(status)));
  }

  /**
   * Signs in with Face ID / Touch ID, using a passkey added for App Lock.
   * Rejects with the browser's error when the person cancels.
   */
  async loginWithPasskey(rememberMe: boolean): Promise<AuthStatusResponse> {
    const { startAuthentication } = await import('@simplewebauthn/browser');
    const optionsJSON = await firstValueFrom(
      this.http.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        '/api/auth/login/passkey/options',
        {},
      ),
    );
    const response = await startAuthentication({ optionsJSON });
    const status = await firstValueFrom(
      this.http.post<AuthStatusResponse>('/api/auth/login/passkey', { response, rememberMe }),
    );
    this.authStateStore.sync(status);
    return status;
  }

  logout(): Observable<AuthStatusResponse> {
    return this.http
      .post<AuthStatusResponse>('/api/auth/logout', {})
      .pipe(tap((status) => this.authStateStore.sync(status)));
  }

  changePassword(payload: ChangePasswordPayload): Observable<void> {
    return this.http.post<void>('/api/auth/change-password', payload);
  }

  clearStatus(): void {
    this.authStateStore.clear();
  }
}
