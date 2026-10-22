import { LogBuffer } from './log-buffer';
import type { LogEntry } from './log-format';
import type { StashboardLogLevel } from './log-levels';

let id = 0;
function entry(
  level: StashboardLogLevel,
  message: string,
  context: string | null = 'Test',
  stack: string | null = null,
): LogEntry {
  id += 1;
  return {
    id,
    at: new Date().toISOString(),
    level,
    source: 'server',
    context,
    message,
    stack,
  };
}

describe('LogBuffer', () => {
  it('keeps the newest entries once full, newest first', () => {
    const buffer = new LogBuffer(3);
    for (const n of [1, 2, 3, 4, 5]) {
      buffer.add(entry('info', `line ${n}`));
    }
    expect(buffer.size).toBe(3);
    expect(buffer.query().entries.map((e) => e.message)).toEqual([
      'line 5',
      'line 4',
      'line 3',
    ]);
  });

  it('filters by minimum level, context and text', () => {
    const buffer = new LogBuffer();
    buffer.add(entry('debug', 'GET /api/scenes 200', 'HTTP'));
    buffer.add(entry('info', 'Synced 3 scenes', 'IndexingService'));
    buffer.add(entry('warn', 'Stash is slow', 'StashAdapter'));
    buffer.add(
      entry('error', 'Sync failed', 'IndexingService', 'at Whisparr.fetch'),
    );

    const messages = (query: Parameters<LogBuffer['query']>[0]) =>
      buffer.query(query).entries.map((e) => e.message);

    expect(messages({ level: 'warn' })).toEqual([
      'Sync failed',
      'Stash is slow',
    ]);
    expect(messages({ level: 'info' })).toHaveLength(3);
    expect(messages({ context: 'indexingservice' })).toEqual([
      'Sync failed',
      'Synced 3 scenes',
    ]);
    expect(messages({ q: 'SLOW' })).toEqual(['Stash is slow']);
    expect(messages({ q: 'whisparr' })).toEqual(['Sync failed']);
    expect(messages({ level: 'error', context: 'HTTP' })).toEqual([]);
  });

  it('pages back with before and limit', () => {
    const buffer = new LogBuffer();
    const added = [1, 2, 3, 4, 5].map((n) => entry('info', `line ${n}`));
    added.forEach((e) => buffer.add(e));

    const first = buffer.query({ limit: 2 });
    expect(first.entries.map((e) => e.message)).toEqual(['line 5', 'line 4']);
    expect(first.hasMore).toBe(true);

    const next = buffer.query({ limit: 2, before: first.entries[1].id });
    expect(next.entries.map((e) => e.message)).toEqual(['line 3', 'line 2']);

    const last = buffer.query({ limit: 2, before: next.entries[1].id });
    expect(last.entries.map((e) => e.message)).toEqual(['line 1']);
    expect(last.hasMore).toBe(false);
  });

  it('lists contexts and clears', () => {
    const buffer = new LogBuffer();
    buffer.add(entry('info', 'a', 'Zeta'));
    buffer.add(entry('info', 'b', 'Alpha'));
    buffer.add(entry('info', 'c', null));
    buffer.add(entry('info', 'd', 'Alpha'));
    expect(buffer.contexts()).toEqual(['Alpha', 'Zeta']);

    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.query().entries).toEqual([]);
    buffer.add(entry('info', 'after'));
    expect(buffer.query().entries.map((e) => e.message)).toEqual(['after']);
  });
});
