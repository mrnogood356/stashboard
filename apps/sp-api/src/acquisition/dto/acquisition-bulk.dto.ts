import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
} from 'class-validator';

/** At most this many scenes per bulk action. */
export const ACQUISITION_BULK_LIMIT = 100;

/**
 * `search` has Whisparr look for the scenes again; `remove` takes them out of
 * Whisparr (files stay) so they stop waiting.
 */
export const ACQUISITION_BULK_ACTIONS = ['search', 'remove'] as const;
export type AcquisitionBulkAction = (typeof ACQUISITION_BULK_ACTIONS)[number];

export class AcquisitionBulkDto {
  @IsIn(ACQUISITION_BULK_ACTIONS)
  action!: AcquisitionBulkAction;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ACQUISITION_BULK_LIMIT)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  ids!: string[];
}

export class AcquisitionBulkFailureDto {
  id!: string;
  title!: string | null;
  reason!: string;
}

export class AcquisitionBulkResultDto {
  action!: AcquisitionBulkAction;
  done!: number;
  failed!: AcquisitionBulkFailureDto[];
}
