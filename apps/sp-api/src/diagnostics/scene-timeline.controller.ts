import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import {
  SceneTimelineDto,
  SceneTimelinesDto,
  TIMELINE_BATCH_LIMIT,
} from './scene-timeline.model';
import { SceneTimelineService } from './scene-timeline.service';

export class SceneTimelinesQueryDto {
  @IsArray()
  @ArrayMaxSize(TIMELINE_BATCH_LIMIT)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  ids!: string[];
}

/** Where a request is: the plain story next to "Why is it like this?". */
@Controller('api/scenes')
export class SceneTimelineController {
  constructor(private readonly timeline: SceneTimelineService) {}

  /** The short version for many scenes (a page of Acquisition cards). */
  @Post('timelines')
  @HttpCode(200)
  async scenes(
    @Body() body: SceneTimelinesQueryDto,
  ): Promise<SceneTimelinesDto> {
    return { items: await this.timeline.forScenes(body.ids) };
  }

  /** The whole story for one catalog scene. */
  @Get(':stashId/timeline')
  scene(@Param('stashId') stashId: string): Promise<SceneTimelineDto> {
    return this.timeline.forScene(stashId);
  }
}
