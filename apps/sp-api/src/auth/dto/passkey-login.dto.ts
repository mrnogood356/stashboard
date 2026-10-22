import { IsBoolean, IsObject, IsOptional } from 'class-validator';

export class PasskeyLoginDto {
  /** The WebAuthn assertion from the browser, passed through as-is. */
  @IsObject()
  response!: Record<string, unknown>;

  /** "Keep me signed in", as for a password login. Left out: on. */
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
