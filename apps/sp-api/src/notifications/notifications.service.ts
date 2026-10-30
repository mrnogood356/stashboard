import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { fetchWithTimeout } from '../providers/fetch-with-timeout';
import {
  type NotificationChannelValue,
  type NotificationSettingsDto,
  type UpdateNotificationSettingsDto,
} from './dto/notification-settings.dto';

const SETTINGS_KEY = 'GLOBAL';
const MAX_LISTED_TITLES = 5;
const SEND_TIMEOUT_MS = 10_000;
const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
/** Pushover refuses a whole message over these. */
const PUSHOVER_TITLE_MAX = 250;
const PUSHOVER_MESSAGE_MAX = 1024;

export type SceneNotificationEvent = 'DOWNLOADING' | 'AVAILABLE' | 'FAILED';

export interface SceneNotification {
  event: SceneNotificationEvent;
  title: string;
}

interface OutgoingMessage {
  title: string;
  body: string;
  /** Discord embed colour. */
  color: number;
}

const EVENT_COPY: Record<
  SceneNotificationEvent,
  {
    single: string;
    many: (count: number) => string;
    color: number;
    tag: string;
  }
> = {
  DOWNLOADING: {
    single: 'Download started',
    many: (count) => `${count} downloads started`,
    color: 0x3b82f6,
    tag: 'arrow_down',
  },
  AVAILABLE: {
    single: 'Now in your library',
    many: (count) => `${count} scenes are now in your library`,
    color: 0x22c55e,
    tag: 'white_check_mark',
  },
  FAILED: {
    single: 'Download failed',
    many: (count) => `${count} downloads failed`,
    color: 0xef4444,
    tag: 'warning',
  },
};

/** Where a message goes: the URL, plus Pushover's or ntfy's keys. */
interface Destination {
  channel: NotificationChannelValue;
  url: string | null;
  token: string | null;
  userKey: string | null;
}

/**
 * Sends a message to Discord, ntfy, Pushover or a generic webhook when requested scenes
 * change state. Events from one sync batch are grouped per type so a big sync
 * produces a few summary messages instead of a flood.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<NotificationSettingsDto> {
    const row = await this.prisma.notificationSettings.findUnique({
      where: { key: SETTINGS_KEY },
    });

    return {
      enabled: row?.enabled ?? false,
      channel: row?.channel ?? 'DISCORD',
      url: row?.url ?? null,
      token: row?.token ?? null,
      userKey: row?.userKey ?? null,
      notifyDownloading: row?.notifyDownloading ?? false,
      notifyAvailable: row?.notifyAvailable ?? true,
      notifyFailed: row?.notifyFailed ?? true,
    };
  }

  async updateSettings(
    dto: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsDto> {
    const destination = toDestination(dto);
    if (dto.enabled) {
      assertComplete(destination, 'before turning notifications on');
    }

    const data = {
      enabled: dto.enabled,
      channel: dto.channel,
      url: destination.url,
      token: destination.token,
      userKey: destination.userKey,
      notifyDownloading: dto.notifyDownloading,
      notifyAvailable: dto.notifyAvailable,
      notifyFailed: dto.notifyFailed,
    };
    await this.prisma.notificationSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, ...data },
      update: data,
    });
    this.logger.log(
      `Notification settings saved: ${data.enabled ? 'on' : 'off'}, ${data.channel}.`,
    );

    return this.getSettings();
  }

  /** Sends a test message using the given (possibly unsaved) settings. */
  async sendTest(dto: UpdateNotificationSettingsDto): Promise<void> {
    const destination = toDestination(dto);
    assertComplete(destination, 'to send a test notification');

    try {
      await this.post(destination, {
        title: 'Stashboard test notification',
        body: 'Notifications are working. You will hear from Stashboard when requests change.',
        color: 0x74b8ed,
      });
    } catch (error) {
      this.logger.warn(
        `Test notification through ${dto.channel} failed: ${errorMessage(error)}`,
      );
      throw new BadRequestException(
        `The test notification could not be sent: ${errorMessage(error)}`,
      );
    }
    this.logger.log(`Sent a test notification through ${dto.channel}.`);
  }

  /**
   * Delivers scene state changes, one message per event group, one after the
   * other (each send can take up to SEND_TIMEOUT_MS). Never throws, and one
   * failed message doesn't stop the rest. Indexing calls this without
   * awaiting it, so a slow or broken webhook can't hold indexing up.
   */
  async notifySceneChanges(changes: SceneNotification[]): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    try {
      const settings = await this.getSettings();
      if (!settings.enabled || !isComplete(settings)) {
        return;
      }

      const wanted = changes.filter(
        (change) =>
          (change.event === 'DOWNLOADING' && settings.notifyDownloading) ||
          (change.event === 'AVAILABLE' && settings.notifyAvailable) ||
          (change.event === 'FAILED' && settings.notifyFailed),
      );

      const messages = buildMessages(wanted);
      let sent = 0;
      for (const message of messages) {
        try {
          await this.post(settings, message);
          sent += 1;
        } catch (error) {
          this.logger.warn(
            `Notification delivery failed: ${errorMessage(error)}`,
          );
        }
      }
      if (sent > 0) {
        this.logger.log(
          `Sent ${sent} notification(s) through ${settings.channel} about ${wanted.length} scene change(s).`,
        );
      } else if (messages.length === 0) {
        this.logger.debug(
          `No notifications wanted for ${changes.length} scene change(s).`,
        );
      }
    } catch (error) {
      this.logger.warn(`Notification delivery failed: ${errorMessage(error)}`);
    }
  }

  private async post(
    destination: Destination,
    message: OutgoingMessage,
  ): Promise<void> {
    let init: RequestInit;
    let url = destination.url ?? '';

    switch (destination.channel) {
      case 'DISCORD':
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'Stashboard',
            embeds: [
              {
                title: message.title,
                description: message.body,
                color: message.color,
              },
            ],
          }),
        };
        break;
      case 'NTFY':
        init = {
          method: 'POST',
          headers: {
            Title: asciiHeader(message.title),
            Tags: 'stashboard',
            ...(destination.token
              ? { Authorization: `Bearer ${destination.token}` }
              : {}),
          },
          body: message.body,
        };
        break;
      case 'PUSHOVER':
        url = PUSHOVER_URL;
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: destination.token,
            user: destination.userKey,
            title: clip(message.title, PUSHOVER_TITLE_MAX),
            message: clip(message.body, PUSHOVER_MESSAGE_MAX),
          }),
        };
        break;
      default:
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: message.title,
            message: message.body,
            source: 'stashboard',
          }),
        };
    }

    const response = await fetchWithTimeout(url, init, SEND_TIMEOUT_MS);
    // Nothing in the reply is needed; let the connection go.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`the server replied ${response.status}`);
    }
  }
}

