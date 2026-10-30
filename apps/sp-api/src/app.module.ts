import { PlaybackModule } from './playback/playback.module';
import { ActivityModule } from './activity/activity.module';
import { AutomationModule } from './automation/automation.module';
import { OrganizerModule } from './organizer/organizer.module';
import { NotificationsModule } from './notifications/notifications.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AboutModule } from './about/about.module';
import { BackupModule } from './backup/backup.module';
import { AppearanceModule } from './appearance/appearance.module';
import { AcquisitionModule } from './acquisition/acquisition.module';
import { AuthModule } from './auth/auth.module';
import { ClientLogModule } from './client-log/client-log.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { DownloadsModule } from './downloads/downloads.module';
import { HealthModule } from './health/health.module';
import { HiddenContentModule } from './hidden-content/hidden-content.module';
import { HomeModule } from './home/home.module';
import { IndexingModule } from './indexing/indexing.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { LibraryModule } from './library/library.module';
import { LogsModule } from './logs/logs.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { PerformersModule } from './performers/performers.module';
import { RequestsModule } from './requests/requests.module';
import { RuntimeHealthModule } from './runtime-health/runtime-health.module';
import { ScenesModule } from './scenes/scenes.module';
import { SetupModule } from './setup/setup.module';
import { SetupCheckModule } from './setup-check/setup-check.module';
import { StudiosModule } from './studios/studios.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ActivityModule,
    AuthModule,
    HealthModule,
    RuntimeHealthModule,
    HomeModule,
    MediaModule,
    LibraryModule,
    IndexingModule,
    AutomationModule,
    OrganizerModule,
    DiagnosticsModule,
    IntegrationsModule,
    SetupModule,
    SetupCheckModule,
    AcquisitionModule,
    ScenesModule,
    RequestsModule,
    DownloadsModule,
    PerformersModule,
    StudiosModule,
    NotificationsModule,
    HiddenContentModule,
    PlaybackModule,
    ClientLogModule,
    AboutModule,
    LogsModule,
    AppearanceModule,
    BackupModule,
  ],
})
export class AppModule {}
