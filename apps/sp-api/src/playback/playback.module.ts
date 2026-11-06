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
import { WatchLaterController } from './watch-later.controller';
import { WatchLaterService } from './watch-later.service';

@Module({
  imports: [StashModule, OrganizerModule],
  controllers: [
    PlaybackSettingsController,
    PlaybackController,
    LocalLibraryController,
    WatchLaterController,
  ],
  providers: [
    PlaybackService,
    PlaybackTokenService,
    LocalLibraryService,
    PlaybackSettingsService,
    PlaybackFeatureGuard,
    WatchLaterService,
  ],
  exports: [LocalLibraryService, PlaybackSettingsService],
})
export class PlaybackModule {}
