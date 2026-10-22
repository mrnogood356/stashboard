import {
  formatJson,
  formatText,
  formatTimestamp,
  type LogEntry,
} from './log-format';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    at: new Date(2026, 9, 22, 1, 36, 4, 123).toISOString(),
    level: 'info',
    source: 'server',
    context: 'IndexingService',
    message: 'Synced 12 scenes',
    stack: null,
    ...overrides,
  };
}

describe('log format', () => {
  it('writes the time like the *arr apps, to the millisecond', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6))).toBe(
      '2026-01-02 03:04:05.006',
    );
  });

  it('writes one readable line', () => {
    expect(formatText(entry())).toBe(
      '2026-10-22 01:36:04.123 INFO  [IndexingService] Synced 12 scenes',
    );
    expect(formatText(entry({ level: 'warn', context: null }))).toBe(
      '2026-10-22 01:36:04.123 WARN  Synced 12 scenes',
    );
    expect(formatText(entry({ level: 'error', fatal: true }))).toContain(
      ' FATAL [IndexingService] ',
    );
  });

  it('indents further lines and the stack, without repeating the message', () => {
    const text = formatText(
      entry({
        level: 'error',
        message: 'Sync failed',
        stack:
          'Error: Sync failed\n    at sync (indexing.ts:10:5)\n    at run (x.ts:1:1)',
      }),
    );
    expect(text.split('\n')).toEqual([
      '2026-10-22 01:36:04.123 ERROR [IndexingService] Sync failed',
      '    at sync (indexing.ts:10:5)',
      '    at run (x.ts:1:1)',
    ]);
    expect(formatText(entry({ message: 'one\ntwo' })).split('\n')[1]).toBe(
      '    two',
    );
  });

  it('colours only when asked', () => {
    expect(formatText(entry())).not.toContain('\x1b[');
    expect(formatText(entry(), true)).toContain('\x1b[32mINFO ');
  });

  it('writes JSON lines', () => {
    const line = formatJson(
      entry({ level: 'error', fatal: true, stack: 'Error: x\n  at y' }),
    );
    expect(JSON.parse(line)).toEqual({
      time: entry().at,
      level: 'fatal',
      context: 'IndexingService',
      message: 'Synced 12 scenes',
      stack: 'Error: x\n  at y',
    });
    expect(line).not.toContain('\n');
  });
});
