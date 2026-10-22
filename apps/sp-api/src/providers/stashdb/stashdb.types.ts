export interface StashdbAdapterBaseConfig {
  baseUrl: string;
  apiKey?: string | null;
}

export interface StashdbFavoriteResult {
  favorited: boolean;
  alreadyFavorited: boolean;
}

export interface StashdbAdapterTrendingConfig extends StashdbAdapterBaseConfig {
  page: number;
  perPage: number;
}

export type StashdbSceneFeedSort =
  'DATE' | 'TRENDING' | 'TITLE' | 'CREATED_AT' | 'UPDATED_AT';
export type StashdbSortDirection = 'ASC' | 'DESC';

export interface StashdbAdapterSceneFeedConfig extends StashdbAdapterTrendingConfig {
  sort: StashdbSceneFeedSort;
  direction?: StashdbSortDirection;
  favorites?: StashdbSceneFeedFavorites;
  tagFilter?: StashdbSceneTagFilter;
  studioIds?: string[];
  /** Searches scene titles and details. */
  text?: string;
  /** Also fetch tags and performers (ids and names), for leaving out excluded words, tags and performers. */
  includeTagNames?: boolean;
}

export type StashdbSceneFeedFavorites = 'PERFORMER' | 'STUDIO' | 'ALL';

export type StashdbSceneTagFilterMode = 'OR' | 'AND';

export interface StashdbSceneTagFilter {
  tagIds: string[];
  mode: StashdbSceneTagFilterMode;
}

export interface StashdbTagSearchConfig extends StashdbAdapterBaseConfig {
  query: string;
}

export type StashdbPerformerSort =
  | 'NAME'
  | 'BIRTHDATE'
  | 'DEATHDATE'
  | 'SCENE_COUNT'
  | 'CAREER_START_YEAR'
  | 'DEBUT'
  | 'LAST_SCENE'
  | 'CREATED_AT'
  | 'UPDATED_AT';

export type StashdbPerformerGender =
  | 'MALE'
  | 'FEMALE'
  | 'UNKNOWN'
  | 'TRANSGENDER_MALE'
  | 'TRANSGENDER_FEMALE'
  | 'INTERSEX'
  | 'NON_BINARY';

export interface StashdbPerformerFeedConfig extends StashdbAdapterBaseConfig {
  page: number;
  perPage: number;
  name?: string;
  gender?: StashdbPerformerGender;
  sort?: StashdbPerformerSort;
  direction?: StashdbSortDirection;
  favoritesOnly?: boolean;
}

export interface StashdbPerformerDetails {
  id: string;
  name: string;
  disambiguation: string | null;
  aliases: string[];
  gender: StashdbPerformerGender | null;
  birthDate: string | null;
  deathDate: string | null;
  age: number | null;
  ethnicity: string | null;
  country: string | null;
  eyeColor: string | null;
  hairColor: string | null;
  height: string | null;
  cupSize: string | null;
  bandSize: number | null;
  waistSize: number | null;
  hipSize: number | null;
  breastType: string | null;
  careerStartYear: number | null;
  careerEndYear: number | null;
  deleted: boolean;
  mergedIds: string[];
  mergedIntoId: string | null;
  isFavorite: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  imageUrl: string | null;
  images: StashdbSceneImage[];
}

export interface StashdbStudioOption {
  id: string;
  name: string;
  childStudios: Array<{
    id: string;
    name: string;
  }>;
}

export type StashdbStudioFeedSort = 'NAME' | 'CREATED_AT' | 'UPDATED_AT';

export interface StashdbStudiosFeedConfig extends StashdbAdapterBaseConfig {
  page: number;
  perPage: number;
  sort?: StashdbStudioFeedSort;
  direction?: StashdbSortDirection;
  name?: string;
  favoritesOnly?: boolean;
}

export interface StashdbStudioFeedItem {
  id: string;
  name: string;
  isFavorite: boolean;
  imageUrl: string | null;
  parentStudio: {
    id: string;
    name: string;
  } | null;
  childStudios: Array<{
    id: string;
    name: string;
  }>;
}

export interface StashdbStudiosFeedResult {
  total: number;
  studios: StashdbStudioFeedItem[];
}

export interface StashdbStudioUrl {
  url: string;
  type: string | null;
  siteName: string | null;
  siteUrl: string | null;
  siteIcon: string | null;
}

export interface StashdbStudioParentSummary {
  id: string;
  name: string;
  aliases: string[];
  isFavorite: boolean;
  urls: StashdbStudioUrl[];
}

export interface StashdbStudioChildSummary {
  id: string;
  name: string;
  aliases: string[];
  deleted: boolean;
  isFavorite: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  imageUrl: string | null;
}

