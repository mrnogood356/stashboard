import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AboutApiService,
  AboutResponse,
  HealthResponse,
  UpdateCheckResponse,
} from '../../core/api/about.service';
import {
  SettingsAboutPageComponent,
  formatBytes,
  supportText,
  updateText,
} from './settings-about-page.component';

const about: AboutResponse = {
  build: {
    version: 'edge-abc1234',
    commit: 'abc1234def5678abc1234def5678abc1234def56',
    builtAt: '2026-10-20T12:00:00.000Z',
    repository: 'someone/stashboard',
  },
  recentErrors: [
    {
      at: '2026-10-21T08:00:00.000Z',
      level: 'error',
      source: 'server',
      context: 'IndexingService',
      message: 'Sync failed: Whisparr down',
    },
    {
      at: '2026-10-21T07:00:00.000Z',
      level: 'warn',
      source: 'app',
      context: 'WebApp',
      message: 'Image failed to load (browser /home)',
    },
  ],
};

const health: HealthResponse = {
  checkedAt: '2026-10-21T09:00:00.000Z',
  database: { ok: true, error: null },
  integrations: [
    {
      type: 'STASH',
      label: 'Stash',
      reachable: true,
      error: null,
      errorAt: null,
      lastOkAt: '2026-10-21T09:00:00.000Z',
    },
    {
      type: 'WHISPARR',
      label: 'Whisparr',
      reachable: false,
      error: 'ECONNREFUSED',
      errorAt: '2026-10-21T09:00:00.000Z',
      lastOkAt: null,
    },
  ],
  disks: [
    {
      label: 'Stashboard data',
      path: '/var/lib/stashboard',
      freeBytes: 50 * 1024 ** 3,
      totalBytes: 100 * 1024 ** 3,
      error: null,
    },
  ],
  jobs: [
    {
      id: 'indexing',
      label: 'Indexing',
      status: 'ok',
      lastRunAt: '2026-10-21T08:30:00.000Z',
      message: null,
    },
    {
      id: 'download-watch',
      label: 'Finished downloads watcher',
      status: 'off',
      lastRunAt: null,
      message: 'Finished downloads is off.',
    },
  ],
};

const behind: UpdateCheckResponse = {
  status: 'behind',
  behindBy: 3,
  reason: null,
  checkedAt: '2026-10-21T09:00:00.000Z',
};

