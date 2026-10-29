import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';

@Injectable()
export class SessionCookieService {
  readonly cookieName = 'stashboard_session';
  /** "Keep me signed in": the cookie and the session last a month from the last visit. */
  readonly sessionTtlMs = 30 * 24 * 60 * 60 * 1000;
  /**
   * Not kept signed in: the cookie ends with the browser, and the session
   * ends after this long without a visit even if the browser stays open.
   */
  readonly shortSessionTtlMs = 12 * 60 * 60 * 1000;
  private readonly sessionSecret: string;
  /** true or false when SESSION_COOKIE_SECURE says so; unset follows the request. */
  private readonly secureCookie: boolean | null;

  constructor() {
    const configuredSecret = process.env.SESSION_SECRET?.trim();
    if (!configuredSecret && process.env.NODE_ENV !== 'test') {
      throw new Error('SESSION_SECRET is required');
    }

    this.sessionSecret = configuredSecret || 'test-session-secret';
    this.secureCookie = parseSecureSetting(process.env.SESSION_COOKIE_SECURE);
  }

  readSessionId(cookieHeader: string | undefined): string | null {
    const signedValue = this.readCookieValue(cookieHeader);
    if (!signedValue) {
      return null;
    }

    const separatorIndex = signedValue.lastIndexOf('.');
    if (separatorIndex <= 0) {
      return null;
    }

    const sessionId = signedValue.slice(0, separatorIndex);
    const signature = signedValue.slice(separatorIndex + 1);
    const expectedSignature = this.sign(sessionId);

    if (!constantTimeEquals(signature, expectedSignature)) {
      return null;
    }

    return sessionId;
  }

  sessionTtlFor(persistent: boolean): number {
    return persistent ? this.sessionTtlMs : this.shortSessionTtlMs;
  }

  /**
   * A persistent session's cookie expires with it; any other gets no expiry,
   * so the browser drops it when it closes.
   */
  setSessionCookie(
    response: Response,
    sessionId: string,
    expiresAt: Date,
    persistent = true,
  ): void {
    response.cookie(this.cookieName, `${sessionId}.${this.sign(sessionId)}`, {
      ...(persistent ? { expires: expiresAt } : {}),
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecure(response),
      path: '/',
    });
  }

  clearSessionCookie(response: Response): void {
    response.clearCookie(this.cookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecure(response),
      path: '/',
    });
  }

  /**
   * Unset: Secure whenever the visit came over HTTPS, directly or (with
   * TRUST_PROXY) through a reverse proxy that says so, so an HTTPS install
   * gets it without a setting and a plain-HTTP LAN install still signs in.
   */
  private isSecure(response: Response): boolean {
    return this.secureCookie ?? response.req?.secure === true;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.sessionSecret)
      .update(value)
      .digest('base64url');
  }

  private readCookieValue(cookieHeader: string | undefined): string | null {
    if (!cookieHeader) {
      return null;
    }

    for (const rawPart of cookieHeader.split(';')) {
      const part = rawPart.trim();
      if (!part.startsWith(`${this.cookieName}=`)) {
        continue;
      }

      const encodedValue = part.slice(this.cookieName.length + 1);
      try {
        return decodeURIComponent(encodedValue);
      } catch {
        return encodedValue;
      }
    }

    return null;
  }
}

function parseSecureSetting(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return null;
  }
  return normalized === '1' || normalized === 'true';
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
