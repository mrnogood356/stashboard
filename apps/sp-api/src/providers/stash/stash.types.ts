import { type CatalogProviderKey } from '../catalog/catalog-provider.util';

export interface StashAdapterBaseConfig {
  baseUrl: string;
  apiKey?: string | null;
}

export interface StashSceneMatch {
  id: string;
  width: number | null;
  height: number | null;
  viewUrl: string;
  label: string;
}

/** A library scene that looks like a catalog scene you're about to request. */
export interface StashSceneCopy {
  id: string;
  title: string | null;
  date: string | null;
  studioName: string | null;
  /** Its first file. */
  path: string | null;
  /** That file's length in seconds, when Stash knows it. */
  duration?: number | null;
  /** Changes when the screenshot does; null when there is none. */
  screenshotVersion: string | null;
}

export const STASH_SCENE_FEED_SORT_VALUES = [
  'CREATED_AT',
  'UPDATED_AT',
  'TITLE',
] as const;
export type StashSceneFeedSort = (typeof STASH_SCENE_FEED_SORT_VALUES)[number];

export const STASH_SCENE_FEED_DIRECTION_VALUES = ['ASC', 'DESC'] as const;
export type StashSceneFeedDirection =
  (typeof STASH_SCENE_FEED_DIRECTION_VALUES)[number];
export const STASH_SCENE_FEED_TAG_MODE_VALUES = ['OR', 'AND'] as const;
export type StashSceneFeedTagMode =
  (typeof STASH_SCENE_FEED_TAG_MODE_VALUES)[number];

export interface StashLocalSceneFeedConfig {
  page: number;
  perPage: number;
  sort: StashSceneFeedSort;
  direction: StashSceneFeedDirection;
  titleQuery?: string | null;
  tagIds?: string[];
  tagMode?: StashSceneFeedTagMode | null;
  studioIds?: string[];
  favoritePerformersOnly?: boolean;
  favoriteStudiosOnly?: boolean;
  favoriteTagsOnly?: boolean;
}

export interface StashLocalLibraryScenePageConfig {
  page: number;
  perPage: number;
}

export interface StashLinkedSceneStashId {
  endpoint: string;
  stashId: string;
}

export interface StashLocalLibrarySceneItem {
  id: string;
  activeCatalogSceneId: string | null;
  /**
   * Stash lists at least one file for it. A scene can be linked to StashDB
   * with no file (made by hand or by a plugin), which isn't in the library.
   */
  hasFile: boolean;
  linkedCatalogRefs: string[];
  title: string;
  description: string | null;
  imageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
  performerIds: string[];
  performerNames: string[];
  tagIds: string[];
  tagNames: string[];
  releaseDate: string | null;
  duration: number | null;
  viewUrl: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  hasFavoritePerformer: boolean;
  favoriteStudio: boolean;
  hasFavoriteTag: boolean;
}

export interface StashLocalLibraryScenePage {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  items: StashLocalLibrarySceneItem[];
}

export interface StashSceneMatchOverlayConfig {
  providerKey?: CatalogProviderKey | null;
  favoritePerformersOnly?: boolean;
  favoriteStudiosOnly?: boolean;
  favoriteTagsOnly?: boolean;
}

export interface StashSceneMarker {
  id: string;
  title: string;
  seconds: number;
}

/** A Stash scene as shown on a card (library grids, related scenes). */
export interface StashLocalSceneCard {
  id: string;
  title: string;
  date: string | null;
  /** Changes when the screenshot does; null when there is none. */
  screenshotVersion: string | null;
  studio: { id: string; name: string; imageVersion: string | null } | null;
  duration: number | null;
  playCount: number;
  resumeTime: number;
}

export interface StashJob {
  id: string;
  status: string;
  description: string;
  progress: number | null;
  subTasks: string[];
  addTime: string | null;
  startTime: string | null;
}

export interface StashDuplicateScene {
  id: string;
  title: string;
  date: string | null;
  /** Changes when the screenshot does; null when there is none. */
  screenshotVersion: string | null;
  studio: string | null;
  playCount: number;
  organized: boolean;
  file: {
    path: string | null;
    basename: string | null;
    size: number | null;
    width: number | null;
    height: number | null;
    duration: number | null;
    videoCodec: string | null;
    bitRate: number | null;
    frameRate: number | null;
  } | null;
}

export type StashLibraryTask =
  'scan' | 'generate' | 'identify' | 'auto-tag' | 'clean';

export interface StashLocalScenePage {
  total: number;
  items: StashLocalSceneCard[];
}

export interface StashLocalPerformer {
  id: string;
  name: string;
  disambiguation: string | null;
  gender: string | null;
  birthdate: string | null;
  country: string | null;
  details: string | null;
  favorite: boolean;
  imageVersion: string | null;
  sceneCount: number;
}

export interface StashLocalStudio {
  id: string;
  name: string;
  favorite: boolean;
  imageVersion: string | null;
  sceneCount: number;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
}

export interface StashLocalSceneUpdate {
  rating100?: number | null;
  organized?: boolean;
  tagIds?: string[];
}

