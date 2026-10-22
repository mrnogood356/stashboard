import { RecentLogs } from './recent-logs';

describe('RecentLogs', () => {
  it('keeps only the newest entries, newest first', () => {
    const logs = new RecentLogs(3);
    for (const n of [1, 2, 3, 4, 5]) {
      logs.add('warn', `warning ${n}`, 'Test');
    }

    expect(logs.list().map((entry) => entry.message)).toEqual([
      'warning 5',
      'warning 4',
      'warning 3',
    ]);
  });

  it('marks errors the web app reported', () => {
    const logs = new RecentLogs();
    logs.add('error', 'Page broke (browser /home)', 'WebApp');
    logs.add('error', new Error('boom'), 'AutomationService');

    expect(logs.list()).toEqual([
      expect.objectContaining({
        source: 'server',
        context: 'AutomationService',
        message: 'Error: boom',
      }),
      expect.objectContaining({ source: 'app', level: 'error' }),
    ]);
  });

  it('shortens very long messages', () => {
    const logs = new RecentLogs();
    logs.add('warn', 'x'.repeat(5000));

    expect(logs.list()[0].message).toHaveLength(1001);
  });
});
