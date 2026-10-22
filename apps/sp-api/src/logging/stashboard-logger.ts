import type { LoggerService, LogLevel as NestLogLevel } from '@nestjs/common';
import { inspect } from 'node:util';
import { LogBuffer } from './log-buffer';
import { LogFileWriter, type LogFileWriterOptions } from './log-file-writer';
import { formatJson, formatText, type LogEntry } from './log-format';
import {
  DEFAULT_LOG_LEVEL,
  fromNestLevel,
  isLevelEnabled,
  type LogFormat,
  type StashboardLogLevel,
} from './log-levels';
import { recentLogs, RecentLogs, WEB_APP_CONTEXT } from './recent-logs';
import { redact } from './redact';

/**
 * Nest's start-up chatter ("Mapped {/api/…} route" for every route, each
 * module loaded…): moved below info so the console starts with what matters.
 */
const QUIET_CONTEXTS: Record<string, StashboardLogLevel> = {
  RoutesResolver: 'trace',
  RouterExplorer: 'trace',
  InstanceLoader: 'trace',
  NestFactory: 'debug',
  NestApplication: 'debug',
};

const MAX_TEXT = 16_000;

interface OutputStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

export interface StashboardLoggerOptions {
  level?: StashboardLogLevel;
  format?: LogFormat;
  /** Coloured console output; by default only when the stream is a terminal. */
  color?: boolean;
  /** False writes nothing to the console (tests). */
  console?: boolean;
  stdout?: OutputStream;
  stderr?: OutputStream;
  /** Folder for stashboard.txt; null writes no files. */
  fileDirectory?: string | null;
  fileEnabled?: boolean;
  fileOptions?: Omit<LogFileWriterOptions, 'onError'>;
  buffer?: LogBuffer;
  recent?: RecentLogs;
}

/**
 * Stashboard's logger, used for everything written through Nest's Logger
 * (`new Logger('Context').log(…)`). Each entry at the current level or above
 * is cleaned of secrets, then:
 * - written to the console as a readable line (or JSON with LOG_FORMAT=json),
 * - appended to APP_DATA_DIR/logs/stashboard.txt (rotated, like the *arr apps),
 * - kept in memory for Settings → Logs, and warnings and errors also for
 *   About & health.
 * The level and the files can be changed while running.
 */
export class StashboardLogger implements LoggerService {
  level: StashboardLogLevel = DEFAULT_LOG_LEVEL;
  format: LogFormat = 'text';
  buffer: LogBuffer;
  recent: RecentLogs;
  private consoleEnabled = true;
  private color: boolean | undefined;
  private stdout: OutputStream = process.stdout;
  private stderr: OutputStream = process.stderr;
  private fileDirectory: string | null = null;
  private fileEnabled = false;
  private fileOptions: Omit<LogFileWriterOptions, 'onError'> = {};
  private file: LogFileWriter | null = null;
  private nextId = 1;
  private exitHook = false;

  constructor(options: StashboardLoggerOptions = {}) {
    this.buffer = options.buffer ?? new LogBuffer();
    this.recent = options.recent ?? recentLogs;
    this.configure(options);
  }

  configure(options: StashboardLoggerOptions): void {
    if (options.level) {
      this.level = options.level;
    }
    if (options.format) {
      this.format = options.format;
    }
    if (options.console !== undefined) {
      this.consoleEnabled = options.console;
    }
    if (options.color !== undefined) {
      this.color = options.color;
    }
    this.stdout = options.stdout ?? this.stdout;
    this.stderr = options.stderr ?? this.stderr;
    if (options.fileOptions) {
      this.fileOptions = options.fileOptions;
    }
    if (options.fileDirectory !== undefined) {
      this.fileDirectory = options.fileDirectory;
      void this.closeFile();
    }
    if (options.fileEnabled !== undefined) {
      this.fileEnabled = options.fileEnabled;
    }
    this.openFile();
  }

  setLevel(level: StashboardLogLevel): void {
    this.level = level;
  }

  /** Turns the log files on or off; turning them on again retries a folder that failed. */
  setFileEnabled(enabled: boolean): void {
    if (enabled && this.file?.failure) {
      this.file = null;
    }
    this.fileEnabled = enabled;
    if (!enabled) {
      void this.closeFile();
    }
    this.openFile();
  }

  get filesEnabled(): boolean {
    return this.fileEnabled;
  }

  get logDirectory(): string | null {
    return this.fileDirectory;
  }

  /** The file being written to, or null when there isn't one. */
  get filePath(): string | null {
    return this.file && !this.file.failure ? this.file.path : null;
  }

  get fileError(): string | null {
    return this.file?.failure ?? null;
  }

  /** The writer for listing files, whether or not writing is on. */
  files(): LogFileWriter | null {
    return (
      this.file ??
      (this.fileDirectory ? new LogFileWriter(this.fileDirectory) : null)
    );
  }

  /** Opens the log file now, so a folder that can't be written is reported at start-up. */
  async prepareFiles(timeoutMs = 2_000): Promise<void> {
    if (!this.file) {
      return;
    }
    // A hung network mount must not hold up start-up.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.file.ready(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  async flush(): Promise<void> {
    await this.file?.flush();
  }

