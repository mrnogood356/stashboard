import { DownloadsModule } from '../downloads/downloads.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { Module } from '@nestjs/common';
import { AppearanceModule } from '../appearance/appearance.module';
import { AutomationModule } from '../automation/automation.module';
import { DownloadHandoffModule } from '../download-handoff/download-handoff.module';
import { FollowsModule } from '../follows/follows.module';
import { HiddenContentModule } from '../hidden-content/hidden-content.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { LogsModule } from '../logs/logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrganizerModule } from '../organizer/organizer.module';
import { PlaybackModule } from '../playback/playback.module';
import { BackupController } from './backup.controller';
import { BackupService } from './backup.service';

/** Settings → Backup: every setting as one file, and restoring it. */
@Module({
  imports: [
    AppearanceModule,
    AutomationModule,
    DownloadHandoffModule,
    DownloadsModule,
    FollowsModule,
    HiddenContentModule,
    IntegrationsModule,
    LogsModule,
    NotificationsModule,
    OrganizerModule,
    PlaybackModule,
    SchedulesModule,
  ],
  controllers: [BackupController],
  providers: [BackupService],
})
export class BackupModule {}
