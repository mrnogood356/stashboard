import type { CatalogProviderKey } from '../../providers/catalog/catalog-provider.util';
export interface StudioDetailsImageDto {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
}

export interface StudioDetailsUrlDto {
  url: string;
  type: string | null;
  siteName: string | null;
  siteUrl: string | null;
  siteIcon: string | null;
}

export interface StudioDetailsParentDto {
  id: string;
  name: string;
  aliases: string[];
  isFavorite: boolean;
  urls: StudioDetailsUrlDto[];
}

export interface StudioDetailsChildDto {
  id: string;
  name: string;
  aliases: string[];
  deleted: boolean;
  isFavorite: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  imageUrl: string | null;
}

export interface StudioDetailsDto {
  id: string;
  name: string;
  aliases: string[];
  deleted: boolean;
  isFavorite: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  imageUrl: string | null;
  images: StudioDetailsImageDto[];
  urls: StudioDetailsUrlDto[];
  parentStudio: StudioDetailsParentDto | null;
  childStudios: StudioDetailsChildDto[];
  /** The catalog it came from: the one asked, or the other when it wasn't there. */
  provider: CatalogProviderKey;
  /** Found in the other catalog, not the one the page asked: see the performer's. */
  fromOtherCatalog: boolean;
}