  // ---------- Nest's LoggerService ----------

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params, true);
  }

  /** Nest's way of setting levels: the most detailed one given wins. */
  setLogLevels(levels: NestLogLevel[]): void {
    const order: StashboardLogLevel[] = ['trace', 'debug', 'info', 'warn'];
    const mapped = levels.map(fromNestLevel);
    this.level = order.find((level) => mapped.includes(level)) ?? 'error';
  }

  // ---------- writing ----------

  private write(
    level: StashboardLogLevel,
    message: unknown,
    params: unknown[],
    fatal = false,
  ): void {
    try {
      const parsed = parseArguments(level, message, params);
      const effective =
        level === 'info' && parsed.context
          ? (QUIET_CONTEXTS[parsed.context] ?? level)
          : level;
      if (!isLevelEnabled(effective, this.level)) {
        return;
      }
      this.emit({
        id: this.nextId++,
        at: new Date().toISOString(),
        level: effective,
        ...(fatal ? { fatal: true } : {}),
        source: parsed.context === WEB_APP_CONTEXT ? 'app' : 'server',
        context: parsed.context,
        message: clip(redact(parsed.message)),
        stack: parsed.stack ? clip(redact(parsed.stack)) : null,
      });
    } catch {
      // Logging must never break what's being logged.
    }
  }

  private emit(entry: LogEntry): void {
    this.buffer.add(entry);
    if (entry.level === 'warn' || entry.level === 'error') {
      this.recent.add(entry.level, entry.message, entry.context ?? undefined);
    }
    if (this.consoleEnabled) {
      const stream = entry.level === 'error' ? this.stderr : this.stdout;
      const color =
        this.color ?? (stream.isTTY === true && !process.env.NO_COLOR);
      stream.write(
        `${this.format === 'json' ? formatJson(entry) : formatText(entry, color)}\n`,
      );
    }
    this.file?.write(formatText(entry));
  }

  private openFile(): void {
    if (!this.fileEnabled || !this.fileDirectory || this.file) {
      return;
    }
    this.file = new LogFileWriter(this.fileDirectory, {
      ...this.fileOptions,
      onError: (problem) => this.warn(problem, 'Logging'),
    });
    void this.file.ready();
    if (!this.exitHook) {
      this.exitHook = true;
      process.once('exit', () => this.file?.flushSync());
    }
  }

  private async closeFile(): Promise<void> {
    const file = this.file;
    this.file = null;
    await file?.flush();
  }
}

/** The logger the app runs with; main.ts configures it from the environment. */
export const appLogger = new StashboardLogger();

interface ParsedArguments {
  message: string;
  context: string | null;
  stack: string | null;
}

/**
 * Nest's calling conventions: the last string is the context (a Logger made
 * with `new Logger('Context')` always adds it), and for errors the string
 * before it is the stack. Errors passed anywhere bring their stack along.
 */
export function parseArguments(
  level: StashboardLogLevel,
  message: unknown,
  params: unknown[],
): ParsedArguments {
  const rest = [...params];
  let context: string | null = null;
  let stack: string | null = null;
  if (
    level === 'error' &&
    rest.length === 1 &&
    typeof rest[0] === 'string' &&
    looksLikeStack(rest[0])
  ) {
    stack = rest.pop() as string;
  } else if (rest.length > 0 && typeof rest[rest.length - 1] === 'string') {
    context = (rest.pop() as string) || null;
  }

  const parts: string[] = [];
  const main = describe(message);
  if (main.text) {
    parts.push(main.text);
  }
  stack ??= main.stack;
  for (const param of rest) {
    if (param === undefined || param === null) {
      continue;
    }
    if (param instanceof Error) {
      stack ??= param.stack ?? null;
      if (!parts.some((part) => part.includes(param.message))) {
        parts.push(param.message);
      }
      continue;
    }
    if (level === 'error' && typeof param === 'string' && stack === null) {
      stack = param;
      continue;
    }
    const text = describe(param).text;
    if (text) {
      parts.push(text);
    }
  }
  return {
    message: parts.join(': '),
    context,
    stack: level === 'error' && stack?.trim() ? stack : null,
  };
}

function describe(value: unknown): { text: string; stack: string | null } {
  if (typeof value === 'string') {
    return { text: value, stack: null };
  }
  if (value instanceof Error) {
    return {
      text: value.message || value.name,
      stack: value.stack ?? null,
    };
  }
  if (value === undefined || value === null) {
    return { text: '', stack: null };
  }
  if (typeof value === 'object') {
    try {
      return { text: JSON.stringify(value), stack: null };
    } catch {
      return { text: inspect(value, { depth: 3 }), stack: null };
    }
  }
  if (typeof value === 'function') {
    return { text: `[function ${value.name || 'anonymous'}]`, stack: null };
  }
  // Numbers, booleans, bigints, symbols.
  return { text: inspect(value), stack: null };
}

function looksLikeStack(text: string): boolean {
  return /\n\s+at .+/.test(text);
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}
