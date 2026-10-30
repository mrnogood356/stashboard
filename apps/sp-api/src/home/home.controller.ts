import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CreateHomeRailDto,
  UpdateHomeRailDto,
} from './dto/create-home-rail.dto';
import { HomeRailContentDto } from './dto/home-rail-content.dto';
import { HomeRailDto } from './dto/home-rail.dto';
import {
  HOME_ROW_GALLERY_IDS,
  type HomeRowGalleryId,
  HomeRowGalleryItemDto,
  UpdateHomeRowDisplayDto,
} from './dto/home-row-display.dto';
import { UpdateHomeRailsDto } from './dto/update-home-rails.dto';
import { HomeAttentionDto } from './dto/home-attention.dto';
import { HomeAttentionService } from './home-attention.service';
import { HomeService } from './home.service';
import { SceneTagOptionDto } from '../scenes/dto/scene-tag-option.dto';
import { PerformerStudioOptionDto } from '../performers/dto/performer-studio-option.dto';

@Controller('api/home')
export class HomeController {
  constructor(
    private readonly homeService: HomeService,
    private readonly attention: HomeAttentionService,
  ) {}

  /** Counts for the "Needs you" card; a count is null when its source is down. */
  @Get('attention')
  getAttention(): Promise<HomeAttentionDto> {
    return this.attention.getAttention();
  }

  @Get('rails')
  getRails(): Promise<HomeRailDto[]> {
    return this.homeService.getRails();
  }

  @Get('stash/tags')
  searchStashTags(
    @Query('query') query?: string,
  ): Promise<SceneTagOptionDto[]> {
    return this.homeService.searchStashTags(query);
  }

  @Get('stash/studios')
  searchStashStudios(
    @Query('query') query?: string,
  ): Promise<PerformerStudioOptionDto[]> {
    return this.homeService.searchStashStudios(query);
  }

  @Get('rails/:id/items')
  getRailContent(@Param('id') id: string): Promise<HomeRailContentDto> {
    return this.homeService.getRailContent(id);
  }

  /** The ready-made rows "Add a row" offers. */
  @Get('rails/gallery')
  getRowGallery(): Promise<HomeRowGalleryItemDto[]> {
    return this.homeService.getRowGallery();
  }

  @Post('rails/gallery/:presetId')
  addGalleryRow(@Param('presetId') presetId: string): Promise<HomeRailDto> {
    if (!(HOME_ROW_GALLERY_IDS as readonly string[]).includes(presetId)) {
      throw new BadRequestException('There’s no such ready-made row.');
    }
    return this.homeService.addGalleryRow(presetId as HomeRowGalleryId);
  }

  /** How one row looks: its name, card size and style, details, devices. */
  @Patch('rails/:id/display')
  updateRowDisplay(
    @Param('id') id: string,
    @Body() payload: UpdateHomeRowDisplayDto,
  ): Promise<HomeRailDto> {
    return this.homeService.updateRowDisplay(id, payload);
  }

  @Put('rails')
  updateRails(@Body() payload: UpdateHomeRailsDto): Promise<HomeRailDto[]> {
    return this.homeService.updateRails(payload);
  }

  @Post('rails')
  createRail(@Body() payload: CreateHomeRailDto): Promise<HomeRailDto> {
    return this.homeService.createRail(payload);
  }

  @Patch('rails/:id')
  updateRail(
    @Param('id') id: string,
    @Body() payload: UpdateHomeRailDto,
  ): Promise<HomeRailDto> {
    return this.homeService.updateRail(id, payload);
  }

  @Delete('rails/:id')
  async deleteRail(@Param('id') id: string): Promise<void> {
    await this.homeService.deleteRail(id);
  }
}
