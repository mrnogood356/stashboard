import { Module } from '@nestjs/common';
import { ProwlarrModule } from '../providers/prowlarr/prowlarr.module';
import { SabnzbdModule } from '../providers/sabnzbd/sabnzbd.module';
import { StashModule } from '../providers/stash/stash.module';
import { StashdbModule } from '../providers/stashdb/stashdb.module';
import { WhisparrModule } from '../providers/whisparr/whisparr.module';
import { RuntimeHealthModule } from '../runtime-health/runtime-health.module';
import { AboutController } from './about.controller';
import { AboutService } from './about.service';
import { ReleaseNotesService } from './release-notes.service';
import { UpdateCheckService } from './update-check.service';

/**
 * Settings → About & health: version, update check, health, recent errors;
 * and the release notes "What's new" shows after an update.
 */
@Module({
  imports: [
    StashModule,
    StashdbModule,
    WhisparrModule,
    ProwlarrModule,
    SabnzbdModule,
    RuntimeHealthModule,
  ],
  controllers: [AboutController],
  providers: [AboutService, UpdateCheckService, ReleaseNotesService],
})
export class AboutModule {}