export interface StashdbStudioDetails {
  id: string;
  name: string;
  aliases: string[];
  deleted: boolean;
  isFavorite: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  imageUrl: string | null;
  images: StashdbSceneImage[];
  urls: StashdbStudioUrl[];
  parentStudio: StashdbStudioParentSummary | null;
  childStudios: StashdbStudioChildSummary[];
}

export interface StashdbPerformerScenesConfig extends StashdbAdapterBaseConfig {
  performerId: string;
  page: number;
  perPage: number;
  sort: StashdbSceneFeedSort;
  direction?: StashdbSortDirection;
  studioIds?: string[];
  tagIds?: string[];
  onlyFavoriteStudios?: boolean;
  /** Also fetch tags and performers (ids and names), for leaving out excluded words, tags and performers. */
  includeTagNames?: boolean;
}

export interface StashdbScene {
  id: string;
  title: string;
  details: string | null;
  imageUrl: string | null;
  studioId: string | null;
  studioName: string | null;
  studioImageUrl: string | null;
  date: string | null;
  releaseDate: string | null;
  productionDate: string | null;
  duration: number | null;
  /** Tag ids and names, when the query asked for them. */
  tagIds?: string[];
  tagNames?: string[];
  /** The scene's performers, when the query asked for tags (for hiding). */
  performers?: Array<{ id: string; name: string }>;
}

export interface StashdbSceneMetadata {
  id: string;
  title: string;
  details: string | null;
  imageUrl: string | null;
  studioId: string | null;
  studioName: string | null;
  studioImageUrl: string | null;
  releaseDate: string | null;
  duration: number | null;
  /** Performer names, when the query asked for them. */
  performerNames?: string[];
}

export interface StashdbTrendingScenesResult {
  total: number;
  scenes: StashdbScene[];
}

