import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  HOME_RAIL_SCENE_LIMIT_MAX,
  HOME_RAIL_SCENE_LIMIT_MIN,
  HOME_ROW_DEVICE_VALUES,
  HOME_ROW_SIZE_VALUES,
  HOME_ROW_STYLE_VALUES,
  type HomeRowDevices,
  type HomeRowSize,
  type HomeRowStyle,
} from './home-rail.dto';

/** A change to how one row looks; fields left out keep their value. */
export class UpdateHomeRowDisplayDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  title?: string | null;

  @IsOptional()
  @IsIn(HOME_ROW_SIZE_VALUES)
  size?: HomeRowSize;

  @IsOptional()
  @IsIn(HOME_ROW_STYLE_VALUES)
  style?: HomeRowStyle;

  @IsOptional()
  @IsBoolean()
  showStudio?: boolean;

  @IsOptional()
  @IsBoolean()
  showDate?: boolean;

  @IsOptional()
  @IsBoolean()
  showDuration?: boolean;

  @IsOptional()
  @IsBoolean()
  showActions?: boolean;

  @IsOptional()
  @IsIn(HOME_ROW_DEVICE_VALUES)
  devices?: HomeRowDevices;

  @IsOptional()
  @IsBoolean()
  seeAll?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(HOME_RAIL_SCENE_LIMIT_MIN)
  @Max(HOME_RAIL_SCENE_LIMIT_MAX)
  limit?: number | null;
}

export const HOME_ROW_GALLERY_IDS = [
  'CONTINUE_WATCHING',
  'RECENTLY_ADDED_LIBRARY',
  'UNWATCHED_LIBRARY',
  'MOST_PLAYED_LIBRARY',
  'STILL_WAITING',
  'FAVORITE_STUDIOS',
  'FAVORITE_PERFORMERS',
  'REDISCOVER',
  'TOP_RATED',
  'QUICK_PICKS',
  'LIBRARY_4K',
  'COMING_SOON',
  'NEW_FROM_FAVORITE_PERFORMERS',
  'NEW_RELEASES',
  'TRENDING',
] as const;
export type HomeRowGalleryId = (typeof HOME_ROW_GALLERY_IDS)[number];

/** A ready-made row "Add a row" offers. */
export class HomeRowGalleryItemDto {
  id!: HomeRowGalleryId;
  title!: string;
  description!: string;
  /** Where its scenes come from. */
  from!: 'library' | 'catalog' | 'whisparr' | 'requests';
  /** On Home already (a one-of-a-kind row that's shown). */
  added!: boolean;
  /** Can be added more than once (it's a starting point for your own row). */
  repeatable!: boolean;
}
