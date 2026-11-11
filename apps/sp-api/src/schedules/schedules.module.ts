import { Module } from '@nestjs/common';
import { FollowsModule } from '../follows/follows.module';
import { OrganizerModule } from '../organizer/organizer.module';
import { PlaybackModule } from '../playback/playback.module';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  imports: [FollowsModule, OrganizerModule, PlaybackModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
})
export class SchedulesModule {}
