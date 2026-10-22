import type { Response } from 'express';
import { SessionCookieService } from './session-cookie.service';

describe('SessionCookieService', () => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalSecure = process.env.SESSION_COOKIE_SECURE;
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    restore('SESSION_SECRET', originalSecret);
    restore('SESSION_COOKIE_SECURE', originalSecure);
    restore('NODE_ENV', originalEnv);
  });

  function issue(service: SessionCookieService, sessionId: string): string {
    const cookie = jest.fn();
    service.setSessionCookie(
      { cookie } as unknown as Response,
      sessionId,
      new Date(Date.now() + 60_000),
    );
    const [name, value] = cookie.mock.calls[0] as [string, string];
    return `${name}=${encodeURIComponent(value)}`;
  }

  it('reads back the session id it signed', () => {
    process.env.SESSION_SECRET = 'secret-a';
    const service = new SessionCookieService();
    const header = `theme=dark; ${issue(service, 'session-1')}; other=1`;

    expect(service.readSessionId(header)).toBe('session-1');
  });

  it('rejects a changed session id, a forged or missing signature, and other secrets', () => {
    process.env.SESSION_SECRET = 'secret-a';
    const service = new SessionCookieService();
    const valid = decodeURIComponent(issue(service, 'session-1').split('=')[1]);
    const signature = valid.slice(valid.lastIndexOf('.') + 1);

    expect(
      service.readSessionId(`stashboard_session=session-2.${signature}`),
    ).toBeNull();
    expect(
      service.readSessionId('stashboard_session=session-1.not-the-signature'),
    ).toBeNull();
    expect(service.readSessionId('stashboard_session=session-1')).toBeNull();
    expect(service.readSessionId('stashboard_session=.abc')).toBeNull();

    process.env.SESSION_SECRET = 'secret-b';
    expect(
      new SessionCookieService().readSessionId(`stashboard_session=${valid}`),
    ).toBeNull();
  });

  it('ignores a missing header and look-alike cookie names', () => {
    process.env.SESSION_SECRET = 'secret-a';
    const service = new SessionCookieService();
    const cookie = issue(service, 'session-1');

    expect(service.readSessionId(undefined)).toBeNull();
    expect(service.readSessionId('')).toBeNull();
    expect(service.readSessionId(`x${cookie}`)).toBeNull();
  });

  it('sets an http-only, same-site cookie, secure only when configured', () => {
    process.env.SESSION_SECRET = 'secret-a';
    const cookie = jest.fn();
    const expires = new Date(Date.now() + 60_000);
    new SessionCookieService().setSessionCookie(
      { cookie } as unknown as Response,
      'session-1',
      expires,
    );
    expect(cookie).toHaveBeenCalledWith(
      'stashboard_session',
      expect.stringMatching(/^session-1\./),
      { expires, httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
    );

    process.env.SESSION_COOKIE_SECURE = 'true';
    const secureCookie = jest.fn();
    const clearCookie = jest.fn();
    const secure = new SessionCookieService();
    secure.setSessionCookie(
      { cookie: secureCookie } as unknown as Response,
      'session-1',
      expires,
    );
    secure.clearSessionCookie({ clearCookie } as unknown as Response);
    expect(secureCookie.mock.calls[0][2]).toMatchObject({ secure: true });
    expect(clearCookie).toHaveBeenCalledWith('stashboard_session', {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    });
  });

  it('gives a session not kept signed in a cookie that ends with the browser', () => {
    process.env.SESSION_SECRET = 'secret-a';
    const cookie = jest.fn();
    const service = new SessionCookieService();
    service.setSessionCookie(
      { cookie } as unknown as Response,
      'session-1',
      new Date(Date.now() + 60_000),
      false,
    );
    const options = cookie.mock.calls[0][2] as Record<string, unknown>;
    expect(options).not.toHaveProperty('expires');
    expect(options).not.toHaveProperty('maxAge');
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax' });
    expect(service.sessionTtlFor(false)).toBe(12 * 60 * 60 * 1000);
    expect(service.sessionTtlFor(true)).toBe(service.sessionTtlMs);
  });

  it('refuses to start without a secret outside tests', () => {
    delete process.env.SESSION_SECRET;
    process.env.NODE_ENV = 'production';
    expect(() => new SessionCookieService()).toThrow(/SESSION_SECRET/);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
