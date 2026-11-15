import type { StashdbSceneFacets } from '../providers/stashdb/stashdb.types';
import { SceneFacetsService } from '../scene-facets/scene-facets.service';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { StudioDetailsDto } from './dto/studio-details.dto';
import { StudioFeedResponseDto } from './dto/studio-feed-response.dto';
import { StudiosQueryDto } from './dto/studios-query.dto';
import { StudiosService } from './studios.service';

@Controller('api/studios')
export class StudiosController {
  constructor(
    private readonly studiosService: StudiosService,
    private readonly sceneFacets: SceneFacetsService,
  ) {}

  @Get()
  getStudiosFeed(
    @Query() query: StudiosQueryDto,
  ): Promise<StudioFeedResponseDto> {
    return this.studiosService.getStudiosFeed(query.page, query.perPage, {
      name: query.name,
      sort: query.sort,
      direction: query.direction,
      favoritesOnly: query.favoritesOnly,
    });
  }

  /** Their own categories and studios, the most used first, with counts. */
  @Get(':studioId/facets')
  getStudioFacets(
    @Param('studioId') studioId: string,
  ): Promise<StashdbSceneFacets> {
    return this.sceneFacets.forStudio(studioId);
  }

  @Get(':studioId')
  getStudioById(
    @Param('studioId') studioId: string,
  ): Promise<StudioDetailsDto> {
    return this.studiosService.getStudioById(studioId);
  }
}
