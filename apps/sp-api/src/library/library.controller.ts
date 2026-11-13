import { Controller, Get, Query } from '@nestjs/common';
import { LibraryService } from './library.service';
import { LibraryOptionsQueryDto } from './dto/library-options-query.dto';
import {
  type LibraryPerformersDto,
  LibraryPerformersQueryDto,
} from './dto/library-performers.dto';
import { LibraryScenesFeedDto } from './dto/library-scenes-feed.dto';
import { LibraryScenesQueryDto } from './dto/library-scenes-query.dto';
import { LibraryStudioOptionDto } from './dto/library-studio-option.dto';
import { LibraryTagOptionDto } from './dto/library-tag-option.dto';

@Controller('api/library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get('scenes')
  getLibraryScenes(
    @Query() query: LibraryScenesQueryDto,
  ): Promise<LibraryScenesFeedDto> {
    return this.libraryService.getScenesFeed(
      query.page,
      query.perPage,
      query.sort,
      query.direction,
      query.query,
      query.tagIds,
      query.tagMode,
      query.studioIds,
      query.favoritePerformersOnly,
      query.favoriteStudiosOnly,
      query.favoriteTagsOnly,
    );
  }

  @Get('tags')
  getLibraryTags(
    @Query() query: LibraryOptionsQueryDto,
  ): Promise<LibraryTagOptionDto[]> {
    return this.libraryService.searchTags(query.query, {
      performerId: query.performerId,
      studioId: query.studioId,
    });
  }

  /** Everyone in your own scenes, most scenes first. */
  @Get('performers')
  getLibraryPerformers(
    @Query() query: LibraryPerformersQueryDto,
  ): Promise<LibraryPerformersDto> {
    return this.libraryService.listPerformers(
      query.query,
      query.page,
      query.perPage,
    );
  }

  @Get('studios')
  getLibraryStudios(
    @Query() query: LibraryOptionsQueryDto,
  ): Promise<LibraryStudioOptionDto[]> {
    return this.libraryService.searchStudios(query.query, {
      performerId: query.performerId,
      studioId: query.studioId,
    });
  }
}
