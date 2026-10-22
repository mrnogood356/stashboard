import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StashModule } from '../providers/stash/stash.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { WhisparrHandoffService } from './whisparr-handoff.service';
import { OrganizerController } from './organizer.controller';
import { OrganizerService } from './organizer.service';

@Module({
  imports: [
    StashModule,
    StashdbModule,
    WhisparrModule,
    IntegrationsModule,
    IndexingModule,
  ],
  controllers: [OrganizerController],
  providers: [OrganizerService, WhisparrHandoffService],
  exports: [OrganizerService],
})
export class OrganizerModule {}
