import {
  SCENE_FAVORITES_FILTER_VALUES,
  SCENE_FEED_SORT_VALUES,
  SCENE_TAG_MATCH_MODE_VALUES,
  SORT_DIRECTION_VALUES,
  type SceneFavoritesFilter,
  type SceneFeedSort,
  type SceneTagMatchMode,
  type SortDirection,
} from '../../scenes/dto/scenes-query.dto';

export const HOME_RAIL_KEY_VALUES = [
  'FAVORITE_STUDIOS',
  'FAVORITE_PERFORMERS',
  'RECENTLY_ADDED_LIBRARY',
  'STILL_WAITING',
  'UNWATCHED_LIBRARY',
  'MOST_PLAYED_LIBRARY',
  'CONTINUE_WATCHING',
  'REDISCOVER',
  'TOP_RATED',
  'QUICK_PICKS',
  'LIBRARY_4K',
  'COMING_SOON',
] as const;
export type HomeRailKey = (typeof HOME_RAIL_KEY_VALUES)[number];

export const HOME_RAIL_KIND_VALUES = ['BUILTIN', 'CUSTOM'] as const;
export type HomeRailKind = (typeof HOME_RAIL_KIND_VALUES)[number];

export const HOME_RAIL_SOURCE_VALUES = ['STASHDB', 'STASH'] as const;
export type HomeRailSource = (typeof HOME_RAIL_SOURCE_VALUES)[number];

export const HOME_RAIL_CONTENT_TYPE_VALUES = ['SCENES'] as const;
export type HomeRailContentType =
  (typeof HOME_RAIL_CONTENT_TYPE_VALUES)[number];

export const HOME_RAIL_SCENE_LIMIT_MIN = 6;
export const HOME_RAIL_SCENE_LIMIT_MAX = 30;
export const HOME_RAIL_SCENE_LIMIT_DEFAULT = 16;

export const HOME_RAIL_STASHDB_SCENE_SORT_VALUES = SCENE_FEED_SORT_VALUES;
export const HOME_RAIL_STASH_SCENE_SORT_VALUES = [
  'CREATED_AT',
  'UPDATED_AT',
  'TITLE',
] as const;
export const HOME_RAIL_DIRECTION_VALUES = SORT_DIRECTION_VALUES;
export const HOME_RAIL_FAVORITES_VALUES = SCENE_FAVORITES_FILTER_VALUES;
export const HOME_RAIL_TAG_MODE_VALUES = SCENE_TAG_MATCH_MODE_VALUES;

export type HomeRailStashdbSceneSort = SceneFeedSort;
export type HomeRailStashSceneSort =
  (typeof HOME_RAIL_STASH_SCENE_SORT_VALUES)[number];
export type HomeRailDirection = SortDirection;
export type HomeRailFavorites = SceneFavoritesFilter;
export type HomeRailTagMode = SceneTagMatchMode;

export class HomeRailStashdbSceneConfigDto {
  sort!: HomeRailStashdbSceneSort;
  direction!: HomeRailDirection;
  favorites!: HomeRailFavorites | null;
  tagIds!: string[];
  tagNames!: string[];
  tagMode!: HomeRailTagMode | null;
  studioIds!: string[];
  studioNames!: string[];
  limit!: number;
}

export class HomeRailStashSceneConfigDto {
  sort!: HomeRailStashSceneSort;
  direction!: HomeRailDirection;
  titleQuery!: string | null;
  tagIds!: string[];
  tagNames!: string[];
  tagMode!: HomeRailTagMode | null;
  studioIds!: string[];
  studioNames!: string[];
  favoritePerformersOnly!: boolean;
  favoriteStudiosOnly!: boolean;
  favoriteTagsOnly!: boolean;
  limit!: number;
}

export type HomeRailSceneConfigDto =
  HomeRailStashdbSceneConfigDto | HomeRailStashSceneConfigDto;

export const HOME_ROW_SIZE_VALUES = ['small', 'regular', 'large'] as const;
export type HomeRowSize = (typeof HOME_ROW_SIZE_VALUES)[number];
/** wide: 16:9 thumbnails; poster: tall cards; spotlight: the first one big. */
export const HOME_ROW_STYLE_VALUES = ['wide', 'poster', 'spotlight'] as const;
export type HomeRowStyle = (typeof HOME_ROW_STYLE_VALUES)[number];
export const HOME_ROW_DEVICE_VALUES = ['all', 'phone', 'desktop'] as const;
export type HomeRowDevices = (typeof HOME_ROW_DEVICE_VALUES)[number];

/** How a Home row looks. Saved per row; every field has a default. */
export class HomeRowDisplayDto {
  /** The row's own name, instead of its built-in one; null keeps that. */
  title!: string | null;
  size!: HomeRowSize;
  style!: HomeRowStyle;
  showStudio!: boolean;
  showDate!: boolean;
  showDuration!: boolean;
  /** Request, Find and status on each card. */
  showActions!: boolean;
  devices!: HomeRowDevices;
  seeAll!: boolean;
  /** How many scenes; null keeps the row's own count. */
  limit!: number | null;
}

export const DEFAULT_HOME_ROW_DISPLAY: HomeRowDisplayDto = {
  title: null,
  size: 'regular',
  style: 'wide',
  showStudio: true,
  showDate: true,
  showDuration: false,
  showActions: true,
  devices: 'all',
  seeAll: true,
  limit: null,
};

export class HomeRailDto {
  id!: string;
  key!: HomeRailKey | null;
  kind!: HomeRailKind;
  source!: HomeRailSource;
  contentType!: HomeRailContentType;
  title!: string;
  subtitle!: string | null;
  enabled!: boolean;
  sortOrder!: number;
  editable!: boolean;
  deletable!: boolean;
  config!: HomeRailSceneConfigDto;
  display!: HomeRowDisplayDto;
}
