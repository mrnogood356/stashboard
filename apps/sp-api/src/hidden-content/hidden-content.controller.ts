import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import {
  HiddenContentSettingsDto,
  HideItemDto,
  UnhideItemDto,
  UpdateHiddenContentSettingsDto,
} from './dto/hidden-content-settings.dto';
import { HiddenContentService } from './hidden-content.service';

/**
 * Settings → Hidden: words, tags, studios and performers hidden from catalog
 * lists. Signed-in admins only, like everything not marked public.
 */
@Controller('api/hidden-content')
export class HiddenContentController {
  constructor(private readonly hiddenContentService: HiddenContentService) {}

  @Get('settings')
  getSettings(): Promise<HiddenContentSettingsDto> {
    return this.hiddenContentService.getSettings();
  }

  @Put('settings')
  updateSettings(
    @Body() body: UpdateHiddenContentSettingsDto,
  ): Promise<HiddenContentSettingsDto> {
    return this.hiddenContentService.updateSettings(body);
  }

  /** "Hide this studio" from a scene, studio or performer page. */
  @Post('hide')
  @HttpCode(200)
  hide(@Body() body: HideItemDto): Promise<HiddenContentSettingsDto> {
    return this.hiddenContentService.hideItem(body.kind, {
      id: body.id,
      name: body.name,
    });
  }

  /** "Stop hiding" from the same places. */
  @Post('unhide')
  @HttpCode(200)
  unhide(@Body() body: UnhideItemDto): Promise<HiddenContentSettingsDto> {
    return this.hiddenContentService.unhideItem(body.kind, body.id);
  }
}
