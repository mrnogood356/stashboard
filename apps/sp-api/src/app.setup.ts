import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import type { RequestHandler, Request, Response } from 'express';
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
  app.use(responseCompression());
  app.use(securityHeaders());
  app.use(refuseCrossSiteWrites());

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

/** Methods that only read; anything else changes something. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses a change (POST, PATCH, DELETE…) a browser sent from another
 * origin. The session cookie is SameSite=Lax, which keeps other websites
 * out, but every app on the same host (another port, as on Unraid) or a
 * sibling subdomain is the same "site" to a browser, so a page there could
 * otherwise post a hidden form here with your login.
 *
 * Browsers say where a request came from in Sec-Fetch-Site, but only over
 * HTTPS (or localhost). Over plain HTTP, the Origin they send with every
 * cross-origin POST is compared with the address the request was sent to;
 * X-Forwarded-Host counts too, for a reverse proxy that rewrites Host (a
 * form can't set that header). Requests with neither (Whisparr's webhook,
 * scripts) aren't affected.
 */
export function refuseCrossSiteWrites(): RequestHandler {
  return (req, res, next) => {
    if (READ_METHODS.has(req.method.toUpperCase()) || isOwnOrigin(req)) {
      next();
      return;
    }
    res.status(403).json({
      statusCode: 403,
      message: 'Refused a change sent from another site or app.',
    });
  };
}

function isOwnOrigin(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    return site === 'same-origin' || site === 'none';
  }
  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  const parsed = parseUrl(origin);
  const from = parsed && hostOf(parsed);
  if (!parsed || !from) {
    // "null" (a sandboxed frame, a file) or something unreadable.
    return false;
  }
  const forwarded = req.headers['x-forwarded-host'];
  const targets = [
    req.headers.host,
    ...(Array.isArray(forwarded) ? forwarded : [forwarded]).flatMap(
      (value) => value?.split(',') ?? [],
    ),
  ];
  // Read under the Origin's scheme, so a proxy's "host:443" still matches
  // https://host (and "host:80" matches http://host).
  return targets.some((target) => {
    const url = target && parseUrl(`${parsed.protocol}//${target.trim()}`);
    return !!url && hostOf(url) === from;
  });
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** "host:port", lower case, with the scheme's default port left out. */
function hostOf(url: URL): string | null {
  return url.hostname ? url.host.toLowerCase() : null;
}

/**
 * Pages, scripts and API answers go out gzipped: a quarter of the size or
 * less. Video and images are already compressed, and a byte range is sent as
 * is so seeking keeps working.
 */
export function responseCompression(): RequestHandler {
  return compression({
    filter: (req, res) => !req.headers.range && compression.filter(req, res),
  });
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
 * The Content-Security-Policy is enforced; CONTENT_SECURITY_POLICY=report-only
 * only reports what it would block, and "off" drops it.
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
            reportOnly: cspMode === 'report-only',
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
