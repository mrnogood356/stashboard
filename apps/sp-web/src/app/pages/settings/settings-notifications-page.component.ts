import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  NotificationChannel,
  NotificationSettings,
  NotificationsService,
} from '../../core/api/notifications.service';

const CHANNEL_HELP: Record<
  NotificationChannel,
  { label: string; placeholder: string; help: string }
> = {
  DISCORD: {
    label: 'Discord',
    placeholder: 'https://discord.com/api/webhooks/…',
    help: 'In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
  },
  NTFY: {
    label: 'ntfy',
    placeholder: 'https://ntfy.sh/your-private-topic',
    help: 'Use your topic URL, on ntfy.sh or your own ntfy server. Subscribe to the same topic in the ntfy app.',
  },
  PUSHOVER: {
    label: 'Pushover',
    placeholder: '',
    help: 'Your user key is on the Pushover dashboard. For the token, create an application there (Stashboard as the name) and copy its API token.',
  },
  WEBHOOK: {
    label: 'Webhook',
    placeholder: 'https://example.local/hooks/stashboard',
    help: 'Stashboard POSTs JSON: { "title", "message", "source": "stashboard" }.',
  },
};

@Component({
  selector: 'app-settings-notifications-page',
  imports: [FormsModule],
  templateUrl: './settings-notifications-page.component.html',
  styleUrls: ['./settings-notifications-page.component.scss', './settings-shared.scss'],
})
export class SettingsNotificationsPageComponent implements OnInit {
  private readonly notificationsService = inject(NotificationsService);

  protected readonly channels = Object.entries(CHANNEL_HELP).map(([value, info]) => ({
    value: value as NotificationChannel,
    label: info.label,
  }));
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly status = signal<{ kind: 'ok' | 'error'; text: string } | null>(null);
  protected readonly form = signal<NotificationSettings>({
    enabled: false,
    channel: 'DISCORD',
    url: null,
    token: null,
    userKey: null,
    notifyDownloading: false,
    notifyAvailable: true,
    notifyFailed: true,
  });

  ngOnInit(): void {
    this.notificationsService.getSettings().subscribe({
      next: (settings) => {
        this.form.set(settings);
        this.loading.set(false);
      },
      error: () => {
        this.status.set({ kind: 'error', text: 'Notification settings could not be loaded.' });
        this.loading.set(false);
      },
    });
  }

  protected help() {
    return CHANNEL_HELP[this.form().channel];
  }

  /** Whether the form has what the chosen channel needs to send. */
  protected canSend(): boolean {
    const form = this.form();
    return form.channel === 'PUSHOVER'
      ? Boolean(form.token?.trim() && form.userKey?.trim())
      : Boolean(form.url?.trim());
  }

  protected update<K extends keyof NotificationSettings>(
    key: K,
    value: NotificationSettings[K],
  ): void {
    this.form.update((current) => ({
      ...current,
      [key]: value,
      // A Pushover token is no ntfy token: it must never reach an ntfy server.
      ...(key === 'channel' && value !== current.channel ? { token: null } : {}),
    }));
    this.status.set(null);
  }

  protected save(): void {
    this.saving.set(true);
    this.status.set(null);
    this.notificationsService.saveSettings(this.form()).subscribe({
      next: (settings) => {
        this.form.set(settings);
        this.saving.set(false);
        this.status.set({ kind: 'ok', text: 'Saved.' });
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.status.set({
          kind: 'error',
          text: messageFrom(error, 'Settings could not be saved.'),
        });
      },
    });
  }

  protected sendTest(): void {
    this.testing.set(true);
    this.status.set(null);
    this.notificationsService.sendTest(this.form()).subscribe({
      next: () => {
        this.testing.set(false);
        this.status.set({ kind: 'ok', text: 'Test notification sent. Check your app.' });
      },
      error: (error: unknown) => {
        this.testing.set(false);
        this.status.set({ kind: 'error', text: messageFrom(error, 'The test could not be sent.') });
      },
    });
  }
}

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
    if (Array.isArray(message) && typeof message[0] === 'string') {
      return message[0];
    }
  }
  return fallback;
}
