import type { SimilarTagGroup } from './tag-cleanup.util';
import type { LibraryStatsDto } from './library-stats.util';
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
  MergeTagsDto,
  MergeEntitiesDto,
  IgnoreDuplicatesDto,
  ChaptersQueryDto,
  MergeQueryDto,
  LocalBulkScenesDto,
  LIBRARY_TASKS,
  FavoriteDto,
  LocalScenesQueryDto,
  SceneWatchedDto,
  TagSearchQueryDto,
  UpdateLocalSceneDto,
} from './dto/local-library.dto';
import {
  ChapterDto,
  MergeCandidatesDto,
  LocalBulkResultDto,
  LocalLibraryService,
  LocalPerformerDto,
  LocalSceneCardDto,
  DuplicateGroupDto,
  ProblemListDto,
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

  /** Generate for some scenes only (Broken files). */
  @Post('generate')
  generate(@Body() body: IdentifyScenesDto): Promise<{ jobId: string | null }> {
    return this.library.generateFor(body.sceneIds);
  }

  @Get('tags/similar')
  similarTags(): Promise<SimilarTagGroup[]> {
    return this.library.similarTags();
  }

  @Post('tags/merge')
  @HttpCode(204)
  async mergeTags(@Body() body: MergeTagsDto): Promise<void> {
    await this.library.mergeTags(body.destinationId, body.sourceIds);
  }

  @Get('problems')
  problems(@Query('refresh') refresh?: string): Promise<ProblemListDto[]> {
    return this.library.problems(refresh === '1' || refresh === 'true');
  }

  @Delete('jobs/:jobId')
  @HttpCode(204)
  async stopJob(@Param('jobId') jobId: string): Promise<void> {
    await this.library.stopJob(jobId);
  }

  @Get('stats')
  stats(@Query('refresh') refresh?: string): Promise<LibraryStatsDto> {
    return this.library.stats(refresh === '1' || refresh === 'true');
  }

  @Post('duplicates/ignore')
  @HttpCode(204)
  async ignoreDuplicates(@Body() body: IgnoreDuplicatesDto): Promise<void> {
    await this.library.ignoreDuplicates(body.sceneIds);
  }

  @Get('duplicates/ignored')
  async ignoredDuplicates(): Promise<{ count: number }> {
    return { count: await this.library.ignoredDuplicateCount() };
  }

  @Delete('duplicates/ignored')
  @HttpCode(204)
  async clearIgnoredDuplicates(): Promise<void> {
    await this.library.clearIgnoredDuplicates();
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
    if (query.carryTo) {
      // Nothing is removed if carrying the details over fails.
      await this.library.carryDetails(sceneId, query.carryTo);
    }
    await this.library.deleteScene(
      sceneId,
      query.deleteFile === 'true',
      query.onlyFile === 'true',
    );
  }

  @Get('search')
  search(@Query() query: TagSearchQueryDto): Promise<LocalSearchDto> {
    return this.library.search(query.query ?? '');
  }

  /** Performers or studios entered more than once, and names matching `q`. */
  @Get('merge/:kind')
  mergeCandidates(
    @Param('kind') kind: string,
    @Query() query: MergeQueryDto,
  ): Promise<MergeCandidatesDto> {
    return this.library.mergeCandidates(mergeKind(kind), query.q);
  }

  @Post('merge/:kind')
  @HttpCode(204)
  async merge(
    @Param('kind') kind: string,
    @Body() body: MergeEntitiesDto,
  ): Promise<void> {
    await this.library.merge(mergeKind(kind), body.keepId, body.mergeIds);
  }

  /** Chapters across the library, by tag, performer or words. */
  @Get('chapters')
  chapters(@Query() query: ChaptersQueryDto): Promise<ChapterDto[]> {
    return this.library.chapters({
      tagId: query.tag,
      performerId: query.performer,
      query: query.q,
    });
  }

  @Get('chapters/tags')
  chapterTags(): Promise<Array<{ id: string; name: string; count: number }>> {
    return this.library.chapterTags();
  }

  /** What you've played, latest first. */
  @Get('history')
  history(@Query('page') page?: string): Promise<LocalScenePageDto> {
    return this.library.history(Number(page) || 1);
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

function mergeKind(kind: string): 'performer' | 'studio' {
  if (kind === 'performers' || kind === 'performer') {
    return 'performer';
  }
  if (kind === 'studios' || kind === 'studio') {
    return 'studio';
  }
  throw new BadRequestException('Merge performers or studios.');
}
