import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { DiscoverQueryDto } from '../../discover/dto/discover-query.dto';

/** The Stats page's resolution groups: by a video's short side. */
export const LIBRARY_RESOLUTIONS = [
  '4k',
  '1080p',
  '720p',
  'sd',
  'unknown',
] as const;
export type LibraryResolution = (typeof LIBRARY_RESOLUTIONS)[number];

export const LIBRARY_SCENE_SORT_VALUES = [
  'CREATED_AT',
  'UPDATED_AT',
  'TITLE',
  'RELEASE_DATE',
  'PRODUCTION_DATE',
] as const;
export type LibrarySceneSort = (typeof LIBRARY_SCENE_SORT_VALUES)[number];

export const LIBRARY_SORT_DIRECTION_VALUES = ['ASC', 'DESC'] as const;
export type LibrarySortDirection =
  (typeof LIBRARY_SORT_DIRECTION_VALUES)[number];

export const LIBRARY_TAG_MATCH_MODE_VALUES = ['OR', 'AND'] as const;
export type LibraryTagMatchMode =
  (typeof LIBRARY_TAG_MATCH_MODE_VALUES)[number];

function parseStringArray(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  const segments = Array.isArray(value) ? value : [value];
  return segments
    .flatMap((entry) =>
      typeof entry === 'string' ? entry.split(',') : [String(entry)],
    )
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class LibraryScenesQueryDto extends DiscoverQueryDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : undefined,
  )
  @IsString()
  query?: string;

  @IsOptional()
  @IsIn(LIBRARY_SCENE_SORT_VALUES)
  sort?: LibrarySceneSort;

  @IsOptional()
  @IsIn(LIBRARY_SORT_DIRECTION_VALUES)
  direction?: LibrarySortDirection;

  @IsOptional()
  @Transform(({ value }) => parseStringArray(value))
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];

  @IsOptional()
  @IsIn(LIBRARY_TAG_MATCH_MODE_VALUES)
  tagMode?: LibraryTagMatchMode;

  @IsOptional()
  @Transform(({ value }) => parseStringArray(value))
  @IsArray()
  @IsString({ each: true })
  studioIds?: string[];

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  favoritePerformersOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  favoriteStudiosOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  favoriteTagsOnly?: boolean;

  /** Only scenes of one quality, as the Stats page groups them. */
  @IsOptional()
  @IsIn(LIBRARY_RESOLUTIONS)
  resolution?: LibraryResolution;
}
