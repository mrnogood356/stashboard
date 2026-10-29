import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ScenesCalendarQueryDto,
  ScenesCalendarResponseDto,
} from './dto/scenes-calendar.dto';
import { SceneTagOptionDto } from './dto/scene-tag-option.dto';
import { SceneDetailsDto } from './dto/scene-details.dto';
import { ScenesFeedResponseDto } from './dto/scenes-feed.dto';
import { ScenesQueryDto } from './dto/scenes-query.dto';
import { ScenesTagsQueryDto } from './dto/scenes-tags-query.dto';
import { ToggleFavoriteDto } from './dto/toggle-favorite.dto';
import { ScenesService } from './scenes.service';

@Controller('api/scenes')
export class ScenesController {
  constructor(private readonly scenesService: ScenesService) {}

  @Get()
  getScenesFeed(
    @Query() query: ScenesQueryDto,
  ): Promise<ScenesFeedResponseDto> {
    return this.scenesService.getScenesFeed(
      query.page,
      query.perPage,
      query.sort,
      query.direction,
      query.tagIds,
      query.tagMode,
      query.favorites,
      query.studioIds,
      query.query,
      query.exclude,
      query.tagNames,
      query.showHidden,
    );
  }

  /** Calendar: releases from your starred studios and performers between two days. */
  @Get('calendar')
  getCalendar(
    @Query() query: ScenesCalendarQueryDto,
  ): Promise<ScenesCalendarResponseDto> {
    const from = Date.parse(`${query.from}T00:00:00Z`);
    const to = Date.parse(`${query.to}T00:00:00Z`);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) {
      throw new BadRequestException(
        'Choose a from day on or before the to day.',
      );
    }
    if (to - from > 62 * 24 * 60 * 60 * 1000) {
      throw new BadRequestException('A calendar view covers at most 62 days.');
    }
    return this.scenesService.getCalendar(
      query.from,
      query.to,
      query.favorites ?? 'ALL',
    );
  }

  @Get('tags')
  getSceneTagOptions(
    @Query() query: ScenesTagsQueryDto,
  ): Promise<SceneTagOptionDto[]> {
    return this.scenesService.searchSceneTags(query.query);
  }

  @Post('studios/:studioId/favorite')
  favoriteStudio(
    @Param('studioId') studioId: string,
    @Body() body: ToggleFavoriteDto,
  ): Promise<{ favorited: boolean; alreadyFavorited: boolean }> {
    return this.scenesService.favoriteStudio(studioId, body.favorite);
  }

  @Get(':stashId')
  getSceneById(@Param('stashId') stashId: string): Promise<SceneDetailsDto> {
    return this.scenesService.getSceneById(stashId);
  }
}
