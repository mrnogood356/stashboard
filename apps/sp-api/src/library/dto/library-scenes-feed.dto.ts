export class LibrarySceneFeedItemDto {
  id!: string;
  activeCatalogSceneId!: string | null;
  title!: string;
  description!: string | null;
  imageUrl!: string | null;
  cardImageUrl!: string | null;
  studioId!: string | null;
  studio!: string | null;
  studioImageUrl!: string | null;
  performerNames!: string[];
  releaseDate!: string | null;
  /** When it was filmed (Stash 0.32 and later). */
  productionDate!: string | null;
  duration!: number | null;
  /** The main file's picture size, for its quality (4K, 1080p…). */
  width!: number | null;
  height!: number | null;
  localCreatedAt!: Date | null;
  type!: 'SCENE';
  source!: 'STASH';
  viewUrl!: string;
}

export class LibraryScenesFeedDto {
  total!: number;
  page!: number;
  perPage!: number;
  hasMore!: boolean;
  latestSyncAt!: Date | null;
  items!: LibrarySceneFeedItemDto[];
}
