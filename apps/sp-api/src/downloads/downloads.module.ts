import { Module } from '@nestjs/common';
import { DownloadHandoffModule } from '../download-handoff/download-handoff.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProwlarrModule } from '../providers/prowlarr/prowlarr.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { DownloadsController } from './downloads.controller';
import { DownloadsService } from './downloads.service';
import { StashModule } from '../providers/stash/stash.module';
import { SmallerCopiesController } from '../smaller-copies/smaller-copies.controller';
import { SmallerCopiesService } from '../smaller-copies/smaller-copies.service';

@Module({
  imports: [
    IntegrationsModule,
    ProwlarrModule,
    StashdbModule,
    DownloadHandoffModule,
    StashModule,
  ],
  controllers: [DownloadsController, SmallerCopiesController],
  providers: [DownloadsService, SmallerCopiesService],
  exports: [SmallerCopiesService],
})
export class DownloadsModule {}
