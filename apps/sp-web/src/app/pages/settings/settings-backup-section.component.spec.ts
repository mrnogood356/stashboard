import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupApiService } from '../../core/api/backup.service';
import { SettingsBackupSectionComponent } from './settings-backup-section.component';

const BACKUP = {
  format: 'stashboard-settings',
  formatVersion: 1,
  appVersion: '1.3.0',
  exportedAt: '2026-10-30T12:00:00.000Z',
  includesSecrets: true,
  settings: { playback: { enabled: true } },
};

describe('SettingsBackupSectionComponent', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  async function render(api: Partial<Record<keyof BackupApiService, unknown>>) {
    await TestBed.configureTestingModule({
      imports: [SettingsBackupSectionComponent],
      providers: [{ provide: BackupApiService, useValue: api }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsBackupSectionComponent);
    fixture.detectChanges();
    return fixture;
  }

  async function pick(
    fixture: Awaited<ReturnType<typeof render>>,
    contents: string,
  ): Promise<void> {
    const input = fixture.nativeElement.querySelector(
      '[data-testid="backup-file"]',
    ) as HTMLInputElement;
    const file = new File([contents], 'stashboard-settings-2026-10-30.json', {
      type: 'application/json',
    });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('downloads the backup, with keys unless they’re turned off', async () => {
    const download = vi
      .fn()
      .mockReturnValue(of({ blob: new Blob(['{}']), fileName: 'backup.json' }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const fixture = await render({ download });
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('[data-testid="download-backup"]') as HTMLButtonElement).click();
    expect(download).toHaveBeenLastCalledWith(true);
    expect(click).toHaveBeenCalled();

    const keys = root.querySelector('input[role="switch"]') as HTMLInputElement;
    keys.checked = false;
    keys.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(root.textContent).not.toContain('Keep the file somewhere private');
    (root.querySelector('[data-testid="download-backup"]') as HTMLButtonElement).click();
    expect(download).toHaveBeenLastCalledWith(false);
  });

  it('shows what a picked file is, then restores it and lists each part', async () => {
    const restore = vi.fn().mockReturnValue(
      of({
        results: [
          { id: 'integration-STASH', label: 'Stash', status: 'restored', message: null },
          {
            id: 'downloads',
            label: 'Finished downloads',
            status: 'failed',
            message: 'Pick a folder inside one of Stash’s library folders.',
          },
        ],
      }),
    );
    const fixture = await render({ restore });
    const root = fixture.nativeElement as HTMLElement;

    await pick(fixture, JSON.stringify(BACKUP));
    const summary = root.querySelector('[data-testid="backup-summary"]')?.textContent ?? '';
    expect(summary).toContain('Stashboard 1.3.0');
    expect(summary).toContain('with API keys');
    expect(restore).not.toHaveBeenCalled();

    (root.querySelector('[data-testid="restore-backup"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(restore).toHaveBeenCalledWith(BACKUP);
    const results = root.querySelector('[data-testid="restore-results"]')?.textContent ?? '';
    expect(results).toContain('Stash');
    expect(results).toContain('Pick a folder inside one of Stash’s library folders.');
    expect(root.textContent).toContain('Reload Stashboard');
  });

  it('refuses a file that isn’t a backup without sending it', async () => {
    const restore = vi.fn();
    const fixture = await render({ restore });

    await pick(fixture, '{"hello":"world"}');
    expect(fixture.nativeElement.textContent).toContain('That file isn’t a Stashboard backup.');

    await pick(fixture, 'not json');
    expect(fixture.nativeElement.textContent).toContain('That file isn’t a Stashboard backup.');
    expect(restore).not.toHaveBeenCalled();
  });

  it('shows why the server refused the whole file', async () => {
    const restore = vi.fn().mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { message: 'Nothing was restored. Appearance: mode must be one of …' },
          }),
      ),
    );
    const fixture = await render({ restore });
    await pick(fixture, JSON.stringify(BACKUP));

    (
      fixture.nativeElement.querySelector('[data-testid="restore-backup"]') as HTMLButtonElement
    ).click();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Nothing was restored.');
  });
});
