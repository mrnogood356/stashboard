import { Module } from '@nestjs/common';
import { DownloadHandoffModule } from '../download-handoff/download-handoff.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProwlarrModule } from '../providers/prowlarr/prowlarr.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { DownloadsController } from './downloads.controller';
import { DownloadsService } from './downloads.service';

@Module({
  imports: [
    IntegrationsModule,
    ProwlarrModule,
    StashdbModule,
    DownloadHandoffModule,
  ],
  controllers: [DownloadsController],
  providers: [DownloadsService],
})
export class DownloadsModule {}
