import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { WatchLaterService, type WatchLaterDto } from './watch-later.service';

export class WatchLaterOrderDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids!: string[];
}

@Controller('api/watch-later')
export class WatchLaterController {
  constructor(private readonly watchLater: WatchLaterService) {}

  @Get()
  list(): Promise<WatchLaterDto> {
    return this.watchLater.list();
  }

  /** Just the ids, for showing which scenes are saved. */
  @Get('ids')
  ids(): Promise<string[]> {
    return this.watchLater.ids();
  }

  @Put('order')
  reorder(@Body() body: WatchLaterOrderDto): Promise<string[]> {
    return this.watchLater.reorder(body.ids);
  }

  @Delete()
  clear(): Promise<string[]> {
    return this.watchLater.clear();
  }

  @Post(':sceneId')
  add(@Param('sceneId') sceneId: string): Promise<string[]> {
    return this.watchLater.add(sceneId);
  }

  @Delete(':sceneId')
  remove(@Param('sceneId') sceneId: string): Promise<string[]> {
    return this.watchLater.remove(sceneId);
  }
}
