import { Module } from '@nestjs/common';
import { HiddenContentModule } from '../hidden-content/hidden-content.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { SceneStatusModule } from '../scene-status/scene-status.module';
import { PerformersController } from './performers.controller';
import { PerformersService } from './performers.service';

@Module({
  imports: [
    IntegrationsModule,
    StashdbModule,
    SceneStatusModule,
    HiddenContentModule,
  ],
  controllers: [PerformersController],
  providers: [PerformersService],
})
export class PerformersModule {}
