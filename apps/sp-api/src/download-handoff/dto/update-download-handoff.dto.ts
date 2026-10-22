import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Finished downloads settings; anything left out stays as it is. */
export class UpdateDownloadHandoffDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  /** Empty clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  destination?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sabPathFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sabPathTo?: string;

  @IsOptional()
  @IsIn(['move', 'copy'])
  importMode?: 'move' | 'copy';

  @IsOptional()
  @IsBoolean()
  dropIns?: boolean;

  /** Also bring in downloads added to the category in SABnzbd by hand. */
  @IsOptional()
  @IsBoolean()
  sabManualJobs?: boolean;
}
