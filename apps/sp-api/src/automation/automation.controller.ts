import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { AutomationService, AutomationSettingsDto } from './automation.service';

export class UpdateAutomationDto {
  @IsOptional()
  @IsBoolean()
  scanOnImport?: boolean;

  @IsOptional()
  @IsBoolean()
  identifyNew?: boolean;

  @IsOptional()
  @IsBoolean()
  generateNew?: boolean;

  @IsOptional()
  @IsBoolean()
  removeSamples?: boolean;

  @IsOptional()
  @IsBoolean()
  watchFolders?: boolean;

  @IsOptional()
  @IsBoolean()
  tidyAfterImport?: boolean;
}

@Controller('api/automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get()
  get(): Promise<AutomationSettingsDto> {
    return this.automation.getSettingsDto();
  }

  @Put()
  update(@Body() body: UpdateAutomationDto): Promise<AutomationSettingsDto> {
    return this.automation.updateSettings(body);
  }

  @Post('token')
  regenerateToken(): Promise<AutomationSettingsDto> {
    return this.automation.regenerateToken();
  }

  /** Runs scan → identify → generate now, in the background. */
  @Post('run')
  @HttpCode(202)
  async runNow(): Promise<AutomationSettingsDto> {
    void this.automation.run('manual');
    return this.automation.getSettingsDto();
  }
}

/**
 * Whisparr's webhook (Settings → Connect → Webhook in Whisparr). Public, but
 * only works with the secret token from Stashboard's Automation settings.
 */
@Controller('api/hooks')
export class AutomationWebhookController {
  private readonly logger = new Logger(AutomationWebhookController.name);

  constructor(private readonly automation: AutomationService) {}

  @Public()
  @Post('whisparr/:token')
  @HttpCode(200)
  async whisparr(
    @Param('token') token: string,
    @Body() body: unknown,
  ): Promise<{ ok: true; action: 'ignored' | 'scheduled' | 'test' }> {
    if (!(await this.automation.verifyToken(token))) {
      this.logger.warn('Refused a Whisparr webhook with the wrong token.');
      throw new NotFoundException();
    }
    const eventType =
      body &&
      typeof body === 'object' &&
      typeof (body as { eventType?: unknown }).eventType === 'string'
        ? (body as { eventType: string }).eventType
        : null;
    const title = webhookTitle(body);
    if (eventType?.toLowerCase() === 'test') {
      this.logger.log('Received a test webhook from Whisparr.');
      return { ok: true, action: 'test' };
    }
    const action = this.automation.onWebhook(eventType, importedFolder(body));
    this.logger.log(
      `Received Whisparr webhook: ${eventType ?? 'unknown event'}${title ? ` for “${title}”` : ''} (${action}).`,
    );
    return { ok: true, action };
  }
}

/** The scene's title in a Whisparr webhook, when it has one. */
function webhookTitle(body: unknown): string | null {
  const movie =
    body && typeof body === 'object'
      ? (body as { movie?: { title?: unknown } }).movie
      : undefined;
  return typeof movie?.title === 'string' && movie.title.trim()
    ? movie.title.trim()
    : null;
}

/**
 * The folder Whisparr put the file in, as Whisparr sees it: the scene's
 * folder, or the folder of the imported file. Null when the event has neither.
 */
export function importedFolder(body: unknown): string | null {
  const record = body && typeof body === 'object' ? body : {};
  const movie = (record as { movie?: { folderPath?: unknown } }).movie;
  const file = (record as { movieFile?: { path?: unknown } }).movieFile;
  if (typeof movie?.folderPath === 'string' && movie.folderPath.trim()) {
    return movie.folderPath.trim();
  }
  if (typeof file?.path === 'string' && /[\\/]/.test(file.path)) {
    return file.path.trim().replace(/[\\/][^\\/]*$/, '');
  }
  return null;
}
