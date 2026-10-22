import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type {
  StashJob,
  StashLibraryTask,
} from '../providers/stash/stash.adapter';
import {
  CreateMarkerDto,
  DeleteSceneQueryDto,
  DuplicatesQueryDto,
  SamplesQueryDto,
  FIX_KINDS,
  FixKind,
  FixScenesQueryDto,
  IdentifyScenesDto,
  LocalBulkScenesDto,
  LIBRARY_TASKS,
  FavoriteDto,
  LocalScenesQueryDto,
  SceneWatchedDto,
  TagSearchQueryDto,
  UpdateLocalSceneDto,
} from './dto/local-library.dto';
import {
  LocalBulkResultDto,
  LocalLibraryService,
  LocalPerformerDto,
  LocalSceneCardDto,
  DuplicateGroupDto,
  SampleSceneDto,
  FixCountsDto,
  LocalScenePageDto,
  LocalSearchDto,
  LocalStudioDto,
} from './local-library.service';
import { RequiresPlayback } from './playback-feature.guard';
import { LocalSceneDetailsDto } from './playback.service';

/** Your own Stash library: organize scenes, related scenes, performer and studio pages. */
@Controller('api/local')
export class LocalLibraryController {
  constructor(private readonly library: LocalLibraryService) {}

  @Patch('scenes/:sceneId')
  updateScene(
    @Param('sceneId') sceneId: string,
    @Body() body: UpdateLocalSceneDto,
  ): Promise<LocalSceneDetailsDto> {
    return this.library.updateScene(sceneId, {
      rating100: body.rating100,
      organized: body.organized,
      tagIds: body.tagIds,
    });
  }

  /** Mark organized, remove or delete many scenes at once. */
  @Post('scenes/bulk')
  @HttpCode(200)
  bulkScenes(@Body() body: LocalBulkScenesDto): Promise<LocalBulkResultDto> {
    return this.library.bulkScenes(body.action, body.sceneIds);
  }

  @Post('scenes/:sceneId/watched')
  setWatched(
    @Param('sceneId') sceneId: string,
    @Body() body: SceneWatchedDto,
  ): Promise<LocalSceneDetailsDto> {
    return this.library.setWatched(sceneId, body.watched);
  }

  @Post('scenes/:sceneId/markers')
  addMarker(
    @Param('sceneId') sceneId: string,
    @Body() body: CreateMarkerDto,
  ): Promise<LocalSceneDetailsDto> {
    return this.library.addMarker(sceneId, {
      title: body.title.trim(),
      seconds: body.seconds,
      primaryTagId: body.primaryTagId,
    });
  }

  @Delete('scenes/:sceneId/markers/:markerId')
  deleteMarker(
    @Param('sceneId') sceneId: string,
    @Param('markerId') markerId: string,
  ): Promise<LocalSceneDetailsDto> {
    return this.library.deleteMarker(sceneId, markerId);
  }

  @Post('scenes/:sceneId/clear-resume')
  @HttpCode(204)
  async clearResume(@Param('sceneId') sceneId: string): Promise<void> {
    await this.library.clearResume(sceneId);
  }

  @RequiresPlayback('feed')
  @Get('feed')
  feed(@Query() query: LocalScenesQueryDto): Promise<LocalScenePageDto> {
    return this.library.feed(query.page, query.seed);
  }

  @Get('fix/counts')
  fixCounts(): Promise<FixCountsDto> {
    return this.library.fixCounts();
  }

  @Get('fix/:kind')
  fixScenes(
    @Param('kind') kind: string,
    @Query() query: FixScenesQueryDto,
  ): Promise<LocalScenePageDto> {
    if (!(FIX_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException('Unknown list.');
    }
    return this.library.fixScenes(kind as FixKind, query.page, query.offset);
  }

  @Post('identify')
  identify(@Body() body: IdentifyScenesDto): Promise<{ jobId: string | null }> {
    return this.library.identify(body.sceneIds);
  }

  @Get('jobs')
  jobs(): Promise<StashJob[]> {
    return this.library.jobs();
  }

  @Post('jobs/:task')
  startJob(@Param('task') task: string): Promise<{ jobId: string | null }> {
    if (!(LIBRARY_TASKS as readonly string[]).includes(task)) {
      throw new BadRequestException('Unknown task.');
    }
    return this.library.startJob(task as StashLibraryTask);
  }

  @Delete('jobs/:jobId')
  @HttpCode(204)
  async stopJob(@Param('jobId') jobId: string): Promise<void> {
    await this.library.stopJob(jobId);
  }

  @Get('duplicates')
  duplicates(@Query() query: DuplicatesQueryDto): Promise<DuplicateGroupDto[]> {
    return this.library.duplicates(query.accuracy ?? 'exact');
  }

  @Get('samples')
  samples(@Query() query: SamplesQueryDto): Promise<SampleSceneDto[]> {
    return this.library.samples(Number(query.shorterThan ?? '0'));
  }

  @Delete('scenes/:sceneId')
  @HttpCode(204)
  async deleteScene(
    @Param('sceneId') sceneId: string,
    @Query() query: DeleteSceneQueryDto,
  ): Promise<void> {
    await this.library.deleteScene(sceneId, query.deleteFile === 'true');
  }

  @Get('search')
  search(@Query() query: TagSearchQueryDto): Promise<LocalSearchDto> {
    return this.library.search(query.query ?? '');
  }

  @Get('scenes/:sceneId/related')
  related(@Param('sceneId') sceneId: string): Promise<LocalSceneCardDto[]> {
    return this.library.related(sceneId);
  }

  @Get('performers/:performerId')
  performer(
    @Param('performerId') performerId: string,
  ): Promise<LocalPerformerDto> {
    return this.library.performer(performerId);
  }

  @Get('performers/:performerId/scenes')
  performerScenes(
    @Param('performerId') performerId: string,
    @Query() query: LocalScenesQueryDto,
  ): Promise<LocalScenePageDto> {
    return this.library.performerScenes(
      performerId,
      query.page,
      query.sort,
      query.seed,
    );
  }

  @Put('performers/:performerId/favorite')
  setPerformerFavorite(
    @Param('performerId') performerId: string,
    @Body() body: FavoriteDto,
  ): Promise<LocalPerformerDto> {
    return this.library.setPerformerFavorite(performerId, body.favorite);
  }

  @Get('studios/:studioId')
  studio(@Param('studioId') studioId: string): Promise<LocalStudioDto> {
    return this.library.studio(studioId);
  }

  @Get('studios/:studioId/scenes')
  studioScenes(
    @Param('studioId') studioId: string,
    @Query() query: LocalScenesQueryDto,
  ): Promise<LocalScenePageDto> {
    return this.library.studioScenes(
      studioId,
      query.page,
      query.sort,
      query.seed,
    );
  }

  @Put('studios/:studioId/favorite')
  setStudioFavorite(
    @Param('studioId') studioId: string,
    @Body() body: FavoriteDto,
  ): Promise<LocalStudioDto> {
    return this.library.setStudioFavorite(studioId, body.favorite);
  }

  @Get('tags')
  searchTags(
    @Query() query: TagSearchQueryDto,
  ): Promise<Array<{ id: string; name: string }>> {
    return this.library.searchTags(query.query ?? '');
  }
}
