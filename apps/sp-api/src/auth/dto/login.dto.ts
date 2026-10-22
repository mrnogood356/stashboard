import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  /**
   * "Keep me signed in". Off: the cookie lasts until the browser closes and
   * the session ends after 12 hours away. Left out, as older apps do: on.
   */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
