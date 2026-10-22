import { passkeysCanWork, type PasskeyEnvironment } from './passkey-support';

const env = (
  hostname: string,
  protocol = 'https:',
  overrides: Partial<PasskeyEnvironment> = {},
): PasskeyEnvironment => ({
  isSecureContext: true,
  location: { hostname, protocol },
  PublicKeyCredential: function PublicKeyCredential() {},
  ...overrides,
});

describe('passkeysCanWork', () => {
  it('works on a secure page with a domain name', () => {
    expect(passkeysCanWork(env('stashboard.example.com'))).toBe(true);
    expect(passkeysCanWork(env('localhost', 'https:'))).toBe(true);
  });

  it('needs a secure page and WebAuthn in the browser', () => {
    expect(passkeysCanWork(env('stashboard.lan', 'http:', { isSecureContext: false }))).toBe(false);
    expect(
      passkeysCanWork(env('stashboard.example.com', 'https:', { PublicKeyCredential: undefined })),
    ).toBe(false);
    expect(passkeysCanWork(undefined)).toBe(false);
  });

  it('never works on an IP address, or on localhost without HTTPS', () => {
    expect(passkeysCanWork(env('192.168.1.50'))).toBe(false);
    expect(passkeysCanWork(env('[::1]'))).toBe(false);
    expect(passkeysCanWork(env('fe80::1'))).toBe(false);
    // Browsers count http://localhost as secure, but a phone can't reach it.
    expect(passkeysCanWork(env('localhost', 'http:'))).toBe(false);
    expect(passkeysCanWork(env('app.localhost', 'http:'))).toBe(false);
  });
});
