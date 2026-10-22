import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import helmet from 'helmet';
import { httpRequestLogger } from './logging/http-request-logger';
import {
  CATALOG_PROVIDER_HEADER,
  parseRequestedCatalogProvider,
  runWithRequestedCatalogProvider,
} from './providers/catalog/catalog-provider-context';

/**
 * Request handling shared by the server and the end-to-end tests, so the tests
 * exercise the same validation and middleware as production.
 */
export function configureApp(app: NestExpressApplication): void {
  const trustProxy = resolveTrustProxy(process.env.TRUST_PROXY);
  if (trustProxy !== undefined) {
    // Behind a reverse proxy every request otherwise appears to come from the
    // proxy, so login throttling would lock everyone out together.
    app.set('trust proxy', trustProxy);
    new Logger('Bootstrap').log(
      `Trusting reverse proxy headers (TRUST_PROXY=${process.env.TRUST_PROXY})`,
    );
  }

  // One debug line per API request; a warning when it fails or is slow.
  app.use(httpRequestLogger());
  app.use(securityHeaders());

  // Lets browse pages pick a secondary catalog provider per request.
  app.use((req: Request, _res: Response, next: () => void) => {
    runWithRequestedCatalogProvider(
      parseRequestedCatalogProvider(req.headers[CATALOG_PROVIDER_HEADER]),
      next,
    );
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}

/**
 * Angular's critical-CSS inlining loads the stylesheet with this inline
 * handler; the policy allows exactly it by hash.
 */
const STYLESHEET_ONLOAD_HASH =
  "'sha256-MhtPZXr7+LpJUY5qtMutB+qWfQtMaPccfe7QXtCcEYc='";

/**
 * Standard security headers. Left out on purpose:
 * - HSTS: many installs are plain HTTP on the LAN; HTTPS is the reverse proxy's job.
 * - Cross-Origin-Resource-Policy: TVs and cast receivers play streams cross-origin.
 * - X-Frame-Options when ALLOW_EMBEDDING=true, for dashboards (Organizr,
 *   Homarr…) that show Stashboard in an iframe.
 * The Content-Security-Policy is report-only unless CONTENT_SECURITY_POLICY=enforce
 * ("off" drops it), so a source it missed is reported, not broken.
 */
export function securityHeaders(env: NodeJS.ProcessEnv = process.env) {
  const cspMode = (env.CONTENT_SECURITY_POLICY ?? '').trim().toLowerCase();
  const allowEmbedding = env.ALLOW_EMBEDDING?.trim().toLowerCase() === 'true';

  return helmet({
    strictTransportSecurity: false,
    // Cast receivers (Chromecast) load the stream from another origin.
    crossOriginResourcePolicy: false,
    xFrameOptions: allowEmbedding ? false : { action: 'sameorigin' },
    contentSecurityPolicy:
      cspMode === 'off'
        ? false
        : {
            reportOnly: cspMode !== 'enforce',
            useDefaults: false,
            directives: {
              defaultSrc: ["'self'"],
              baseUri: ["'self'"],
              objectSrc: ["'none'"],
              formAction: ["'self'"],
              ...(allowEmbedding ? {} : { frameAncestors: ["'self'"] }),
              scriptSrc: ["'self'", "'unsafe-hashes'", STYLESHEET_ONLOAD_HASH],
              // Angular and PrimeNG set inline styles.
              styleSrc: ["'self'", "'unsafe-inline'"],
              // Catalog (StashDB/FansDB) artwork loads straight from their CDNs.
              imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
              // hls.js plays through blob: URLs.
              mediaSrc: ["'self'", 'blob:'],
              workerSrc: ["'self'", 'blob:'],
              connectSrc: ["'self'"],
              fontSrc: ["'self'", 'data:'],
              manifestSrc: ["'self'"],
            },
          },
  });
}

/**
 * TRUST_PROXY accepts "true" (trust all), a hop count like "1", or an Express
 * trust-proxy list such as "loopback, 172.16.0.0/12". Unset or "false" keeps the
 * default of trusting nothing.
 */
export function resolveTrustProxy(
  value: string | undefined,
): boolean | number | string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'false') {
    return undefined;
  }
  if (trimmed.toLowerCase() === 'true') {
    return true;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

/**
 * Cache-Control for the built frontend. Bundles carry a content hash in their
 * name (main-WUR5SREH.js, media/primeicons-4GST5W3O.woff2), so a new release
 * gets new names and the old ones can be kept for good. Everything else
 * (index.html, the manifest, icons) is checked again on every load.
 */
export function staticCacheControl(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  return /-[A-Z0-9]{8}\.[a-z0-9]+$/.test(name)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}
