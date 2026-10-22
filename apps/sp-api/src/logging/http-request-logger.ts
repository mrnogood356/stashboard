import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { redact } from './redact';

/** Requests slower than this are worth a warning. */
export const SLOW_REQUEST_MS = 3_000;

/**
 * Release searches wait on Prowlarr or Whisparr asking every indexer, so a
 * few seconds is normal there; only warn when one takes really long.
 */
export const SLOW_INDEXER_SEARCH_MS = 20_000;
const INDEXER_SEARCHES = [
  /^\/api\/downloads\/scenes\/[^/]+\/releases$/,
  /^\/api\/requests\/[^/]+\/releases$/,
];

/**
 * Polled all the time (About & health, the Logs page's live view, the
 * container healthcheck): logged at trace, not debug, unless they fail, so
 * they don't drown out everything else.
 */
const POLLED = [
  /^\/api\/about\/health$/,
  /^\/api\/logs$/,
  /^\/api\/v1\/status$/,
];

type RequestLogger = Pick<Logger, 'debug' | 'warn' | 'verbose'>;

/**
 * One line per API request: method, path (secrets in the query removed),
 * status, time taken and who asked. Debug normally; a warning for server
 * errors and slow requests. The web app's own files aren't logged.
 */
export function httpRequestLogger(
  logger: RequestLogger = new Logger('HTTP'),
  now: () => number = () => performance.now(),
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const url = request.originalUrl ?? request.url;
    const path = url.split('?')[0];
    if (!/^\/api(?:\/|$)/.test(path)) {
      next();
      return;
    }
    const started = now();
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) {
        return;
      }
      done = true;
      try {
        const ms = Math.round(now() - started);
        const status = aborted ? 'aborted' : String(response.statusCode);
        const line = `${request.method} ${redact(url)} ${status} ${ms}ms ${clientAddress(request)}`;
        if (!aborted && response.statusCode >= 500) {
          logger.warn(line);
        } else if (ms >= slowAfter(request.method, path)) {
          logger.warn(`${line} (slow)`);
        } else if (
          (request.method === 'GET' || request.method === 'HEAD') &&
          response.statusCode < 400 &&
          POLLED.some((pattern) => pattern.test(path))
        ) {
          logger.verbose(line);
        } else {
          logger.debug(line);
        }
      } catch {
        // Never let logging get in the way of a response.
      }
    };
    response.once('finish', () => finish(false));
    response.once('close', () => finish(!response.writableFinished));
    next();
  };
}

function slowAfter(method: string, path: string): number {
  return method === 'GET' &&
    INDEXER_SEARCHES.some((pattern) => pattern.test(path))
    ? SLOW_INDEXER_SEARCH_MS
    : SLOW_REQUEST_MS;
}

function clientAddress(request: Request): string {
  return request.ip ?? request.socket?.remoteAddress ?? '-';
}
