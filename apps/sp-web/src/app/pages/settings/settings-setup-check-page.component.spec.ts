import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupCheckApiService, SetupCheckResponse } from '../../core/api/setup-check.service';
import { AppNotificationsService } from '../../core/notifications/app-notifications.service';
import { SettingsSetupCheckPageComponent } from './settings-setup-check-page.component';

const result: SetupCheckResponse = {
  checkedAt: new Date().toISOString(),
  checks: [
    { id: 'stash', title: 'Stash', status: 'ok', summary: 'Stash 0.28 is reachable.' },
    {
      id: 'webhook',
      title: 'Whisparr import webhook',
      status: 'fail',
      summary: 'Whisparr doesn’t tell Stashboard about imports.',
      detail: 'In Whisparr, add a webhook.',
      fix: { label: 'Add it in Whisparr', action: 'whisparr-webhook' },
    },
    { id: 'naming', title: 'Naming', status: 'warn', summary: 'Patterns differ.' },
  ],
};

describe('SettingsSetupCheckPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(api: Partial<Record<keyof SetupCheckApiService, unknown>>) {
    const notifications = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [SettingsSetupCheckPageComponent],
      providers: [
        provideRouter([]),
        { provide: SetupCheckApiService, useValue: api },
        { provide: AppNotificationsService, useValue: notifications },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsSetupCheckPageComponent);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, notifications };
  }

  it('links to About & health', async () => {
    const { root } = await render({ run: vi.fn().mockReturnValue(of(result)) });

    const link = root.querySelector<HTMLAnchorElement>('a.inline-link');
    expect(link?.textContent).toContain('About & health');
    expect(link?.getAttribute('href')).toBe('/settings/about');
  });

  it('lists the checks, says what needs fixing and opens the failing one', async () => {
    const { root } = await render({ run: vi.fn().mockReturnValue(of(result)) });

    expect(root.querySelector('h2')?.textContent).toContain('1 thing needs fixing');
    expect(root.querySelectorAll('.check')).toHaveLength(3);
    expect(root.textContent).toContain('In Whisparr, add a webhook.');
  });

  it('applies a fix and checks again', async () => {
    const run = vi.fn().mockReturnValue(of(result));
    const fix = vi.fn().mockReturnValue(of({ ok: true, message: 'Webhook added.' }));
    const { fixture, root, notifications } = await render({ run, fix });

    Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Add it in Whisparr'))!
      .click();
    fixture.detectChanges();

    expect(fix).toHaveBeenCalledWith('whisparr-webhook');
    expect(notifications.success).toHaveBeenCalledWith('Fixed', 'Webhook added.');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('says when the check can’t run', async () => {
    const { root } = await render({ run: vi.fn().mockReturnValue(throwError(() => new Error())) });
    expect(root.textContent).toContain('Couldn’t run the setup check');
  });
});
