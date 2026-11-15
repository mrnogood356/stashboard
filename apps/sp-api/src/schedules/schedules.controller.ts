import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { SCHEDULED_JOBS, type ScheduledJob } from './schedules.util';
import { SchedulesService, type SchedulesDto } from './schedules.service';

export class UpdateScheduleDto {
  @IsBoolean()
  enabled!: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(23)
  hour!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(59)
  minute!: number;

  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days!: number[];
}

/** One job's times, as Settings → Backup keeps them. */
export class ScheduleBackupItemDto extends UpdateScheduleDto {
  @IsIn(SCHEDULED_JOBS)
  job!: ScheduledJob;
}

export class SchedulesBackupDto {
  @IsArray()
  @ArrayMaxSize(SCHEDULED_JOBS.length)
  @ValidateNested({ each: true })
  @Type(() => ScheduleBackupItemDto)
  schedules!: ScheduleBackupItemDto[];
}

/** Library tools → Schedules. */
@Controller('api/schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(): Promise<SchedulesDto> {
    return this.schedules.list();
  }

  @Put(':job')
  update(
    @Param('job') job: string,
    @Body() body: UpdateScheduleDto,
  ): Promise<SchedulesDto> {
    return this.schedules.update(job, body);
  }
}
