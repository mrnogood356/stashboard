import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { DownloadDropInService } from './download-drop-in.service';
import { DownloadHandoffService } from './download-handoff.service';
import { DownloadProcessingService } from './download-processing.service';

/** The Processing page: downloads and drop-ins on their way into the library. */
@Controller('api/downloads/processing')
export class DownloadProcessingController {
  constructor(
    private readonly processing: DownloadProcessingService,
    private readonly handoff: DownloadHandoffService,
    private readonly dropIns: DownloadDropInService,
  ) {}

  @Get()
  snapshot() {
    return this.processing.snapshot();
  }

  /** Looks at the drop-in folder now; answers with everything, as GET does. */
  @Post('drop-ins/check')
  @HttpCode(200)
  async checkDropIns() {
    await this.dropIns.checkNow();
    return this.processing.snapshot();
  }

  @Post('drop-ins/:id/retry')
  @HttpCode(200)
  async retryDropIn(@Param('id') id: string) {
    const kept = await this.dropIns.retry(id);
    if (!kept) {
      // Forgotten so it's picked up again: look for it straight away.
      await this.dropIns.checkNow();
    }
    return this.processing.snapshot();
  }

  @Post('handoffs/:id/retry')
  @HttpCode(200)
  async retryHandoff(@Param('id') id: string) {
    await this.handoff.retry(id);
    return this.processing.snapshot();
  }
}
