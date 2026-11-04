import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  AcquisitionBulkDto,
  AcquisitionBulkResultDto,
} from './dto/acquisition-bulk.dto';
import {
  AcquisitionAttentionDto,
  AcquisitionScenesFeedDto,
} from './dto/acquisition-scene-feed.dto';
import { AcquisitionScenesQueryDto } from './dto/acquisition-scenes-query.dto';
import { AcquisitionService } from './acquisition.service';
import {
  WhisparrImportsDto,
  WhisparrImportsService,
} from './whisparr-imports.service';

@Controller('api/acquisition')
export class AcquisitionController {
  constructor(
    private readonly acquisitionService: AcquisitionService,
    private readonly whisparrImports: WhisparrImportsService,
  ) {}

  /** Finished Whisparr downloads it couldn't bring in on its own. */
  @Get('whisparr-imports')
  getWhisparrImports(): Promise<WhisparrImportsDto> {
    return this.whisparrImports.list();
  }

  /** Imports one the way Whisparr's Manual Import does. */
  @Post('whisparr-imports/:queueId/import')
  @HttpCode(200)
  importFromWhisparr(
    @Param('queueId', ParseIntPipe) queueId: number,
  ): Promise<WhisparrImportsDto> {
    return this.whisparrImports.import(queueId);
  }

  /** Takes one off Whisparr's queue; ?removeFromClient=true deletes the download too. */
  @Delete('whisparr-imports/:queueId')
  removeFromWhisparr(
    @Param('queueId', ParseIntPipe) queueId: number,
    @Query('removeFromClient', new ParseBoolPipe({ optional: true }))
    removeFromClient?: boolean,
  ): Promise<WhisparrImportsDto> {
    return this.whisparrImports.remove(queueId, removeFromClient ?? false);
  }

  @Get('scenes')
  getAcquisitionScenes(
    @Query() query: AcquisitionScenesQueryDto,
  ): Promise<AcquisitionScenesFeedDto> {
    return this.acquisitionService.getScenesFeed(
      query.page,
      query.perPage,
      query.lifecycle,
      { q: query.q, sort: query.sort },
    );
  }

  /** What needs you, for the badge on Requests in the menu. Cheap to poll. */
  @Get('attention')
  getAttention(): Promise<AcquisitionAttentionDto> {
    return this.acquisitionService.getAttention();
  }

  /** Search again for, or remove, many waiting scenes at once. */
  @Post('bulk')
  @HttpCode(200)
  runBulkAction(
    @Body() body: AcquisitionBulkDto,
  ): Promise<AcquisitionBulkResultDto> {
    return this.acquisitionService.runBulkAction(body.action, body.ids);
  }
}
