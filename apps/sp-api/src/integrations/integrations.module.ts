import { Module } from '@nestjs/common';
import { CatalogController } from '../catalog/catalog.controller';
import { StashModule } from '../providers/stash/stash.module';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { ProwlarrModule } from '../providers/prowlarr/prowlarr.module';
import { SabnzbdModule } from '../providers/sabnzbd/sabnzbd.module';
import { RuntimeHealthModule } from '../runtime-health/runtime-health.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { RuntimeHealthRefreshController } from './runtime-health-refresh.controller';

@Module({
  imports: [
    StashModule,
    StashdbModule,
    WhisparrModule,
    ProwlarrModule,
    SabnzbdModule,
    RuntimeHealthModule,
  ],
  controllers: [
    IntegrationsController,
    RuntimeHealthRefreshController,
    CatalogController,
  ],
  providers: [IntegrationsService, CatalogProviderService],
  exports: [IntegrationsService, CatalogProviderService],
})
export class IntegrationsModule {}
