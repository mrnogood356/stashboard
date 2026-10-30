import { Module } from '@nestjs/common';
import { AcquisitionModule } from '../acquisition/acquisition.module';
import { HiddenContentModule } from '../hidden-content/hidden-content.module';
import { HybridScenesModule } from '../hybrid-scenes/hybrid-scenes.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LibraryModule } from '../library/library.module';
import { OrganizerModule } from '../organizer/organizer.module';
import { PlaybackModule } from '../playback/playback.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StashModule } from '../providers/stash/stash.module';
import { SceneStatusModule } from '../scene-status/scene-status.module';
import { ScenesModule } from '../scenes/scenes.module';
import { HomeController } from './home.controller';
import { HomeAttentionService } from './home-attention.service';
import { HomeService } from './home.service';

@Module({
  imports: [
    AcquisitionModule,
    PrismaModule,
    LibraryModule,
    IntegrationsModule,
    SceneStatusModule,
    HybridScenesModule,
    HiddenContentModule,
    StashModule,
    OrganizerModule,
    PlaybackModule,
    ScenesModule,
  ],
  controllers: [HomeController],
  providers: [HomeService, HomeAttentionService],
})
export class HomeModule {}
