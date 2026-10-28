import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DiscoverQueryDto } from '../../discover/dto/discover-query.dto';

export const ACQUISITION_LIFECYCLE_VALUES = [
  'REQUESTED',
  'DOWNLOADING',
  'IMPORT_PENDING',
  'FAILED',
] as const;

export type AcquisitionLifecycle =
  (typeof ACQUISITION_LIFECYCLE_VALUES)[number];
/** AVAILABLE: requests that reached the library in the last few days. */
export const ACQUISITION_LIFECYCLE_FILTER_VALUES = [
  'ANY',
  ...ACQUISITION_LIFECYCLE_VALUES,
  'AVAILABLE',
] as const;
export type AcquisitionLifecycleFilter =
  (typeof ACQUISITION_LIFECYCLE_FILTER_VALUES)[number];

/**
 * `status` (the default) is the pipeline order: failed first, then downloads,
 * imports and queued requests. The rest order by request time, release date
 * or title.
 */
export const ACQUISITION_SORT_VALUES = [
  'status',
  'requested-desc',
  'requested-asc',
  'released-desc',
  'released-asc',
  'title',
] as const;
export type AcquisitionSort = (typeof ACQUISITION_SORT_VALUES)[number];

export interface AcquisitionFeedOptions {
  /** Words in the title, studio or performer names (or the catalog id). */
  q?: string;
  sort?: AcquisitionSort;
}

export class AcquisitionScenesQueryDto extends DiscoverQueryDto {
  @IsOptional()
  @IsIn(ACQUISITION_LIFECYCLE_FILTER_VALUES)
  lifecycle?: AcquisitionLifecycleFilter;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(ACQUISITION_SORT_VALUES)
  sort?: AcquisitionSort;
}
