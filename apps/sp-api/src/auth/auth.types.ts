import type { Request } from 'express';

export interface AuthenticatedAdmin {
  id: string;
  username: string;
  normalizedUsername: string;
  sessionVersion: number;
}

export interface RequestAuthContext {
  bootstrapRequired: boolean;
  authenticated: boolean;
  user: AuthenticatedAdmin | null;
  sessionId: string | null;
}

export interface AuthStatusResponse {
  bootstrapRequired: boolean;
  authenticated: boolean;
  username: string | null;
  /**
   * Signed out, and Face ID sign-in can work here: a passkey exists and the
   * site is on HTTPS with a domain name. Says nothing about whose passkey.
   */
  passkeySignIn: boolean;
  /** No admin yet, and the server's SETUP_CODE must be given to create one. */
  setupCodeRequired: boolean;
}

export type AuthenticatedRequest = Request & {
  authContext?: RequestAuthContext;
};
