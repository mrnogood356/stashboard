import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateFollowDto,
  FollowedReleasesQueryDto,
  FollowLookupQueryDto,
  UpdateFollowDto,
} from './dto/follow.dto';
import {
  type FollowDto,
  type FollowedReleasesDto,
  type FollowLookupDto,
  type FollowsDto,
} from './follows.model';
import { FollowsService } from './follows.service';

@Controller('api/follows')
export class FollowsController {
  constructor(private readonly follows: FollowsService) {}

  @Get()
  list(): Promise<FollowsDto> {
    return this.follows.list();
  }

  /** Whether a performer's or studio's page shows Follow or Following. */
  @Get('lookup')
  lookup(@Query() query: FollowLookupQueryDto): Promise<FollowLookupDto> {
    return this.follows.lookup(query.kind, query.entityId);
  }

  @Get('releases')
  releases(
    @Query() query: FollowedReleasesQueryDto,
  ): Promise<FollowedReleasesDto> {
    return this.follows.releases(query.view ?? 'review', query.limit ?? 60);
  }

  @Post('releases/:sceneId/dismiss')
  @HttpCode(204)
  async dismiss(@Param('sceneId') sceneId: string): Promise<void> {
    await this.follows.dismiss(sceneId.slice(0, 64));
  }

  /** Check now: starts a check in the background unless one is running. */
  @Post('check')
  @HttpCode(202)
  check(): { started: boolean } {
    return { started: this.follows.startCheck() };
  }

  @Post()
  follow(@Body() body: CreateFollowDto): Promise<FollowDto> {
    return this.follows.follow(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateFollowDto,
  ): Promise<FollowDto> {
    return this.follows.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async unfollow(@Param('id') id: string): Promise<void> {
    await this.follows.unfollow(id);
  }
}
