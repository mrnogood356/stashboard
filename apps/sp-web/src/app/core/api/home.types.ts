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
  | 'CONTINUE_WATCHING';
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
