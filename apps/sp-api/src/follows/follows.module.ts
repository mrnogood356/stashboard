import { Module } from '@nestjs/common';
import { HiddenContentModule } from '../hidden-content/hidden-content.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PerformersModule } from '../performers/performers.module';
import { RequestsModule } from '../requests/requests.module';
import { SceneStatusModule } from '../scene-status/scene-status.module';
import { ScenesModule } from '../scenes/scenes.module';
import { FollowsController } from './follows.controller';
import { FollowsService } from './follows.service';

/** Following performers and studios, and the scenes they release. */
@Module({
  imports: [
    HiddenContentModule,
    IntegrationsModule,
    NotificationsModule,
    PerformersModule,
    RequestsModule,
    SceneStatusModule,
    ScenesModule,
  ],
  controllers: [FollowsController],
  providers: [FollowsService],
  exports: [FollowsService],
})
export class FollowsModule {}
