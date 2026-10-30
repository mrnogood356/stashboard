import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { BackupService, RestoreResponse } from './backup.service';

export class ExportQueryDto {
  /** Leave API keys, tokens and webhook links out of the file. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  secrets?: boolean;
}

/** Settings → Backup. */
@Controller('api/backup')
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  @Get()
  async export(
    @Query() query: ExportQueryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.backup.export(query.secrets ?? true);
    const day = file.exportedAt.slice(0, 10);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="stashboard-settings-${day}.json"`,
    );
    return file;
  }

  /** The backup file is the body, as is (checked by the service, not a DTO). */
  @Post('restore')
  @HttpCode(200)
  restore(@Body() body: unknown): Promise<RestoreResponse> {
    return this.backup.restore(body);
  }
}
