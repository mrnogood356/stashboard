import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { DownloadDropInService } from './download-drop-in.service';
import { DownloadHandoffService } from './download-handoff.service';
import { UpdateDownloadHandoffDto } from './dto/update-download-handoff.dto';

/** Finished downloads: SABnzbd's downloads moved into the library. */
@Controller('api/downloads/handoff')
export class DownloadHandoffController {
  constructor(
    private readonly handoff: DownloadHandoffService,
    private readonly dropInService: DownloadDropInService,
  ) {}

  @Get()
  settings() {
    return this.handoff.getSettingsDto();
  }

  @Put()
  update(@Body() body: UpdateDownloadHandoffDto) {
    return this.handoff.updateSettings({
      enabled: body.enabled,
      category: body.category,
      destination: body.destination,
      sabPathFrom: body.sabPathFrom,
      sabPathTo: body.sabPathTo,
      importMode: body.importMode,
      dropIns: body.dropIns,
    });
  }

  @Get('recent')
  recent() {
    return this.handoff.recent();
  }

  /** Videos brought in from SABnzbd's category folder, newest first. */
  @Get('drop-ins')
  dropIns() {
    return this.dropInService.recent();
  }

  @Post(':id/ignore')
  @HttpCode(200)
  ignore(@Param('id') id: string) {
    return this.handoff.ignore(id);
  }
}
