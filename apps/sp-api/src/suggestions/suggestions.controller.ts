import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { SuggestionsService, type SuggestionsDto } from './suggestions.service';

@Controller('api/suggestions')
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get()
  list(@Query('limit') limit?: string): Promise<SuggestionsDto> {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.suggestions.list(
      Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 60) : 24,
    );
  }

  @Post(':sceneId/dismiss')
  @HttpCode(204)
  async dismiss(
    @Param('sceneId') sceneId: string,
    @Body() body: { reason?: unknown },
  ): Promise<void> {
    await this.suggestions.dismiss(
      sceneId.slice(0, 64),
      typeof body?.reason === 'string' ? body.reason : '',
    );
  }
}
