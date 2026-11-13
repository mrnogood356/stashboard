export type LibrarySceneSort =
  | 'CREATED_AT'
  | 'UPDATED_AT'
  | 'TITLE'
  | 'RELEASE_DATE'
  | 'PRODUCTION_DATE';

export type LibrarySortDirection = 'ASC' | 'DESC';
export type LibraryTagMatchMode = 'OR' | 'AND';

export interface LibraryTagOption {
  id: string;
  name: string;
  /** How many of your scenes have it. */
  count?: number;
}

export interface LibraryStudioOption {
  id: string;
  name: string;
  /** How many of your scenes are from it. */
  count?: number;
}

export interface LibrarySceneItem {
  id: string;
  activeCatalogSceneId: string | null;
  title: string;
  description: string | null;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
  performerNames: string[];
  releaseDate: string | null;
  duration: number | null;
  /** When it was filmed (Stash 0.32 and later). */
  productionDate?: string | null;
  /** The main file's picture size, for its quality (4K, 1080p…). */
  width?: number | null;
  height?: number | null;
  localCreatedAt: string | null;
  type: 'SCENE';
  source: 'STASH';
  viewUrl: string;
}

export interface LibraryScenesFeedResponse {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  latestSyncAt: string | null;
  items: LibrarySceneItem[];
}
