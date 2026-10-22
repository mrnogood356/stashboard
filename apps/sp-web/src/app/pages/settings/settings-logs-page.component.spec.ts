import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LogEntry,
  LogFilesResponse,
  LogSettings,
  LogsApiService,
  LogsResponse,
} from '../../core/api/logs.service';
import {
  LIVE_INTERVAL_MS,
  SettingsLogsPageComponent,
  entryText,
  formatEntryTime,
} from './settings-logs-page.component';

function entry(id: number, overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id,
    at: '2026-10-22T01:36:04.123Z',
    level: 'info',
    source: 'server',
    context: 'IndexingService',
    message: `Entry ${id}`,
    stack: null,
    ...overrides,
  };
}

const settings: LogSettings = {
  level: 'info',
  fileEnabled: true,
  saved: false,
  envLevel: 'info',
  fileDirectory: '/var/lib/stashboard/logs',
  fileError: null,
};

const files: LogFilesResponse = {
  enabled: true,
  directory: '/var/lib/stashboard/logs',
  files: [
    { name: 'stashboard.txt', size: 2048, modifiedAt: '2026-10-22T01:00:00.000Z' },
    { name: 'stashboard.0.txt', size: 5 * 1024 * 1024, modifiedAt: '2026-10-21T01:00:00.000Z' },
  ],
};

function page(entries: LogEntry[], hasMore = false): LogsResponse {
  return { entries, hasMore, level: 'info', capacity: 5000 };
}

function fakeApi(overrides: Partial<Record<keyof LogsApiService, unknown>> = {}) {
  const api = {
    list: vi.fn().mockReturnValue(
      of(
        page([
          entry(3, {
            level: 'error',
            context: 'AcquisitionService',
            message: 'Grab failed',
            stack: 'Error: Grab failed\n    at grab (acquisition.ts:10:5)',
          }),
          entry(2, { level: 'warn', context: 'StashAdapter', message: 'Stash is slow' }),
          entry(1, { message: 'Synced 3 scenes' }),
        ]),
      ),
    ),
    contexts: vi.fn().mockReturnValue(of(['AcquisitionService', 'IndexingService'])),
    clear: vi.fn().mockReturnValue(of(undefined)),
    files: vi.fn().mockReturnValue(of(files)),
    fileUrl: (name: string) => `/api/logs/files/${name}`,
    settings: vi.fn().mockReturnValue(of(settings)),
    saveSettings: vi
      .fn()
      .mockImplementation((body: Partial<LogSettings>) =>
        of({ ...settings, ...body, saved: true }),
      ),
  };
  return Object.assign(api, overrides) as typeof api;
}

