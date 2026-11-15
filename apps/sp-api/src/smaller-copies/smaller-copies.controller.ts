import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SmallerCopiesService,
  type SmallerCopiesDto,
  type SmallerCopySettingsInput,
} from './smaller-copies.service';
import {
  CODEC_RULES,
  MATCH,
  OLD_COPY,
  PREFER,
  STUDIO_MODES,
  TARGETS,
  type SmallerCopyRules,
  type Target,
} from './smaller-copies.util';

const toNumberOrNull = ({ value }: { value: unknown }) =>
  value === null || value === '' || value === undefined ? null : Number(value);

export class SmallerCopySettingsDto implements SmallerCopySettingsInput {
  @IsBoolean()
  enabled!: boolean;

  @IsIn(TARGETS)
  target!: Target;

  @IsBoolean()
  replaceHigher!: boolean;

  @IsBoolean()
  upgradeLower!: boolean;

  @Transform(toNumberOrNull)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  maxGbPerHour!: number | null;

  @Transform(toNumberOrNull)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  minGbPerHour!: number | null;

  @Transform(toNumberOrNull)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  maxNewGbPerHour!: number | null;

  @Transform(toNumberOrNull)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  minNewGbPerHour!: number | null;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  minSavingsPercent!: number;

  @IsIn(CODEC_RULES)
  codec!: SmallerCopyRules['codec'];

  @IsIn(PREFER)
  prefer!: SmallerCopyRules['prefer'];

  @IsIn(MATCH)
  matchStrength!: SmallerCopyRules['matchStrength'];

  @IsIn(STUDIO_MODES)
  studioMode!: SmallerCopyRules['studioMode'];

  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  studioNames!: string[];

  @IsBoolean()
  autoGrab!: boolean;

  @IsIn(OLD_COPY)
  oldCopy!: SmallerCopySettingsInput['oldCopy'];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  scenesPerHour!: number;

  @Transform(toNumberOrNull)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  activeFromHour!: number | null;

  @Transform(toNumberOrNull)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  activeToHour!: number | null;
}

/** Library tools → Smaller copies. */
@Controller('api/smaller-copies')
export class SmallerCopiesController {
  constructor(private readonly smaller: SmallerCopiesService) {}

  @Get()
  status(): Promise<SmallerCopiesDto> {
    return this.smaller.status();
  }

  @Put()
  save(@Body() body: SmallerCopySettingsDto): Promise<SmallerCopiesDto> {
    return this.smaller.saveSettings(body);
  }

  /** Grab a match that was listed for you. */
  @Post('scenes/:stashSceneId/grab')
  @HttpCode(200)
  grab(@Param('stashSceneId') stashSceneId: string): Promise<SmallerCopiesDto> {
    return this.smaller.grabListed(stashSceneId);
  }

  /** Look for the next scene now, without waiting for the hourly spacing. */
  @Post('next')
  @HttpCode(200)
  async next(): Promise<SmallerCopiesDto> {
    const notice = await this.smaller.tick(true);
    return { ...(await this.smaller.status()), notice };
  }
}
