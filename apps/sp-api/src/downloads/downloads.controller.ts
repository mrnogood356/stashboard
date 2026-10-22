import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { GrabDownloadDto } from './dto/grab-download.dto';
import { ReleaseSearchQueryDto } from './dto/release-search-query.dto';
import { DownloadsService } from './downloads.service';

/** "Find downloads": releases of a scene through Prowlarr. */
@Controller('api/downloads')
export class DownloadsController {
  constructor(private readonly downloadsService: DownloadsService) {}

  @Get('status')
  getStatus() {
    return this.downloadsService.getStatus();
  }

  @Get('scenes/:sceneId/releases')
  searchReleases(
    @Param('sceneId') sceneId: string,
    @Query() query: ReleaseSearchQueryDto,
  ) {
    return this.downloadsService.searchReleases(
      sceneId,
      query.provider,
      query.q,
    );
  }

  @Post('scenes/:sceneId/releases')
  grabRelease(
    @Param('sceneId') sceneId: string,
    @Body() body: GrabDownloadDto,
  ) {
    return this.downloadsService.grabRelease(
      sceneId,
      {
        guid: body.guid,
        indexerId: body.indexerId,
        title: body.title ?? null,
        indexer: body.indexer ?? null,
      },
      body.provider,
    );
  }
}