describe('SettingsLogsPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function render(api = fakeApi()) {
    await TestBed.configureTestingModule({
      imports: [SettingsLogsPageComponent],
      providers: [{ provide: LogsApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsLogsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, api, root: fixture.nativeElement as HTMLElement };
  }

  it('shows entries newest first with their level, component and message', async () => {
    const { root } = await render();
    const rows = Array.from(root.querySelectorAll('.entry'));

    expect(rows.map((row) => row.getAttribute('data-level'))).toEqual(['error', 'warn', 'info']);
    expect(rows[0].textContent).toContain('Error');
    expect(rows[0].textContent).toContain('AcquisitionService');
    expect(rows[0].textContent).toContain('Grab failed');
    expect(root.textContent).toContain('logging at info');
  });

  it('filters by minimum level, component and text', async () => {
    vi.useFakeTimers();
    const { fixture, api, root } = await render();

    const [levelSelect, contextSelect] = Array.from(
      root.querySelectorAll<HTMLSelectElement>('.filters select'),
    );
    levelSelect.value = 'warn';
    levelSelect.dispatchEvent(new Event('change'));
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'warn' }));

    fixture.detectChanges();
    expect(Array.from(contextSelect.options).map((option) => option.value)).toEqual([
      '',
      'AcquisitionService',
      'IndexingService',
    ]);
    contextSelect.value = 'IndexingService';
    contextSelect.dispatchEvent(new Event('change'));
    expect(api.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ level: 'warn', context: 'IndexingService' }),
    );

    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'slow';
    search.dispatchEvent(new Event('input'));
    const calls = api.list.mock.calls.length;
    vi.advanceTimersByTime(400);
    expect(api.list.mock.calls.length).toBe(calls + 1);
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'slow' }));
  });

  it('expands an entry to show its stack, and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { fixture, root } = await render();

    expect(root.querySelector('.stack')).toBeNull();
    root.querySelector<HTMLButtonElement>('.entry-main')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.stack')?.textContent).toContain('at grab (acquisition.ts:10:5)');

    root.querySelector<HTMLButtonElement>('.entry .copy')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(writeText.mock.calls[0][0]).toContain('ERROR [AcquisitionService] Grab failed');
    expect(writeText.mock.calls[0][0]).toContain('at grab');
    expect(root.querySelector('.entry .copy')?.textContent).toContain('Copied');
  });

  it('adds new entries live, and pauses while the tab is hidden', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const { fixture, root } = await render(api);
    api.list.mockReturnValue(
      of(page([entry(5, { message: 'Newest' }), entry(4, { message: 'Newer' }), entry(3)])),
    );

    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    fixture.detectChanges();
    const messages = Array.from(root.querySelectorAll('.entry .message')).map((el) =>
      el.textContent?.trim(),
    );
    expect(messages.slice(0, 3)).toEqual(['Newest', 'Newer', 'Grab failed']);
    expect(messages).toHaveLength(5);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const calls = api.list.mock.calls.length;
    vi.advanceTimersByTime(LIVE_INTERVAL_MS * 3);
    expect(api.list.mock.calls.length).toBe(calls);

    hidden.mockReturnValue(false);
    root.querySelector<HTMLButtonElement>('.pill.live')!.click();
    fixture.detectChanges();
    expect(root.querySelector('.pill.live')?.textContent).toContain('Paused');
    vi.advanceTimersByTime(LIVE_INTERVAL_MS * 3);
    expect(api.list.mock.calls.length).toBe(calls);
  });

  it('clears after asking once', async () => {
    const api = fakeApi();
    const { fixture, root } = await render(api);

    root.querySelector<HTMLButtonElement>('.pill.clear')!.click();
    fixture.detectChanges();
    expect(api.clear).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Clear the log?');

    api.list.mockReturnValue(of(page([])));
    root.querySelector<HTMLButtonElement>('.pill.clear')!.click();
    fixture.detectChanges();
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll('.entry')).toHaveLength(0);
    expect(root.textContent).toContain('Nothing logged yet.');
  });

  it('saves the log level and file logging at once', async () => {
    const api = fakeApi();
    const { fixture, root } = await render(api);
    expect(root.textContent).toContain('Set by LOG_LEVEL (info) until changed here.');

    const level = root.querySelector<HTMLSelectElement>('#log-level')!;
    level.value = 'debug';
    level.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(api.saveSettings).toHaveBeenLastCalledWith({ level: 'debug', fileEnabled: true });
    expect(root.textContent).toContain('Saved. Applied right away.');

    const files = root.querySelector<HTMLInputElement>('input[name="fileEnabled"]')!;
    files.checked = false;
    files.dispatchEvent(new Event('change'));
    expect(api.saveSettings).toHaveBeenLastCalledWith({ level: 'debug', fileEnabled: false });
  });

  it('says so when the settings couldn’t be saved', async () => {
    const api = fakeApi({
      saveSettings: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    const { fixture, root } = await render(api);
    const level = root.querySelector<HTMLSelectElement>('#log-level')!;
    level.value = 'trace';
    level.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(root.textContent).toContain('Couldn’t save the log settings.');
    expect(level.value).toBe('info');
  });

  it('lists log files with download links', async () => {
    const { root } = await render();
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('.file a'));

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/api/logs/files/stashboard.txt',
      '/api/logs/files/stashboard.0.txt',
    ]);
    expect(links[0].getAttribute('download')).toBe('stashboard.txt');
    expect(root.textContent).toContain('2.0 KB');
    expect(root.textContent).toContain('5.0 MB');
  });

  it('fails soft when the log can’t be read', async () => {
    const { root } = await render(
      fakeApi({
        list: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
        settings: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
        files: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      }),
    );
    const text = root.textContent ?? '';
    expect(text).toContain('Couldn’t read the log right now.');
    expect(text).toContain('Couldn’t read the log settings right now.');
    expect(text).toContain('Couldn’t list the log files right now.');
  });

  it('loads older entries', async () => {
    const api = fakeApi({
      list: vi.fn().mockReturnValue(of(page([entry(9), entry(8)], true))),
    });
    const { fixture, root } = await render(api);
    api.list.mockReturnValue(of(page([entry(7)], false)));

    root.querySelector<HTMLButtonElement>('.older')!.click();
    fixture.detectChanges();
    expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({ before: 8 }));
    expect(root.querySelectorAll('.entry')).toHaveLength(3);
    expect(root.querySelector('.older')).toBeNull();
  });
});

describe('Logs helpers', () => {
  it('writes an entry as a log line', () => {
    expect(entryText(entry(1, { level: 'warn', context: 'StashAdapter', message: 'Slow' }))).toBe(
      '2026-10-22T01:36:04.123Z WARN [StashAdapter] Slow',
    );
    expect(entryText(entry(1, { level: 'error', fatal: true, source: 'app', stack: 'at x' }))).toBe(
      '2026-10-22T01:36:04.123Z FATAL [app] Entry 1\nat x',
    );
  });

  it('shows the time to the millisecond, with the date when not today', () => {
    const at = new Date(2026, 9, 22, 14, 3, 22, 481);
    expect(formatEntryTime(at.toISOString(), new Date(2026, 9, 22, 18))).toMatch(/14:03:22\.481$/);
    expect(formatEntryTime(at.toISOString(), new Date(2026, 9, 23, 18))).toMatch(
      /Oct.*22.*14:03:22\.481$/,
    );
  });
});
