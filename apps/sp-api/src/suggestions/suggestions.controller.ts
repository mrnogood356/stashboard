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
  list(
    @Query('limit') limit?: string,
    @Query('tags') tags?: string,
  ): Promise<SuggestionsDto> {
    return this.suggestions.list(parseLimit(limit), parseTags(tags));
  }

  /** A fresh set now, instead of waiting hours for the list to be worked out again. */
  @Post('shuffle')
  @HttpCode(200)
  shuffle(
    @Query('limit') limit?: string,
    @Query('tags') tags?: string,
  ): Promise<SuggestionsDto> {
    return this.suggestions.shuffle(parseLimit(limit), parseTags(tags));
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

function parseLimit(limit: string | undefined): number {
  const parsed = Number.parseInt(limit ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 60) : 24;
}

/** Comma-separated catalog tag ids. */
function parseTags(tags: string | undefined): string[] {
  if (typeof tags !== 'string') {
    return [];
  }
  return tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && tag.length <= 100)
    .slice(0, 20);
}
