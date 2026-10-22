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
});
