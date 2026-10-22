import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  type PlaybackSettingsResponse,
  UpdatePlaybackSettingsDto,
} from './dto/playback-settings.dto';
import { PlaybackSettingsService } from './playback-settings.service';

/** Settings → Playback. Signed-in admins only, like everything not marked public. */
@Controller('api/playback/settings')
export class PlaybackSettingsController {
  constructor(private readonly settings: PlaybackSettingsService) {}

  @Get()
  get(): Promise<PlaybackSettingsResponse> {
    return this.settings.get();
  }

  @Put()
  update(
    @Body() body: UpdatePlaybackSettingsDto,
  ): Promise<PlaybackSettingsResponse> {
    return this.settings.update(body);
  }
}
