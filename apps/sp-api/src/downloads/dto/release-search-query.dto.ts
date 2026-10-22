import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  CATALOG_PROVIDER_KEYS,
  type CatalogProviderKey,
} from '../../providers/catalog/catalog-provider.util';

/** Which catalog the scene id belongs to; the instance's own when left out. */
export class ReleaseSearchQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn(CATALOG_PROVIDER_KEYS)
  provider?: CatalogProviderKey;

  /** Your own words to search for, instead of the ones built from the scene. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q?: string;
}
