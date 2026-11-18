import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateLocalSceneDto {
  /** 0–100 like Stash; null clears the rating. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  rating100?: number | null;

  @IsOptional()
  @IsBoolean()
  organized?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tagIds?: string[];

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'A scene needs a title.' })
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  code?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20000)
  details?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  director?: string | null;

  /** YYYY-MM-DD; null clears it. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Write the date as YYYY-MM-DD.' })
  date?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  @Matches(/^https?:\/\/\S+$/, {
    each: true,
    message: 'Each link starts with http:// or https://.',
  })
  urls?: string[];

  /** Null takes the studio off. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  studioId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  performerIds?: string[];
}

export class PeopleSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}

export class SceneWatchedDto {
  @IsBoolean()
  watched!: boolean;
}

export class FavoriteDto {
  @IsBoolean()
  favorite!: boolean;
}

export const LOCAL_SCENE_SORTS = [
  'DATE',
  'PRODUCED',
  'ADDED',
  'PLAYS',
  'TITLE',
  'RANDOM',
] as const;
export type LocalSceneSort = (typeof LOCAL_SCENE_SORTS)[number];

export class LocalScenesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsIn(LOCAL_SCENE_SORTS)
  sort?: LocalSceneSort;

  /** Seed so RANDOM keeps the same order while paging. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  seed?: number;
}

/** A performer's or studio's scenes, optionally narrowed to some categories and studios. */
export class LocalCollectionScenesQueryDto extends LocalScenesQueryDto {
  @IsOptional()
  @Transform(({ value }) => idList(value))
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tagIds?: string[];

  @IsOptional()
  @Transform(({ value }) => idList(value))
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  studioIds?: string[];
}

/** "a,b" or ?x=a&x=b as ["a", "b"], without blanks or repeats. */
function idList(value: unknown): string[] {
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((part) => (typeof part === 'string' ? part.split(',') : []))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set(parts)];
}

export class FixScenesQueryDto extends LocalScenesQueryDto {
  /** How many scenes are already shown; the list carries on after them. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

export const LOCAL_BULK_ACTIONS = ['organize', 'remove', 'delete'] as const;
/** organize: mark organized; remove: off Stash, files stay; delete: files too. */
export type LocalBulkAction = (typeof LOCAL_BULK_ACTIONS)[number];

export class LocalBulkScenesDto {
  @IsIn(LOCAL_BULK_ACTIONS)
  action!: LocalBulkAction;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  sceneIds!: string[];
}

export class TagSearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}

export class CreateMarkerDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsNumber()
  @Min(0)
  @Max(7 * 24 * 3600)
  seconds!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  primaryTagId!: string;
}

export const FIX_KINDS = ['unmatched', 'untagged', 'unorganized'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

export const LIBRARY_TASKS = [
  'scan',
  'generate',
  'identify',
  'auto-tag',
  'clean',
] as const;

export class IdentifyScenesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  sceneIds!: string[];
}

export class DuplicatesQueryDto {
  @IsOptional()
  @IsIn(['exact', 'high', 'medium'])
  accuracy?: 'exact' | 'high' | 'medium';
}

export class SamplesQueryDto {
  /** Also count any video shorter than this many minutes; 0 for names only. */
  @IsOptional()
  @IsIn(['0', '1', '2', '5'])
  shorterThan?: '0' | '1' | '2' | '5';
}

export class DeleteSceneQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  deleteFile?: 'true' | 'false';

  /** Refuse a scene with more than one file (Duplicates). */
  @IsOptional()
  @IsIn(['true', 'false'])
  onlyFile?: 'true' | 'false';

  /** Duplicates: first carry plays, tags, chapters and more to this scene. */
  @IsOptional()
  @Matches(/^\d{1,12}$/)
  carryTo?: string;
}

/** Library → Chapters. One value each: a repeated parameter is refused. */
export class ChaptersQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}$/)
  tag?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{1,12}$/)
  performer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class MergeQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class SkipProblemDto {
  @IsIn(['no-file', 'no-length', 'unreadable', 'file-check', 'generate'])
  kind!: 'no-file' | 'no-length' | 'unreadable' | 'file-check' | 'generate';

  @Matches(/^\d{1,12}$/)
  sceneId!: string;
}

export class IgnoreDuplicatesDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @Matches(/^\d{1,12}$/, { each: true })
  sceneIds!: string[];
}

export class MergeEntitiesDto {
  @IsString()
  @Matches(/^\d{1,12}$/)
  keepId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Matches(/^\d{1,12}$/, { each: true })
  mergeIds!: string[];
}

export class MergeTagsDto {
  @IsString()
  @MaxLength(64)
  destinationId!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  sourceIds!: string[];
}
