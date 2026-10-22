export interface RecentLogEntry {
  at: string;
  level: 'warn' | 'error';
  /** "app" for errors the web app sent to /api/client-log. */
  source: 'server' | 'app';
  context: string | null;
  message: string;
}

const KEPT = 20;
const MAX_MESSAGE = 1000;
/** The logger name client-log writes the web app's errors under. */
export const WEB_APP_CONTEXT = 'WebApp';

/**
 * The last few warnings and errors, kept in memory for About & health, so a
 * problem can be seen (and copied into a support message) without reading
 * docker logs. Lost on restart, which is fine: it's for what's happening now.
 * StashboardLogger adds every warning and error it writes.
 */
export class RecentLogs {
  private entries: RecentLogEntry[] = [];

  constructor(private readonly kept = KEPT) {}

  add(level: 'warn' | 'error', message: unknown, context?: string): void {
    const text = textOf(message);
    if (!text) {
      return;
    }
    this.entries.push({
      at: new Date().toISOString(),
      level,
      source: context === WEB_APP_CONTEXT ? 'app' : 'server',
      context: context || null,
      message:
        text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text,
    });
    if (this.entries.length > this.kept) {
      this.entries.splice(0, this.entries.length - this.kept);
    }
  }

  /** Newest first. */
  list(): RecentLogEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
  }
}

/** The one the app logs into. */
export const recentLogs = new RecentLogs();

function textOf(message: unknown): string {
  if (typeof message === 'string') {
    return message.trim();
  }
  if (message instanceof Error) {
    return `${message.name}: ${message.message}`;
  }
  try {
    return JSON.stringify(message) ?? '';
  } catch {
    return String(message);
  }
}
