import { Transform } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : undefined;

export class LibraryOptionsQueryDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  query?: string;

  /** Only a performer's scenes: their own categories and studios. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  performerId?: string;

  /** Only a studio's scenes: its own categories. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  studioId?: string;
}
