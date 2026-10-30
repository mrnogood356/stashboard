import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const NOTIFICATION_CHANNEL_VALUES = [
  'DISCORD',
  'NTFY',
  'WEBHOOK',
  'PUSHOVER',
] as const;
export type NotificationChannelValue =
  (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export class NotificationSettingsDto {
  enabled!: boolean;
  channel!: NotificationChannelValue;
  url!: string | null;
  /** Pushover's application token, or an ntfy access token. */
  token!: string | null;
  /** Pushover's user (or group) key. */
  userKey!: string | null;
  notifyDownloading!: boolean;
  notifyAvailable!: boolean;
  notifyFailed!: boolean;
}

export class UpdateNotificationSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsIn(NOTIFICATION_CHANNEL_VALUES)
  channel!: NotificationChannelValue;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  token?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  userKey?: string | null;

  @IsBoolean()
  notifyDownloading!: boolean;

  @IsBoolean()
  notifyAvailable!: boolean;

  @IsBoolean()
  notifyFailed!: boolean;
}
