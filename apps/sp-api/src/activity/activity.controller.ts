import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ActivityQueryDto } from './activity.dto';
import type {
  ActivityEntryDto,
  ActivityFilesDto,
  ActivityPageDto,
} from './activity.model';
import { ActivityService } from './activity.service';

@Controller('api/activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(@Query() query: ActivityQueryDto): Promise<ActivityPageDto> {
    return this.activity.list({
      page: query.page,
      kind: query.kind,
      q: query.q,
    });
  }

  @Get(':id/files')
  files(
    @Param('id') id: string,
    @Query('page') page?: string,
  ): Promise<ActivityFilesDto> {
    return this.activity.files(id, Number(page ?? '1'));
  }

  @Post(':id/undo')
  undo(@Param('id') id: string): Promise<ActivityEntryDto> {
    return this.activity.undo(id);
  }
}
