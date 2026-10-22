import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationApiService, AutomationSettings } from '../../core/api/automation.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SettingsAutomationPageComponent } from './settings-automation-page.component';

const base: AutomationSettings = {
  scanOnImport: true,
  identifyNew: true,
  generateNew: false,
  removeSamples: false,
  watchFolders: true,
  tidyAfterImport: true,
  foldersVisible: true,
  webhookPath: '/api/hooks/whisparr/abc123',
  running: false,
  lastRun: {
    at: new Date().toISOString(),
    status: 'DONE',
    message: 'Found 1 new scene, identified.',
    reason: 'webhook',
  },
};

describe('SettingsAutomationPageComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  async function render(api: Partial<Record<keyof AutomationApiService, unknown>>) {
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [SettingsAutomationPageComponent],
      providers: [
        provideRouter([]),
        { provide: AutomationApiService, useValue: api },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsAutomationPageComponent);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
  }

  it('shows the switches, last run and the webhook address', async () => {
    const { root } = await render({ get: vi.fn().mockReturnValue(of(base)) });

    const switches = Array.from(root.querySelectorAll('[role="switch"]'));
    expect(switches.map((entry) => entry.getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'true',
      'false',
      'false',
      'true',
    ]);
    expect(root.textContent).not.toContain('can’t see those folders');
    expect(root.textContent).toContain('Found 1 new scene, identified.');
    expect(root.textContent).toContain('Whisparr imported a scene');
    expect(root.querySelector('.url')?.textContent).toBe(
      `${window.location.origin}/api/hooks/whisparr/abc123`,
    );
  });

  it('saves a switch, and puts it back if saving fails', async () => {
    const update = vi
      .fn()
      .mockReturnValueOnce(of({ ...base, generateNew: true }))
      .mockReturnValueOnce(throwError(() => new Error('offline')));
    const { fixture, root, notifications } = await render({
      get: vi.fn().mockReturnValue(of(base)),
      update,
    });

    root.querySelectorAll<HTMLButtonElement>('[role="switch"]')[3].click();
    fixture.detectChanges();
    expect(update).toHaveBeenCalledWith({ generateNew: true });
    expect(root.querySelectorAll('[role="switch"]')[3].getAttribute('aria-checked')).toBe('true');

    root.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0].click();
    fixture.detectChanges();
    expect(update).toHaveBeenLastCalledWith({ scanOnImport: false });
    expect(root.querySelectorAll('[role="switch"]')[0].getAttribute('aria-checked')).toBe('true');
    expect(notifications.error).toHaveBeenCalled();
  });

  it('runs now', async () => {
    const runNow = vi.fn().mockReturnValue(of(base));
    const { fixture, root } = await render({ get: vi.fn().mockReturnValue(of(base)), runNow });

    Array.from(root.querySelectorAll<HTMLButtonElement>('.pill'))
      .find((button) => button.textContent?.includes('Run now'))!
      .click();
    fixture.detectChanges();

    expect(runNow).toHaveBeenCalled();
    expect(root.textContent).toContain('Running');
    fixture.destroy();
  });

  it('says when Stashboard can’t see the library folders it should watch', async () => {
    const { root } = await render({
      get: vi.fn().mockReturnValue(of({ ...base, foldersVisible: false })),
    });
    expect(root.textContent).toContain('Stashboard can’t see those folders');
  });
});
