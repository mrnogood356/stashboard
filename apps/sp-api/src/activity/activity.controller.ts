import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ActivityQueryDto } from './activity.dto';
import type { ActivityEntryDto, ActivityPageDto } from './activity.model';
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

  @Post(':id/undo')
  undo(@Param('id') id: string): Promise<ActivityEntryDto> {
    return this.activity.undo(id);
  }
}
