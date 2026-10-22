import { Injectable, signal } from '@angular/core';
import { clearUserCaches } from '../cache/user-cache';
import { AuthStatusResponse } from './auth.types';

@Injectable({
  providedIn: 'root',
})
export class AuthStateStore {
  private readonly statusState = signal<AuthStatusResponse | null>(null);

  readonly status = this.statusState.asReadonly();

  sync(status: AuthStatusResponse): void {
    if (!status.authenticated) {
      clearUserCaches();
    }
    this.statusState.set(status);
  }

  /** Signed out or session expired: forget who it was and what they saw. */
  clear(): void {
    clearUserCaches();
    this.statusState.set(null);
  }
}