export interface StashdbSceneImage {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface StashdbSceneTag {
  id: string;
  name: string;
  description: string | null;
}

export interface StashdbTagOption {
  id: string;
  name: string;
  description: string | null;
  aliases: string[];
}

export interface StashdbPerformerFeedItem {
  id: string;
  name: string;
  gender: StashdbPerformerGender | null;
  sceneCount: number;
  isFavorite: boolean;
  imageUrl: string | null;
}

export interface StashdbPerformersFeedResult {
  total: number;
  performers: StashdbPerformerFeedItem[];
}

export interface StashdbScenePerformer {
  id: string;
  name: string;
  gender: string | null;
  isFavorite: boolean;
  imageUrl: string | null;
}

export interface StashdbSceneUrl {
  url: string;
  type: string | null;
}

/** A StashDB scene with everything needed to fill in a local scene. */
export interface StashdbMatchScene {
  id: string;
  title: string | null;
  code: string | null;
  details: string | null;
  director: string | null;
  date: string | null;
  duration: number | null;
  imageUrl: string | null;
  studio: { id: string; name: string; imageUrl?: string | null } | null;
  performers: Array<{
    id: string;
    name: string;
    as: string | null;
    disambiguation: string | null;
    gender: string | null;
    imageUrl?: string | null;
  }>;
  tags: Array<{ id: string; name: string }>;
  urls: string[];
}

/** A catalog scene's identity and file fingerprints, for "you already have this". */
export interface StashdbSceneFingerprints {
  id: string;
  title: string | null;
  studioName: string | null;
  date: string | null;
  /** Seconds, when the catalog knows it. */
  duration?: number | null;
  fingerprints: Array<{
    hash: string;
    algorithm: 'PHASH' | 'OSHASH' | 'MD5';
    submissions: number;
  }>;
}

export const STASHDB_MATCH_SCENE_FIELDS = `
  id title details date release_date code duration director
  urls { url }
  images { id url width height }
  studio { id name images { url } }
  performers { as performer { id name disambiguation gender images { url } } }
  tags { id name }
`;

export interface StashdbSceneDetails extends StashdbSceneMetadata {
  images: StashdbSceneImage[];
  studioIsFavorite: boolean;
  tags: StashdbSceneTag[];
  performers: StashdbScenePerformer[];
  sourceUrls: StashdbSceneUrl[];
}

export type StashdbSceneMetadataSource = {
  id?: unknown;
  title?: unknown;
  details?: unknown;
  date?: unknown;
  release_date?: unknown;
  production_date?: unknown;
  duration?: unknown;
  images?: Array<{
    id?: unknown;
    url?: unknown;
    width?: unknown;
    height?: unknown;
  }>;
  studio?: {
    id?: unknown;
    name?: unknown;
    is_favorite?: unknown;
    images?: Array<{
      id?: unknown;
      url?: unknown;
      width?: unknown;
      height?: unknown;
    }>;
  } | null;
  performers?: Array<{
    as?: unknown;
    performer?: { name?: unknown } | null;
  } | null> | null;
};

export interface StashdbGraphqlResponse {
  data?: {
    queryScenes?: {
      count?: unknown;
      scenes?: Array<{
        id?: unknown;
        title?: unknown;
        details?: unknown;
        date?: unknown;
        release_date?: unknown;
        production_date?: unknown;
        images?: Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>;
        studio?: {
          id?: unknown;
          name?: unknown;
          images?: Array<{
            id?: unknown;
            url?: unknown;
            width?: unknown;
            height?: unknown;
          }>;
        } | null;
        duration?: unknown;
      }>;
    };
    queryTags?: {
      tags?: Array<{
        id?: unknown;
        name?: unknown;
        description?: unknown;
        aliases?: unknown;
      }>;
    };
    queryPerformers?: {
      count?: unknown;
      performers?: Array<{
        id?: unknown;
        name?: unknown;
        gender?: unknown;
        scene_count?: unknown;
        is_favorite?: unknown;
        images?: Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>;
      }>;
    };
    queryStudios?: {
      count?: unknown;
      studios?: Array<{
        id?: unknown;
        name?: unknown;
        is_favorite?: unknown;
        images?: Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>;
        parent?: {
          id?: unknown;
          name?: unknown;
        } | null;
        child_studios?: Array<{
          id?: unknown;
          name?: unknown;
        }>;
      }>;
    };
    findPerformer?: {
      id?: unknown;
      name?: unknown;
      disambiguation?: unknown;
      aliases?: unknown;
      gender?: unknown;
      birth_date?: unknown;
      death_date?: unknown;
      age?: unknown;
      ethnicity?: unknown;
      country?: unknown;
      eye_color?: unknown;
      hair_color?: unknown;
      height?: unknown;
      cup_size?: unknown;
      band_size?: unknown;
      waist_size?: unknown;
      hip_size?: unknown;
      breast_type?: unknown;
      career_start_year?: unknown;
      career_end_year?: unknown;
      deleted?: unknown;
      merged_ids?: unknown;
      merged_into_id?: unknown;
      is_favorite?: unknown;
      created?: unknown;
      updated?: unknown;
      images?: Array<{
        id?: unknown;
        url?: unknown;
        width?: unknown;
        height?: unknown;
      }>;
    } | null;
    findStudio?: {
      id?: unknown;
      name?: unknown;
      aliases?: unknown;
      deleted?: unknown;
      is_favorite?: unknown;
      created?: unknown;
      updated?: unknown;
      urls?: Array<{
        url?: unknown;
        type?: unknown;
        site?: {
          name?: unknown;
          url?: unknown;
          icon?: unknown;
        } | null;
      }>;
      parent?: {
        id?: unknown;
        name?: unknown;
        aliases?: unknown;
        is_favorite?: unknown;
        urls?: Array<{
          url?: unknown;
          type?: unknown;
          site?: {
            name?: unknown;
            url?: unknown;
            icon?: unknown;
          } | null;
        }>;
      } | null;
      child_studios?: Array<{
        id?: unknown;
        name?: unknown;
        aliases?: unknown;
        deleted?: unknown;
        is_favorite?: unknown;
        created?: unknown;
        updated?: unknown;
        urls?: Array<{
          url?: unknown;
          type?: unknown;
          site?: {
            name?: unknown;
            url?: unknown;
            icon?: unknown;
          } | null;
        }>;
        images?: Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>;
      }>;
      images?: Array<{
        id?: unknown;
        url?: unknown;
        width?: unknown;
        height?: unknown;
      }>;
    } | null;
    findScene?: {
      id?: unknown;
      title?: unknown;
      details?: unknown;
      date?: unknown;
      release_date?: unknown;
      production_date?: unknown;
      duration?: unknown;
      images?: Array<{
        id?: unknown;
        url?: unknown;
        width?: unknown;
        height?: unknown;
      }>;
      tags?: Array<{
        id?: unknown;
        name?: unknown;
        description?: unknown;
      }>;
      studio?: {
        id?: unknown;
        name?: unknown;
        is_favorite?: unknown;
        images?: Array<{
          id?: unknown;
          url?: unknown;
          width?: unknown;
          height?: unknown;
        }>;
      } | null;
      urls?: Array<{
        url?: unknown;
        type?: unknown;
      }>;
      performers?: Array<{
        performer?: {
          id?: unknown;
          name?: unknown;
          gender?: unknown;
          is_favorite?: unknown;
          images?: Array<{
            id?: unknown;
            url?: unknown;
            width?: unknown;
            height?: unknown;
          }>;
        } | null;
      }>;
    } | null;
    favoritePerformer?: unknown;
    favoriteStudio?: unknown;
  };
  errors?: Array<{
    message?: unknown;
    path?: unknown;
  }>;
}
