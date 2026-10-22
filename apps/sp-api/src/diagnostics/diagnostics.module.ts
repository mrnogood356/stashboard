import { Module } from '@nestjs/common';
import { DownloadHandoffModule } from '../download-handoff/download-handoff.module';
import { OrganizerModule } from '../organizer/organizer.module';
import { SabnzbdModule } from '../providers/sabnzbd/sabnzbd.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { SceneEvidenceController } from './scene-evidence.controller';
import { SceneEvidenceService } from './scene-evidence.service';
import { SceneTimelineController } from './scene-timeline.controller';
import { SceneTimelineService } from './scene-timeline.service';

/**
 * The plain facts behind a scene's state, for "Why is it like this?", and
 * the simple story of its request (the timeline).
 */
@Module({
  imports: [
    OrganizerModule,
    DownloadHandoffModule,
    WhisparrModule,
    SabnzbdModule,
  ],
  controllers: [SceneEvidenceController, SceneTimelineController],
  providers: [SceneEvidenceService, SceneTimelineService],
})
export class DiagnosticsModule {}
