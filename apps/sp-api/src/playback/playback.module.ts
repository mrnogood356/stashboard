import { Module } from '@nestjs/common';
import { OrganizerModule } from '../organizer/organizer.module';
import { StashModule } from '../providers/stash/stash.module';
import { LocalLibraryController } from './local-library.controller';
import { LocalLibraryService } from './local-library.service';
import { PlaybackFeatureGuard } from './playback-feature.guard';
import { PlaybackSettingsController } from './playback-settings.controller';
import { PlaybackSettingsService } from './playback-settings.service';
import { PlaybackTokenService } from './playback-token.service';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';

@Module({
  imports: [StashModule, OrganizerModule],
  controllers: [
    PlaybackSettingsController,
    PlaybackController,
    LocalLibraryController,
  ],
  providers: [
    PlaybackService,
    PlaybackTokenService,
    LocalLibraryService,
    PlaybackSettingsService,
    PlaybackFeatureGuard,
  ],
  exports: [LocalLibraryService, PlaybackSettingsService],
})
export class PlaybackModule {}
