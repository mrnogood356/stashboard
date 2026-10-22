import { ErrorHandler, Injectable } from '@angular/core';

type Level = 'error' | 'warn' | 'info';

/** At most this many entries a page load, and the same one not again within a minute. */
const MAX_PER_LOAD = 25;
const REPEAT_MS = 60_000;
let sent = 0;
const lastSent = new Map<string, number>();

/**
 * Writes to Stashboard's own log (docker logs) from the web app, so problems in
 * the app installed on a phone, which has no console, can still be seen.
 * Uses fetch directly, never the app's HTTP client, so a broken page or a
 * locked app can't stop it or loop on it. Never throws.
 */
export function reportToServer(level: Level, message: string, error?: unknown): void {
  try {
    console[level === 'info' ? 'log' : level](message, error ?? '');
    const text = message.slice(0, 2000);
    const now = Date.now();
    if (sent >= MAX_PER_LOAD || now - (lastSent.get(text) ?? -Infinity) < REPEAT_MS) {
      return;
    }
    sent += 1;
    lastSent.set(text, now);
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    void fetch('/api/client-log', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(standalone ? { 'X-Stashboard-App': 'phone' } : {}),
      },
      body: JSON.stringify({
        level,
        message: text,
        detail: describe(error)?.slice(0, 8000),
        page: window.location.pathname.slice(0, 500),
      }),
    }).catch(() => undefined);
  } catch {
    // Logging must never break the app.
  }
}

function describe(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }
  if (typeof error === 'object') {
    const value = error as { status?: unknown; message?: unknown; url?: unknown };
    if (value.status !== undefined) {
      return `HTTP ${String(value.status)} ${String(value.url ?? '')} ${String(value.message ?? '')}`.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Every uncaught error in the app also goes to the server log. */
@Injectable()
export class ReportingErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    super.handleError(error);
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : 'Unexpected error in the app';
    reportToServer('error', message, error);
  }
}
