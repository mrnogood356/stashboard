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
] as const;
export type NotificationChannelValue =
  (typeof NOTIFICATION_CHANNEL_VALUES)[number];

export class NotificationSettingsDto {
  enabled!: boolean;
  channel!: NotificationChannelValue;
  url!: string | null;
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

  @IsBoolean()
  notifyDownloading!: boolean;

  @IsBoolean()
  notifyAvailable!: boolean;

  @IsBoolean()
  notifyFailed!: boolean;
}
