import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { OrganizerModule } from '../organizer/organizer.module';
import { StashModule } from '../providers/stash/stash.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { ProwlarrModule } from '../providers/prowlarr/prowlarr.module';
import { SabnzbdModule } from '../providers/sabnzbd/sabnzbd.module';
import { SetupCheckController } from './setup-check.controller';
import { SetupCheckService } from './setup-check.service';

@Module({
  imports: [
    StashModule,
    WhisparrModule,
    ProwlarrModule,
    SabnzbdModule,
    IntegrationsModule,
    OrganizerModule,
  ],
  controllers: [SetupCheckController],
  providers: [SetupCheckService],
})
export class SetupCheckModule {}
