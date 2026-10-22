import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import {
  CATALOG_PROVIDER_KEYS,
  type CatalogProviderKey,
} from '../../providers/catalog/catalog-provider.util';

/**
 * How a copy was found: linked to the scene in Stash, linked to a scene it
 * was merged with, the same file fingerprint, the same title, studio and
 * date, or Whisparr already has a file for it.
 */
export const OWNED_COPY_REASONS = [
  'LINKED',
  'MERGED',
  'FINGERPRINT',
  'TITLE',
  'WHISPARR',
] as const;
export type OwnedCopyReason = (typeof OWNED_COPY_REASONS)[number];

export class OwnedCopyDto {
  reason!: OwnedCopyReason;
  /** The scene in your Stash library; null for a Whisparr-only match. */
  stashSceneId!: string | null;
  title!: string | null;
  studio!: string | null;
  date!: string | null;
  /** Its file in the library. */
  path!: string | null;
  imageUrl!: string | null;
  /** Whisparr's page for the scene (WHISPARR only). */
  whisparrUrl!: string | null;
}

export class OwnedCopiesDto {
  copies!: OwnedCopyDto[];
}

/** Which catalog the scene id belongs to; the instance's own when left out. */
export class OwnedCopiesQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(CATALOG_PROVIDER_KEYS)
  provider?: CatalogProviderKey;
}
