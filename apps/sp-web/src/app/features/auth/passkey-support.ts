import { InjectionToken } from '@angular/core';

/** The parts of `window` that decide whether passkeys can work. */
export interface PasskeyEnvironment {
  isSecureContext: boolean;
  location: { hostname: string; protocol: string };
  PublicKeyCredential?: unknown;
}

/**
 * Whether this browser could sign in with a passkey (Face ID, Touch ID) here.
 * WebAuthn needs a secure page and a domain name: an IP address never works,
 * and "localhost" is only offered over HTTPS, as a phone can't reach it.
 */
export function passkeysCanWork(
  env: PasskeyEnvironment | undefined = typeof window === 'undefined' ? undefined : window,
): boolean {
  if (!env?.isSecureContext || typeof env.PublicKeyCredential === 'undefined') {
    return false;
  }

  const hostname = env.location.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || isIpAddress(hostname)) {
    return false;
  }

  const isLocalhost = hostname === 'localhost' || hostname.endsWith('.localhost');
  return !isLocalhost || env.location.protocol === 'https:';
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

/** Checks passkey support; swapped out in tests, where jsdom has no WebAuthn. */
export const PASSKEY_SUPPORT = new InjectionToken<() => boolean>('PASSKEY_SUPPORT', {
  providedIn: 'root',
  factory: () => () => passkeysCanWork(),
});
