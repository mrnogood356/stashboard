import { Module } from '@nestjs/common';
import { HiddenContentModule } from '../hidden-content/hidden-content.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StashModule } from '../providers/stash/stash.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { SceneStatusModule } from '../scene-status/scene-status.module';
import { ScenesModule } from '../scenes/scenes.module';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';

@Module({
  imports: [
    HiddenContentModule,
    IntegrationsModule,
    StashModule,
    StashdbModule,
    SceneStatusModule,
    ScenesModule,
  ],
  controllers: [SuggestionsController],
  providers: [SuggestionsService],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
