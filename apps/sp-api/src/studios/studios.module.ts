import { SceneFacetsService } from '../scene-facets/scene-facets.service';
import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { StudiosController } from './studios.controller';
import { StudiosService } from './studios.service';

@Module({
  imports: [IntegrationsModule, StashdbModule],
  controllers: [StudiosController],
  providers: [SceneFacetsService, StudiosService],
})
export class StudiosModule {}
