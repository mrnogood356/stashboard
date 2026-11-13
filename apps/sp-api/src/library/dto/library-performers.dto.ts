import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class LibraryPerformersQueryDto {
  /** Part of a name. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  perPage?: number;
}

/** A performer in your own scenes, by their Stash id. */
export interface LibraryPerformerDto {
  id: string;
  name: string;
  /** Scenes of yours they're in. */
  count: number;
  imageUrl: string;
}

export interface LibraryPerformersDto {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  items: LibraryPerformerDto[];
}
