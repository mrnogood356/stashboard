import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type NotificationChannel = 'DISCORD' | 'NTFY' | 'WEBHOOK' | 'PUSHOVER';

export interface NotificationSettings {
  enabled: boolean;
  channel: NotificationChannel;
  url: string | null;
  /** Pushover's application token, or an ntfy access token. */
  token: string | null;
  /** Pushover's user (or group) key. */
  userKey: string | null;
  notifyDownloading: boolean;
  notifyAvailable: boolean;
  notifyFailed: boolean;
}

@Injectable({ providedIn: 'root' })
export class NotificationsService {
  private readonly http = inject(HttpClient);

  getSettings(): Observable<NotificationSettings> {
    return this.http.get<NotificationSettings>('/api/notifications/settings');
  }

  saveSettings(settings: NotificationSettings): Observable<NotificationSettings> {
    return this.http.put<NotificationSettings>('/api/notifications/settings', settings);
  }

  sendTest(settings: NotificationSettings): Observable<void> {
    return this.http.post<void>('/api/notifications/test', settings);
  }
}
