import { Module } from '@nestjs/common';
import { HiddenContentModule } from '../hidden-content/hidden-content.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StashModule } from '../providers/stash/stash.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { SceneStatusModule } from '../scene-status/scene-status.module';
import { ScenesController } from './scenes.controller';
import { ScenesService } from './scenes.service';

@Module({
  imports: [
    IntegrationsModule,
    StashdbModule,
    SceneStatusModule,
    StashModule,
    WhisparrModule,
    HiddenContentModule,
  ],
  controllers: [ScenesController],
  providers: [ScenesService],
  exports: [ScenesService],
})
export class ScenesModule {}
