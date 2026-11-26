import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { SabnzbdModule } from '../providers/sabnzbd/sabnzbd.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { AcquisitionController } from './acquisition.controller';
import { AcquisitionService } from './acquisition.service';
import { WhisparrImportsService } from './whisparr-imports.service';

@Module({
  imports: [IndexingModule, IntegrationsModule, SabnzbdModule, WhisparrModule],
  controllers: [AcquisitionController],
  providers: [AcquisitionService, WhisparrImportsService],
  exports: [AcquisitionService],
})
export class AcquisitionModule {}
