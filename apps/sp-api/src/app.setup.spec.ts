import express from 'express';
import request from 'supertest';
import {
  resolveTrustProxy,
  securityHeaders,
  staticCacheControl,
} from './app.setup';

function appWith(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(securityHeaders(env));
  app.get('/', (_req, res) => {
    res.send('ok');
  });
  return app;
}

describe('securityHeaders', () => {
  it('sends the standard headers, with the CSP report-only by default', async () => {
    const response = await request(appWith({})).get('/').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['content-security-policy']).toBeUndefined();
    const csp = response.headers['content-security-policy-report-only'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-hashes' 'sha256-");
    expect(csp).toContain("media-src 'self' blob:");
  });

  it('never sends HSTS or a resource policy that would block cast receivers', async () => {
    const response = await request(appWith({})).get('/').expect(200);

    expect(response.headers['strict-transport-security']).toBeUndefined();
    expect(response.headers['cross-origin-resource-policy']).toBeUndefined();
  });

  it('enforces the CSP, or drops it, when asked', async () => {
    const enforced = await request(
      appWith({ CONTENT_SECURITY_POLICY: 'enforce' }),
    ).get('/');
    expect(enforced.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(
      enforced.headers['content-security-policy-report-only'],
    ).toBeUndefined();

    const off = await request(appWith({ CONTENT_SECURITY_POLICY: 'off' })).get(
      '/',
    );
    expect(off.headers['content-security-policy']).toBeUndefined();
    expect(off.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('allows dashboards to embed Stashboard when ALLOW_EMBEDDING=true', async () => {
    const response = await request(appWith({ ALLOW_EMBEDDING: 'true' })).get(
      '/',
    );

    expect(response.headers['x-frame-options']).toBeUndefined();
    expect(
      response.headers['content-security-policy-report-only'],
    ).not.toContain('frame-ancestors');
  });

  it('allows exactly the stylesheet loader Angular inlines', () => {
    const { createHash } =
      jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const hash = createHash('sha256')
      .update("this.media='all'")
      .digest('base64');
    return request(appWith({}))
      .get('/')
      .expect((response) => {
        expect(
          response.headers['content-security-policy-report-only'],
        ).toContain(`'sha256-${hash}'`);
      });
  });
});

describe('resolveTrustProxy', () => {
  it('understands true, hop counts, lists, and off', () => {
    expect(resolveTrustProxy(undefined)).toBeUndefined();
    expect(resolveTrustProxy(' false ')).toBeUndefined();
    expect(resolveTrustProxy('TRUE')).toBe(true);
    expect(resolveTrustProxy('2')).toBe(2);
    expect(resolveTrustProxy('loopback, 172.16.0.0/12')).toBe(
      'loopback, 172.16.0.0/12',
    );
  });
});

describe('staticCacheControl', () => {
  it('keeps hashed bundles for good and checks everything else each time', () => {
    const forever = 'public, max-age=31536000, immutable';
    expect(staticCacheControl('/app/browser/main-WUR5SREH.js')).toBe(forever);
    expect(staticCacheControl('/app/browser/chunk-24RUGKQF.js')).toBe(forever);
    expect(staticCacheControl('/app/browser/styles-WNQN5DPV.css')).toBe(
      forever,
    );
    expect(
      staticCacheControl('/app/browser/media/primeicons-4GST5W3O.woff2'),
    ).toBe(forever);
    expect(staticCacheControl('/app/browser/index.html')).toBe('no-cache');
    expect(staticCacheControl('/app/browser/manifest.webmanifest')).toBe(
      'no-cache',
    );
    expect(staticCacheControl('/app/browser/icons/icon-192.png')).toBe(
      'no-cache',
    );
  });
});
