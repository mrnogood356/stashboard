import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { FOLLOW_KINDS, type FollowKindValue } from '../follows.model';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class CreateFollowDto {
  @IsIn(FOLLOW_KINDS)
  kind!: FollowKindValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  entityId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string | null;

  /** YYYY-MM-DD; today when left out. */
  @IsOptional()
  @Matches(DAY_PATTERN)
  since?: string;

  @IsOptional()
  @IsBoolean()
  autoRequest?: boolean;
}

export class UpdateFollowDto {
  @IsOptional()
  @Matches(DAY_PATTERN)
  since?: string;

  @IsOptional()
  @IsBoolean()
  autoRequest?: boolean;
}

export class FollowLookupQueryDto {
  @IsIn(FOLLOW_KINDS)
  kind!: FollowKindValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  entityId!: string;
}

export const RELEASE_VIEWS = ['review', 'all'] as const;
export type ReleaseView = (typeof RELEASE_VIEWS)[number];

export class FollowedReleasesQueryDto {
  @IsOptional()
  @IsIn(RELEASE_VIEWS)
  view?: ReleaseView;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** One follow in a settings backup. */
export class FollowBackupItemDto {
  @IsIn(FOLLOW_KINDS)
  kind!: FollowKindValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  provider!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  entityId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string | null;

  @Matches(DAY_PATTERN)
  since!: string;

  @Transform(({ value }) => value === true)
  @IsBoolean()
  autoRequest!: boolean;
}

export class FollowsBackupDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => FollowBackupItemDto)
  follows!: FollowBackupItemDto[];
}