describe('SettingsAboutPageComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  async function render(api: Partial<Record<keyof AboutApiService, unknown>>) {
    await TestBed.configureTestingModule({
      imports: [SettingsAboutPageComponent],
      providers: [provideRouter([]), { provide: AboutApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsAboutPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the version, commit, update status, health and recent errors', async () => {
    const { root } = await render({
      about: vi.fn().mockReturnValue(of(about)),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });
    const text = root.textContent ?? '';

    expect(text).toContain('About & health');
    expect(text).toContain('edge-abc1234');
    expect(text).toContain('abc1234');
    expect(text).toContain('3 newer changes on main.');
    expect(text).toContain('Whisparr');
    expect(text).toContain('ECONNREFUSED');
    expect(text).toContain('50 GB free of 100 GB');
    expect(text).toContain('Sync failed: Whisparr down');
    expect(text).toContain('1 thing needs a look');
    expect(root.querySelector('[data-status="fail"]')?.textContent).toContain('Whisparr');
  });

  it('shows the version before health and the update check have answered', async () => {
    const { root } = await render({
      about: vi.fn().mockReturnValue(of(about)),
      health: vi.fn().mockReturnValue(NEVER),
      update: vi.fn().mockReturnValue(NEVER),
    });
    const text = root.textContent ?? '';

    expect(text).toContain('edge-abc1234');
    expect(text).toContain('Checking for updates…');
    expect(text).toContain('Checking…');
  });

  it('fails soft: each part says it couldn’t be read', async () => {
    const { root } = await render({
      about: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      health: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
      update: vi.fn().mockReturnValue(throwError(() => new Error('down'))),
    });
    const text = root.textContent ?? '';

    expect(text).toContain('Couldn’t read the version right now.');
    expect(text).toContain('Couldn’t check health right now.');
    expect(text).toContain('Can’t check for updates.');
  });

  it('copies version, health and errors as plain text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // The clipboard API is only offered on secure pages.
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { fixture, root } = await render({
      about: vi.fn().mockReturnValue(of(about)),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });

    root.querySelector<HTMLButtonElement>('button.copy')!.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('Version: edge-abc1234');
    expect(copied).toContain('Commit: abc1234def5678abc1234def5678abc1234def56');
    expect(copied).toContain('- Whisparr: FAIL');
    expect(copied).toContain('ERROR [IndexingService] Sync failed: Whisparr down');
    expect(copied).toContain('WARN [app] Image failed to load');
    expect(root.textContent).toContain('Copied');
  });

  it('opens the bug report form with the version and details, minus addresses', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { root } = await render({
      about: vi.fn().mockReturnValue(
        of({
          ...about,
          recentErrors: [
            {
              at: '2026-10-30T10:00:00.000Z',
              level: 'error',
              source: 'server',
              context: 'WhisparrAdapter',
              message: 'connect ECONNREFUSED 192.168.1.20:6969',
            },
          ],
        }),
      ),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });

    root.querySelector<HTMLButtonElement>('[data-testid="report-problem"]')!.click();

    const url = new URL(open.mock.calls[0][0] as string);
    expect(url.pathname).toMatch(/\/issues\/new$/);
    expect(url.searchParams.get('version')).toBe('edge-abc1234');
    const details = url.searchParams.get('details') ?? '';
    expect(details).toContain('connect ECONNREFUSED [ip]');
    expect(details).not.toContain('192.168.1.20');
    open.mockRestore();
  });

  it('links to the setup check', async () => {
    const { root } = await render({
      about: vi.fn().mockReturnValue(of(about)),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });

    const link = Array.from(root.querySelectorAll('a')).find((a) =>
      a.textContent?.includes('setup check'),
    );
    expect(link?.getAttribute('href')).toBe('/settings/setup-check');
  });

  it('links to the full logs from recent errors', async () => {
    const { root } = await render({
      about: vi.fn().mockReturnValue(of(about)),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });

    expect(root.querySelector('a.logs-link')?.getAttribute('href')).toBe('/settings/logs');
  });

  it('links to the repository the image was built from, and none for a local build', async () => {
    const built = await render({
      about: vi.fn().mockReturnValue(of(about)),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });
    const links = [...built.root.querySelectorAll('.link-list a')].map((a) =>
      a.getAttribute('href'),
    );
    expect(links).toEqual([
      'https://github.com/someone/stashboard',
      'https://github.com/someone/stashboard#self-hosted-quick-start',
      'https://github.com/someone/stashboard/releases',
    ]);
    TestBed.resetTestingModule();

    const local = await render({
      about: vi.fn().mockReturnValue(of({ ...about, build: { ...about.build, repository: null } })),
      health: vi.fn().mockReturnValue(of(health)),
      update: vi.fn().mockReturnValue(of(behind)),
    });
    expect(local.root.querySelector('.link-list')).toBeNull();
  });
});

describe('About helpers', () => {
  it('says how the update check went', () => {
    expect(updateText(null)).toBe('Checking for updates…');
    expect(updateText({ ...behind, status: 'up-to-date', behindBy: null })).toBe(
      'Up to date with main.',
    );
    expect(updateText({ ...behind, behindBy: 1 })).toBe('1 newer change on main.');
    expect(updateText({ ...behind, status: 'unknown', behindBy: null })).toBe(
      'Can’t check for updates.',
    );
  });

  it('writes sizes for people', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
  });

  it('still copies something when nothing could be read', () => {
    const text = supportText(null, null, null);
    expect(text).toContain('Version: couldn’t be read');
    expect(text).toContain('- None');
  });
});
