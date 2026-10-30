import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsService } from '../../core/api/notifications.service';
import { SettingsNotificationsPageComponent } from './settings-notifications-page.component';

describe('SettingsNotificationsPageComponent', () => {
  afterEach(() => TestBed.resetTestingModule());

  const saved = {
    enabled: true,
    channel: 'NTFY' as const,
    url: 'https://ntfy.sh/topic',
    token: null,
    userKey: null,
    notifyDownloading: false,
    notifyAvailable: true,
    notifyFailed: true,
  };

  async function render(service: Partial<Record<keyof NotificationsService, unknown>>) {
    await TestBed.configureTestingModule({
      imports: [SettingsNotificationsPageComponent],
      providers: [{ provide: NotificationsService, useValue: service }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsNotificationsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('loads saved settings and shows help for the chosen channel', async () => {
    const fixture = await render({ getSettings: vi.fn().mockReturnValue(of(saved)) });
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Subscribe to the same topic in the ntfy app');
    expect(
      (fixture.nativeElement.querySelector('input[name="url"]') as HTMLInputElement).placeholder,
    ).toContain('ntfy.sh');
  });

  it('sends a test with the current form and shows server errors', async () => {
    const sendTest = vi.fn().mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { message: 'The test notification could not be sent: the server replied 404' },
          }),
      ),
    );
    const fixture = await render({ getSettings: vi.fn().mockReturnValue(of(saved)), sendTest });

    const testButton = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.includes('Send test'))!;
    testButton.click();
    fixture.detectChanges();

    expect(sendTest).toHaveBeenCalledWith(saved);
    expect(fixture.nativeElement.textContent).toContain('the server replied 404');
  });

  it('asks for Pushover keys instead of a URL, and only then allows a test', async () => {
    const fixture = await render({
      getSettings: vi
        .fn()
        .mockReturnValue(of({ ...saved, channel: 'PUSHOVER' as const, url: null })),
    });
    const root = fixture.nativeElement as HTMLElement;
    const testButton = () =>
      Array.from(root.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Send test'),
      )!;

    expect(root.querySelector('input[name="url"]')).toBeNull();
    expect(root.querySelector('input[name="userKey"]')).not.toBeNull();
    expect(testButton().disabled).toBe(true);

    for (const [name, value] of [
      ['userKey', 'user-key'],
      ['token', 'app-token'],
    ]) {
      const input = root.querySelector(`input[name="${name}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(testButton().disabled).toBe(false);
  });

  it('forgets the Pushover token when switching to ntfy, so it never reaches ntfy', async () => {
    const sendTest = vi.fn().mockReturnValue(of(undefined));
    const fixture = await render({
      getSettings: vi.fn().mockReturnValue(
        of({
          ...saved,
          channel: 'PUSHOVER' as const,
          url: 'https://ntfy.sh/topic',
          token: 'pushover-app-token',
          userKey: 'user-key',
        }),
      ),
      sendTest,
    });
    const root = fixture.nativeElement as HTMLElement;

    Array.from(root.querySelectorAll('label.channel-option'))
      .find((label) => label.textContent?.trim() === 'ntfy')!
      .querySelector('input')!
      .click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    Array.from(root.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Send test'))!
      .click();

    expect(sendTest).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'NTFY', token: null }),
    );
  });
});