function buildMessages(changes: SceneNotification[]): OutgoingMessage[] {
  const byEvent = new Map<SceneNotificationEvent, string[]>();
  for (const change of changes) {
    byEvent.set(change.event, [
      ...(byEvent.get(change.event) ?? []),
      change.title,
    ]);
  }

  const messages: OutgoingMessage[] = [];
  for (const [event, titles] of byEvent) {
    const copy = EVENT_COPY[event];
    const listed = titles
      .slice(0, MAX_LISTED_TITLES)
      .map((title) => `• ${title}`);
    if (titles.length > MAX_LISTED_TITLES) {
      listed.push(`…and ${titles.length - MAX_LISTED_TITLES} more`);
    }

    messages.push({
      title: titles.length === 1 ? copy.single : copy.many(titles.length),
      body: titles.length === 1 ? titles[0] : listed.join('\n'),
      color: copy.color,
    });
  }
  return messages;
}

function toDestination(dto: UpdateNotificationSettingsDto): Destination {
  const url = dto.url?.trim() || null;
  if (url) {
    assertHttpUrl(url);
  }
  return {
    channel: dto.channel,
    url,
    token: dto.token?.trim() || null,
    userKey: dto.userKey?.trim() || null,
  };
}

/** Pushover needs its two keys; every other channel needs a URL. */
function isComplete(destination: Destination): boolean {
  return destination.channel === 'PUSHOVER'
    ? Boolean(destination.token && destination.userKey)
    : Boolean(destination.url);
}

function assertComplete(destination: Destination, purpose: string): void {
  if (isComplete(destination)) {
    return;
  }
  throw new BadRequestException(
    destination.channel === 'PUSHOVER'
      ? `Add your Pushover user key and application token ${purpose}.`
      : `Add a URL ${purpose}.`,
  );
}

function assertHttpUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException(
      'Enter a full URL starting with http:// or https://.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestException(
      'Enter a full URL starting with http:// or https://.',
    );
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** HTTP headers must be ASCII; ntfy titles fall back to plain text. */
function asciiHeader(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').trim() || 'Stashboard';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
