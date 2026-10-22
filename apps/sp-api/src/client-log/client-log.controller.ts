import { Body, Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { AllowWhenLocked } from '../auth/decorators/allow-when-locked.decorator';

export class ClientLogDto {
  @IsOptional()
  @IsIn(['error', 'warn', 'info'])
  level?: 'error' | 'warn' | 'info';

  @IsString()
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  detail?: string;

  /** The page it happened on. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  page?: string;
}

/** Entries a minute per client, so a page stuck in an error loop can't flood the log. */
const PER_MINUTE = 30;
const WINDOW_MS = 60_000;
/** Clients tracked at once; ones whose minute is over are dropped first. */
const MAX_CLIENTS = 1000;

interface ClientWindow {
  start: number;
  count: number;
}

// C0 and C1 control characters, plus the Unicode line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029/;

/**
 * Makes client text safe to put on one log line: line breaks and other
 * control characters are written escaped, so a message can't start what
 * looks like a separate server log entry.
 */
export function escapeLogText(text: string): string {
  return text.replace(CONTROL_CHARS, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}

/**
 * Keeps a multi-line detail (a stack trace) readable, but indents every
 * line and escapes any other control characters, so no line of it can pass
 * for a server log entry.
 */
export function indentLogDetail(detail: string): string {
  return detail
    .split(LINE_BREAKS)
    .map((line) => `    ${escapeLogText(line)}`)
    .join('\n');
}

/**
 * Errors from the web app, written to Stashboard's own log (docker logs), so
 * problems in the app installed on a phone, which has no console to look
 * at, can still be seen.
 */
@Controller('api/client-log')
export class ClientLogController {
  private readonly logger = new Logger('WebApp');
  /** Each client's (address's) current minute, so one noisy client can't silence the rest. */
  private readonly windows = new Map<string, ClientWindow>();

  @Post()
  @HttpCode(204)
  // Errors around unlocking matter most; log them while locked too.
  @AllowWhenLocked()
  log(@Body() body: ClientLogDto, @Req() request: Request): void {
    // Express applies trust-proxy rules to request.ip when configured.
    const client = request.ip || request.socket?.remoteAddress || 'unknown';
    if (!this.allow(client)) {
      return;
    }
    const where = [
      request.headers['x-stashboard-app'] === 'phone' ? 'phone app' : 'browser',
      body.page,
    ]
      .filter(Boolean)
      .join(' ');
    const summary = escapeLogText(`${body.message} (${where})`);
    const line = body.detail
      ? `${summary}\n${indentLogDetail(body.detail)}`
      : summary;
    if (body.level === 'info') {
      this.logger.log(line);
    } else if (body.level === 'warn') {
      this.logger.warn(line);
    } else {
      this.logger.error(line);
    }
  }

  /** Counts an entry for this client; false once it is over its limit. */
  private allow(client: string): boolean {
    const now = Date.now();
    let window = this.windows.get(client);
    if (!window || now - window.start > WINDOW_MS) {
      if (!window && this.windows.size >= MAX_CLIENTS) {
        this.sweep(now);
        if (this.windows.size >= MAX_CLIENTS) {
          return false;
        }
      }
      window = { start: now, count: 0 };
      this.windows.set(client, window);
    }
    window.count += 1;
    if (window.count > PER_MINUTE) {
      if (window.count === PER_MINUTE + 1) {
        this.logger.warn(
          `Too many errors from the app at ${escapeLogText(client)}; skipping the rest for a minute.`,
        );
      }
      return false;
    }
    return true;
  }

  private sweep(now: number): void {
    for (const [client, window] of this.windows) {
      if (now - window.start > WINDOW_MS) {
        this.windows.delete(client);
      }
    }
  }
}
