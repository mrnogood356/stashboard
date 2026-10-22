import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StashModule } from '../providers/stash/stash.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { RequestsController } from './requests.controller';
import { OwnedCopiesService } from './owned-copies.service';
import { RequestsService } from './requests.service';

@Module({
  imports: [
    IndexingModule,
    IntegrationsModule,
    WhisparrModule,
    StashdbModule,
    StashModule,
  ],
  controllers: [RequestsController],
  providers: [RequestsService, OwnedCopiesService],
})
export class RequestsModule {}