export interface StashLocalSceneDetails {
  id: string;
  title: string;
  code: string | null;
  details: string | null;
  date: string | null;
  rating100: number | null;
  oCounter: number;
  playCount: number;
  resumeTime: number;
  organized: boolean;
  /** Changes when the screenshot does; null when there is none. */
  screenshotVersion: string | null;
  studio: { id: string; name: string; imageVersion: string | null } | null;
  performers: Array<{
    id: string;
    name: string;
    gender: string | null;
    favorite: boolean;
    imageVersion: string | null;
  }>;
  tags: Array<{ id: string; name: string }>;
  markers: StashSceneMarker[];
  files: Array<{
    basename: string | null;
    size: number | null;
    duration: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    container: string | null;
    frameRate: number | null;
    bitRate: number | null;
  }>;
  viewUrl: string;
}

export interface StashScenePlayback {
  id: string;
  title: string;
  studio: string | null;
  resumeTime: number;
  playCount: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  vttPath: string | null;
  /** Changes when the screenshot does; null when there is none. */
  screenshotVersion: string | null;
  streams: Array<{ url?: unknown; mime_type?: unknown; label?: unknown }>;
  markers: StashSceneMarker[];
  viewUrl: string;
}

export interface StashScenePlaybackRecord {
  id?: unknown;
  title?: unknown;
  resume_time?: unknown;
  play_count?: unknown;
  paths?: { screenshot?: unknown; vtt?: unknown } | null;
  studio?: { name?: unknown } | null;
  scene_markers?: unknown;
  files?: Array<{
    duration?: unknown;
    width?: unknown;
    height?: unknown;
    video_codec?: unknown;
    audio_codec?: unknown;
    format?: unknown;
  }> | null;
}

export interface StashLocalSceneFeedItem {
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
  viewUrl: string;
}

export interface StashLocalSceneFeed {
  total: number;
  items: StashLocalSceneFeedItem[];
}

export interface StashLocalTagOption {
  id: string;
  name: string;
}

export interface StashLocalStudioOption {
  id: string;
  name: string;
  childStudios: Array<{
    id: string;
    name: string;
  }>;
}

export interface StashProtectedAssetResponse {
  body: Buffer;
  contentType: string | null;
  contentLength: string | null;
  cacheControl: string | null;
}

export interface StashLocalSceneRecord {
  id?: unknown;
  title?: unknown;
  details?: unknown;
  date?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  stash_ids?: Array<{
    endpoint?: unknown;
    stash_id?: unknown;
  }> | null;
  paths?: {
    screenshot?: unknown;
  } | null;
  studio?: {
    id?: unknown;
    name?: unknown;
    image_path?: unknown;
    favorite?: unknown;
  } | null;
  performers?: Array<{
    id?: unknown;
    name?: unknown;
    favorite?: unknown;
  }> | null;
  tags?: Array<{
    id?: unknown;
    name?: unknown;
    favorite?: unknown;
  }> | null;
  files?: Array<{
    width?: unknown;
    height?: unknown;
    duration?: unknown;
  }>;
}

export interface StashSceneAssetRecord {
  id?: unknown;
  paths?: {
    screenshot?: unknown;
  } | null;
}

export interface StashStudioAssetRecord {
  id?: unknown;
  image_path?: unknown;
}

export interface StashTagRecord {
  id?: unknown;
  name?: unknown;
}

export interface StashStudioSearchRecord {
  id?: unknown;
  name?: unknown;
  parent_studio?: {
    id?: unknown;
    name?: unknown;
  } | null;
  child_studios?: Array<{
    id?: unknown;
    name?: unknown;
  }> | null;
}

export interface StashGraphqlResponse {
  data?: {
    findScenes?: {
      count?: unknown;
      scenes?: StashLocalSceneRecord[];
    };
    findScene?: StashSceneAssetRecord | null;
    findStudio?: StashStudioAssetRecord | null;
    findTags?: {
      tags?: StashTagRecord[];
    };
    findStudios?: {
      studios?: StashStudioSearchRecord[];
    };
  };
  errors?: Array<{ message?: unknown }>;
}

export interface StashOrganizerFile {
  id: string;
  path: string;
  basename: string;
  duration: number | null;
  size: number | null;
  width: number | null;
  height: number | null;
  /** Lower-case type (phash, oshash, md5) and value. */
  fingerprints: Array<{ type: string; value: string }>;
}

export interface StashOrganizerScene {
  id: string;
  title: string | null;
  code: string | null;
  date: string | null;
  organized: boolean;
  /** Changes when the screenshot does; null when there is none. */
  screenshotVersion: string | null;
  studio: { id: string; name: string } | null;
  performers: string[];
  /** The performers with their gender, for Whisparr's gendered placeholders. */
  performerDetails?: Array<{ name: string; gender: string | null }>;
  tagIds: string[];
  stashIds: Array<{ endpoint: string; stashId: string }>;
  files: StashOrganizerFile[];
  /** When Stash first scanned the scene in (ISO); absent when not asked. */
  createdAt?: string | null;
}

export interface StashSceneMatchInput {
  title: string | null;
  code: string | null;
  details: string | null;
  director: string | null;
  date: string | null;
  urls: string[];
  studioId: string | null;
  performerIds: string[];
  tagIds: string[];
  coverImageUrl: string | null;
  stashIds: Array<{ endpoint: string; stashId: string }>;
}
