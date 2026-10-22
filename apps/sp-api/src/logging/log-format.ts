import type { StashboardLogLevel } from './log-levels';

export interface LogEntry {
  /** Increases by one per entry since start; used to page back through the log. */
  id: number;
  /** ISO time. */
  at: string;
  level: StashboardLogLevel;
  /** Nest's "fatal": shown as an error, labelled FATAL. */
  fatal?: boolean;
  /** "app" for errors the web app sent to /api/client-log. */
  source: 'server' | 'app';
  context: string | null;
  message: string;
  /** Stack trace or other detail; errors only. */
  stack: string | null;
}

const LABEL: Record<StashboardLogLevel, string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  debug: 'DEBUG',
  trace: 'TRACE',
};

const COLOR: Record<StashboardLogLevel, string> = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[32m',
  debug: '\x1b[35m',
  trace: '\x1b[90m',
};
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const INDENT = '    ';

/** 2026-10-22 01:36:04.123, in the server's local time (TZ). */
export function formatTimestamp(at: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.` +
    pad(at.getMilliseconds(), 3)
  );
}

/**
 * One readable line, the way the *arr apps write theirs:
 * `2026-10-22 01:36:04.123 INFO  [Context] message`, with further lines of
 * the message and an error's stack indented beneath it.
 */
export function formatText(entry: LogEntry, color = false): string {
  const label = entry.fatal ? 'FATAL' : LABEL[entry.level];
  const time = formatTimestamp(new Date(entry.at));
  const context = entry.context ? `[${entry.context}] ` : '';
  const [first, ...rest] = entry.message.split('\n');
  const extra = [...rest, ...stackLines(entry)].map((line) => INDENT + line);

  if (!color) {
    return [`${time} ${label} ${context}${first}`, ...extra].join('\n');
  }
  const tint = COLOR[entry.level];
  const head =
    `${DIM}${time}${RESET} ${tint}${entry.fatal ? BOLD : ''}${label}${RESET} ` +
    `${context ? `${BOLD}${context}${RESET}` : ''}` +
    (entry.level === 'error' || entry.level === 'warn'
      ? `${tint}${first}${RESET}`
      : first);
  return [head, ...extra.map((line) => `${DIM}${line}${RESET}`)].join('\n');
}

/** One JSON object per line (LOG_FORMAT=json), for log collectors. */
export function formatJson(entry: LogEntry): string {
  return JSON.stringify({
    time: entry.at,
    level: entry.fatal ? 'fatal' : entry.level,
    context: entry.context,
    message: entry.message,
    ...(entry.stack ? { stack: entry.stack } : {}),
    ...(entry.source === 'app' ? { source: 'app' } : {}),
  });
}

function stackLines(entry: LogEntry): string[] {
  if (!entry.stack) {
    return [];
  }
  const lines = entry.stack.split('\n');
  // A stack starts by repeating "Error: message"; don't print it twice.
  if (lines[0]?.includes(entry.message.split('\n')[0]) && lines.length > 1) {
    lines.shift();
  }
  return lines.map((line) => line.trim()).filter(Boolean);
}
