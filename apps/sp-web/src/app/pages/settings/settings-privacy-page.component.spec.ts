import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLockService, AppLockStatus } from '../../core/app-lock/app-lock.service';
import { SettingsPrivacyPageComponent } from './settings-privacy-page.component';

describe('SettingsPrivacyPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function render(initial: Partial<AppLockStatus> = {}, faceIdSupported = false) {
    const status = signal<AppLockStatus | null>({
      enabled: false,
      locked: false,
      timeoutSeconds: 60,
      hideInSwitcher: true,
      hasPin: false,
      passkeys: [],
      ...initial,
    });
    const appLock = {
      status,
      enabled: computed(() => status()?.enabled ?? false),
      faceIdSupported: signal(faceIdSupported),
      refresh: vi.fn().mockImplementation(() => Promise.resolve(status())),
      saveSettings: vi.fn().mockResolvedValue(status()),
      describeError: () => 'Error',
    };
    await TestBed.configureTestingModule({
      imports: [SettingsPrivacyPageComponent],
      providers: [{ provide: AppLockService, useValue: appLock }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsPrivacyPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return {
      fixture,
      appLock,
      component: fixture.componentInstance as unknown as Record<string, unknown>,
    };
  }

  it('requires a matching 4–8 digit PIN and the account password to turn the lock on', async () => {
    const { component, appLock } = await render();
    component['enabled'] = true;

    component['pin'] = '12';
    component['pinConfirm'] = '12';
    component['currentPassword'] = 'pw';
    expect((component['validationError'] as () => string | null).call(component)).toBe(
      'Use a PIN of 4 to 8 digits.',
    );

    component['pin'] = '2468';
    component['pinConfirm'] = '2469';
    expect((component['validationError'] as () => string | null).call(component)).toBe(
      "The PINs don't match.",
    );

    component['pinConfirm'] = '2468';
    await (component['save'] as () => Promise<void>).call(component);
    expect(appLock.saveSettings).toHaveBeenCalledWith({
      enabled: true,
      pin: '2468',
      timeoutSeconds: 60,
      hideInSwitcher: true,
      currentPassword: 'pw',
    });
  });

  it('explains that Face ID needs HTTPS on plain http://', async () => {
    const { fixture } = await render({ enabled: true, hasPin: true }, false);
    expect(fixture.nativeElement.textContent).toContain(
      'Face ID needs Stashboard to be opened over',
    );
  });
});
