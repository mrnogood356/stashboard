import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export const APP_LOCK_TIMEOUT_VALUES = [0, 60, 300, 900, 3600] as const;

export class UnlockWithPinDto {
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'Enter your 4–8 digit PIN.' })
  pin!: string;
}

export class UpdateAppLockSettingsDto {
  @IsBoolean()
  enabled!: boolean;

  /** New PIN; required when turning App Lock on for the first time. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'Use a 4–8 digit PIN.' })
  pin?: string;

  /** Seconds in the background before locking; 0 locks as soon as you leave. */
  @IsIn(APP_LOCK_TIMEOUT_VALUES)
  timeoutSeconds!: number;

  @IsBoolean()
  hideInSwitcher!: boolean;

  /** Account password, to confirm changes to App Lock. */
  @IsString()
  @Length(1, 512)
  currentPassword!: string;
}

export class PasskeyRegistrationOptionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class PasskeyResponseDto {
  /** The WebAuthn response from the browser, passed through as-is. */
  @IsObject()
  response!: Record<string, unknown>;
}

export interface AppLockStatusDto {
  enabled: boolean;
  locked: boolean;
  timeoutSeconds: number;
  hideInSwitcher: boolean;
  hasPin: boolean;
  passkeys: Array<{
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
}
