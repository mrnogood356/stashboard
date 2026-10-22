import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import {
  LogFileParamsDto,
  LogQueryDto,
  type LogSettingsResponse,
  UpdateLogSettingsDto,
} from './dto/logs.dto';
import {
  type LogFilesResponse,
  type LogsResponse,
  LogsService,
} from './logs.service';

/** Settings → Logs. Signed-in admins only, like everything not marked public. */
@Controller('api/logs')
export class LogsController {
  constructor(private readonly logs: LogsService) {}

  /** Newest first; `level` is the minimum level shown. */
  @Get()
  list(@Query() query: LogQueryDto): LogsResponse {
    return this.logs.query(query);
  }

  @Get('contexts')
  contexts(): string[] {
    return this.logs.contexts();
  }

  /** Empties the in-memory log; the files are kept. */
  @Delete()
  @HttpCode(204)
  clear(): void {
    this.logs.clear();
  }

  @Get('files')
  files(): Promise<LogFilesResponse> {
    return this.logs.files();
  }

  @Get('files/:name')
  async download(
    @Param() params: LogFileParamsDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const path = await this.logs.filePath(params.name);
    response.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(createReadStream(path), {
      type: 'text/plain; charset=utf-8',
      disposition: `attachment; filename="${params.name}"`,
    });
  }

  @Get('settings')
  settings(): Promise<LogSettingsResponse> {
    return this.logs.settings();
  }

  @Put('settings')
  updateSettings(
    @Body() body: UpdateLogSettingsDto,
  ): Promise<LogSettingsResponse> {
    return this.logs.updateSettings(body);
  }
}
