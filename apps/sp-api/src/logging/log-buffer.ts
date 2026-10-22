import type { LogEntry } from './log-format';
import { isLevelEnabled, type StashboardLogLevel } from './log-levels';

export const LOG_BUFFER_CAPACITY = 5000;

export interface LogQuery {
  /** Minimum level: "warn" gives warnings and errors. */
  level?: StashboardLogLevel;
  context?: string;
  /** Text in the message, context or stack (any case). */
  q?: string;
  /** Only entries older than this id, for paging back. */
  before?: number;
  limit?: number;
}

export interface LogQueryResult {
  /** Newest first. */
  entries: LogEntry[];
  /** More matching entries are older than the last one returned. */
  hasMore: boolean;
}

/**
 * The newest log entries, kept in memory for Settings → Logs. A fixed-size
 * ring, so the oldest entry makes way for each new one once it's full.
 */
export class LogBuffer {
  private readonly slots: Array<LogEntry | undefined>;
  /** Where the next entry goes. */
  private next = 0;
  private count = 0;

  constructor(readonly capacity = LOG_BUFFER_CAPACITY) {
    this.slots = new Array<LogEntry | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  add(entry: LogEntry): void {
    this.slots[this.next] = entry;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  query(query: LogQuery = {}): LogQueryResult {
    const limit = Math.max(1, query.limit ?? 200);
    const context = query.context?.trim().toLowerCase() || null;
    const text = query.q?.trim().toLowerCase() || null;
    const entries: LogEntry[] = [];
    let hasMore = false;
    for (const entry of this.newestFirst()) {
      if (query.before !== undefined && entry.id >= query.before) {
        continue;
      }
      if (query.level && !isLevelEnabled(entry.level, query.level)) {
        continue;
      }
      if (context && entry.context?.toLowerCase() !== context) {
        continue;
      }
      if (text && !matches(entry, text)) {
        continue;
      }
      if (entries.length === limit) {
        hasMore = true;
        break;
      }
      entries.push(entry);
    }
    return { entries, hasMore };
  }

  /** Every context in the buffer, sorted. */
  contexts(): string[] {
    const names = new Set<string>();
    for (const entry of this.newestFirst()) {
      if (entry.context) {
        names.add(entry.context);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  clear(): void {
    this.slots.fill(undefined);
    this.next = 0;
    this.count = 0;
  }

  private *newestFirst(): Generator<LogEntry> {
    for (let offset = 1; offset <= this.count; offset += 1) {
      const entry =
        this.slots[(this.next - offset + this.capacity) % this.capacity];
      if (entry) {
        yield entry;
      }
    }
  }
}

function matches(entry: LogEntry, text: string): boolean {
  return (
    entry.message.toLowerCase().includes(text) ||
    (entry.context?.toLowerCase().includes(text) ?? false) ||
    (entry.stack?.toLowerCase().includes(text) ?? false)
  );
}
