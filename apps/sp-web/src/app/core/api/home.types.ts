import {
  SceneStatus,
  SceneFavoritesFilter,
  SceneFeedSort,
  SceneTagMatchMode,
  SceneTagOption,
  SortDirection,
} from './discover.types';
import { CatalogProviderType } from './integrations.types';

export type HomeRailKey =
  | 'FAVORITE_STUDIOS'
  | 'FAVORITE_PERFORMERS'
  | 'RECENTLY_ADDED_LIBRARY'
  | 'STILL_WAITING'
  | 'UNWATCHED_LIBRARY'
  | 'MOST_PLAYED_LIBRARY'
  | 'CONTINUE_WATCHING'
  | 'REDISCOVER'
  | 'TOP_RATED'
  | 'QUICK_PICKS'
  | 'LIBRARY_4K'
  | 'COMING_SOON';
export type HomeRailKind = 'BUILTIN' | 'CUSTOM';
export type HomeRailSource = 'STASHDB' | 'STASH';
export type HomeRailItemSource = 'STASH' | CatalogProviderType;
export type HomeRailContentType = 'SCENES';
export type HomeStashSceneSort = 'CREATED_AT' | 'UPDATED_AT' | 'TITLE';

export interface HomeStashdbSceneRailConfig {
  sort: SceneFeedSort;
  direction: SortDirection;
  favorites: SceneFavoritesFilter | null;
  tagIds: string[];
  tagNames: string[];
  tagMode: SceneTagMatchMode | null;
  studioIds: string[];
  studioNames: string[];
  limit: number;
}

export interface HomeStashSceneRailConfig {
  sort: HomeStashSceneSort;
  direction: SortDirection;
  titleQuery: string | null;
  tagIds: string[];
  tagNames: string[];
  tagMode: SceneTagMatchMode | null;
  studioIds: string[];
  studioNames: string[];
  favoritePerformersOnly: boolean;
  favoriteStudiosOnly: boolean;
  favoriteTagsOnly: boolean;
  limit: number;
}

export type HomeRowSize = 'small' | 'regular' | 'large';
/** wide: 16:9 thumbnails; poster: tall cards; spotlight: the first one big. */
export type HomeRowStyle = 'wide' | 'poster' | 'spotlight';
export type HomeRowDevices = 'all' | 'phone' | 'desktop';

/** How a Home row looks. */
export interface HomeRowDisplay {
  /** The row's own name instead of its built-in one; null keeps that. */
  title: string | null;
  size: HomeRowSize;
  style: HomeRowStyle;
  showStudio: boolean;
  showDate: boolean;
  showDuration: boolean;
  /** Request, Find and status on each card. */
  showActions: boolean;
  devices: HomeRowDevices;
  seeAll: boolean;
  /** How many scenes; null keeps the row's own count. */
  limit: number | null;
}

export const DEFAULT_HOME_ROW_DISPLAY: HomeRowDisplay = {
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

export type HomeRowGalleryId =
  HomeRailKey | 'NEW_FROM_FAVORITE_PERFORMERS' | 'NEW_RELEASES' | 'TRENDING';

/** A ready-made row "Add a row" offers. */
export interface HomeRowGalleryItem {
  id: HomeRowGalleryId;
  title: string;
  description: string;
  from: 'library' | 'catalog' | 'whisparr' | 'requests';
  /** On Home already (a one-of-a-kind row that's shown). */
  added: boolean;
  /** A starting point for a row of your own; can be added again. */
  repeatable: boolean;
}

interface BaseHomeRailConfig<TSource extends HomeRailSource, TConfig> {
  id: string;
  key: HomeRailKey | null;
  kind: HomeRailKind;
  source: TSource;
  contentType: HomeRailContentType;
  title: string;
  subtitle: string | null;
  enabled: boolean;
  sortOrder: number;
  editable: boolean;
  deletable: boolean;
  config: TConfig;
  /** Missing from rows cached before row settings existed. */
  display?: HomeRowDisplay;
}

export type HomeRailConfig =
  | BaseHomeRailConfig<'STASHDB', HomeStashdbSceneRailConfig>
  | BaseHomeRailConfig<'STASH', HomeStashSceneRailConfig>;

export interface HomeRailItem {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
  releaseDate: string | null;
  duration: number | null;
  type: 'SCENE';
  source: HomeRailItemSource;
  status: SceneStatus;
  requestable: boolean;
  viewUrl: string | null;
  /** How far through the scene playback got, 0 to 1 (Continue Watching). */
  progress?: number | null;
  /** Stash scene id for a catalog scene you already have (preview and Play). */
  localSceneId?: string | null;
}

export interface HomeRailContentResponse {
  items: HomeRailItem[];
  message: string | null;
}

export interface UpdateHomeRailsPayload {
  rails: Array<{
    id: string;
    enabled: boolean;
  }>;
}

export interface SaveHomeRailPayload {
  source: HomeRailSource;
  title: string;
  subtitle: string | null;
  enabled: boolean;
  config: HomeStashdbSceneRailConfig | HomeStashSceneRailConfig;
}

export interface HomeRailFormDraft {
  source: HomeRailSource;
  title: string;
  subtitle: string;
  enabled: boolean;
  sort: SceneFeedSort | HomeStashSceneSort;
  direction: SortDirection;
  titleQuery: string;
  favorites: SceneFavoritesFilter | 'NONE';
  tagMode: SceneTagMatchMode;
  favoritePerformersOnly: boolean;
  favoriteStudiosOnly: boolean;
  favoriteTagsOnly: boolean;
  limit: number;
  selectedTags: SceneTagOption[];
  selectedStudios: Array<{
    id: string;
    label: string;
  }>;
}

export interface HomeRailViewSummary {
  sortLabel: string;
  favoritesLabel: string;
  stashLocalFavoritesLabel: string | null;
  titleQueryLabel: string | null;
  tagCount: number;
  studioCount: number;
  limit: number;
}

/** Counts for the "Needs you" card on Home; null when that source is down. */
export interface HomeAttention {
  matchesToCheck: number | null;
  failed: number | null;
  waitingForImport: number | null;
  unmatched: number | null;
}
