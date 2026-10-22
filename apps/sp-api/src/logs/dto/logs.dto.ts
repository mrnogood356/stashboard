import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LOG_FILE_PATTERN } from '../../logging/log-file-writer';
import { LOG_LEVELS, type StashboardLogLevel } from '../../logging/log-levels';

export class LogQueryDto {
  /** Minimum level: "warn" gives warnings and errors. */
  @IsOptional()
  @IsIn(LOG_LEVELS)
  level?: StashboardLogLevel;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  context?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Entries older than this id, for "Load older". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

export class LogFileParamsDto {
  /** stashboard.txt or a rotated stashboard.N.txt; nothing else, so no other file can be read. */
  @IsString()
  @Matches(LOG_FILE_PATTERN, { message: 'Not a log file name.' })
  name!: string;
}

export class UpdateLogSettingsDto {
  @IsIn(LOG_LEVELS)
  level!: StashboardLogLevel;

  @IsBoolean()
  fileEnabled!: boolean;
}

export interface LogSettingsResponse {
  level: StashboardLogLevel;
  fileEnabled: boolean;
  /** True once saved here; until then LOG_LEVEL / LOG_FILE apply. */
  saved: boolean;
  /** The level the environment sets (LOG_LEVEL), used until one is saved. */
  envLevel: StashboardLogLevel;
  /** Folder the log files go in, or null when files can't be written. */
  fileDirectory: string | null;
  /** Why log files can't be written right now, if they can't. */
  fileError: string | null;
}
