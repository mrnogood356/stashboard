import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DiscoverQueryDto } from '../../discover/dto/discover-query.dto';

export const SCENE_FEED_SORT_VALUES = [
  'DATE',
  'TRENDING',
  'TITLE',
  'CREATED_AT',
  'UPDATED_AT',
] as const;

export type SceneFeedSort = (typeof SCENE_FEED_SORT_VALUES)[number];
export const SORT_DIRECTION_VALUES = ['ASC', 'DESC'] as const;
export type SortDirection = (typeof SORT_DIRECTION_VALUES)[number];

export const SCENE_TAG_MATCH_MODE_VALUES = ['OR', 'AND'] as const;
export type SceneTagMatchMode = (typeof SCENE_TAG_MATCH_MODE_VALUES)[number];
export const SCENE_FAVORITES_FILTER_VALUES = [
  'ALL',
  'PERFORMER',
  'STUDIO',
] as const;
export type SceneFavoritesFilter =
  (typeof SCENE_FAVORITES_FILTER_VALUES)[number];

export class ScenesQueryDto extends DiscoverQueryDto {
  /** Text search in scene titles and details. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;

  /**
   * Words to leave out: scenes whose title, details, studio or tags contain
   * any of them are dropped. Comma or space separated.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return [];
    }

    const segments = Array.isArray(value) ? value : [value];
    return segments
      .flatMap((entry) =>
        typeof entry === 'string' ? entry.split(/[\s,]+/) : [String(entry)],
      )
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  })
  @IsArray()
  @ArrayMaxSize(25)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  exclude?: string[];

  @IsOptional()
  @IsIn(SCENE_FEED_SORT_VALUES)
  sort?: SceneFeedSort;

  @IsOptional()
  @IsIn(SORT_DIRECTION_VALUES)
  direction?: SortDirection;

  @IsOptional()
  @Transform(({ value }) => {
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
  })
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];

  /**
   * The tags' names, in the same order as tagIds. Tag ids belong to one
   * catalog: browsing another (FansDB with a StashDB rail's tags), the names
   * are looked up there instead. Each name is URI-encoded, so one with a comma
   * stays whole.
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null) {
      return [];
    }

    const segments = Array.isArray(value) ? value : [value];
    return segments
      .flatMap((entry) =>
        typeof entry === 'string' ? entry.split(',') : [String(entry)],
      )
      .map((entry) => {
        try {
          return decodeURIComponent(entry).trim();
        } catch {
          return entry.trim();
        }
      });
  })
  @IsArray()
  @IsString({ each: true })
  tagNames?: string[];

  @IsOptional()
  @Transform(({ value }) => {
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
  })
  @IsArray()
  @IsString({ each: true })
  studioIds?: string[];

  @IsOptional()
  @IsIn(SCENE_TAG_MATCH_MODE_VALUES)
  tagMode?: SceneTagMatchMode;

  @IsOptional()
  @IsIn(SCENE_FAVORITES_FILTER_VALUES)
  favorites?: SceneFavoritesFilter;

  /** Also show scenes Settings → Hidden content leaves out ("showHidden=1"). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === '1'
      ? true
      : value === 'false' || value === '0'
        ? false
        : value,
  )
  @IsBoolean()
  showHidden?: boolean;
}
