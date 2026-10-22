import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ReleaseSearchQueryDto } from './release-search-query.dto';

/** The release to download, from a search a moment ago. */
export class GrabDownloadDto extends ReleaseSearchQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  guid!: string;

  @IsInt()
  @Min(0)
  indexerId!: number;

  /** For the activity log only. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  title?: string;

  /** For the activity log only. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  indexer?: string;
}
