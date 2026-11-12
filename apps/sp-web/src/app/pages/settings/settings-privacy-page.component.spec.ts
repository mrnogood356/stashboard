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

  it('asks for the password and shows Save only once something changed', async () => {
    const { fixture, component } = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="app-lock-password"]')).toBeNull();
    expect(root.textContent).not.toContain('Save App Lock');

    component['hideInSwitcher'] = false;
    fixture.detectChanges();
    expect(root.querySelector('[data-testid="app-lock-password"]')).not.toBeNull();
    expect(root.textContent).toContain('Save App Lock');
  });

  it('explains that Face ID needs HTTPS on plain http://', async () => {
    const { fixture } = await render({ enabled: true, hasPin: true }, false);
    expect(fixture.nativeElement.textContent).toContain(
      'Face ID needs Stashboard to be opened over',
    );
  });

  it('says when the settings can’t be read, instead of offering defaults as saved', async () => {
    const { fixture, appLock } = await render();
    appLock.refresh.mockResolvedValueOnce(null);
    const component = fixture.componentInstance as unknown as { load(): Promise<void> };
    await component.load();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="app-lock-load-failed"]')).not.toBeNull();
    expect(root.textContent).not.toContain('Hide in app switcher');
  });

  it('keeps a change made while saving as unsaved', async () => {
    const { fixture, component, appLock } = await render();
    let finish!: () => void;
    appLock.saveSettings.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    component['hideInSwitcher'] = false;
    component['currentPassword'] = 'pw';
    const saving = (component['save'] as () => Promise<void>).call(component);
    component['hideInSwitcher'] = true;
    finish();
    await saving;
    fixture.detectChanges();
    // Sent off, on its way back on: still a change to save.
    expect((component['changed'] as () => boolean).call(component)).toBe(true);
  });
});
