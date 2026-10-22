import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ACTIVITY_KINDS } from './activity.model';

export class ActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @IsIn(ACTIVITY_KINDS)
  kind?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
