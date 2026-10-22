import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  AcquisitionBulkDto,
  AcquisitionBulkResultDto,
} from './dto/acquisition-bulk.dto';
import { AcquisitionScenesFeedDto } from './dto/acquisition-scene-feed.dto';
import { AcquisitionScenesQueryDto } from './dto/acquisition-scenes-query.dto';
import { AcquisitionService } from './acquisition.service';

@Controller('api/acquisition')
export class AcquisitionController {
  constructor(private readonly acquisitionService: AcquisitionService) {}

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

  /** Search again for, or remove, many waiting scenes at once. */
  @Post('bulk')
  @HttpCode(200)
  runBulkAction(
    @Body() body: AcquisitionBulkDto,
  ): Promise<AcquisitionBulkResultDto> {
    return this.acquisitionService.runBulkAction(body.action, body.ids);
  }
}
