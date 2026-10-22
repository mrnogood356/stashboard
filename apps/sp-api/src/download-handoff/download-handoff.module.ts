import { Module } from '@nestjs/common';
import { OrganizerModule } from '../organizer/organizer.module';
import { SabnzbdModule } from '../providers/sabnzbd/sabnzbd.module';
import { StashModule } from '../providers/stash/stash.module';
import { DownloadDropInService } from './download-drop-in.service';
import { DownloadHandoffController } from './download-handoff.controller';
import { DownloadHandoffService } from './download-handoff.service';
import { DownloadProcessingController } from './download-processing.controller';
import { DownloadProcessingService } from './download-processing.service';

/** Finished downloads: SABnzbd → your Stash library, linked and renamed. */
@Module({
  imports: [SabnzbdModule, StashModule, OrganizerModule],
  controllers: [DownloadHandoffController, DownloadProcessingController],
  providers: [
    DownloadHandoffService,
    DownloadDropInService,
    DownloadProcessingService,
  ],
  exports: [DownloadHandoffService],
})
export class DownloadHandoffModule {}
