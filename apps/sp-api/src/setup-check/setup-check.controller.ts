import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { SetupCheckService } from './setup-check.service';

export class SetupFixDto {
  /** Stashboard's address as the browser sees it, for Whisparr's webhook. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  origin?: string;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The origin from the body, but only when it is the address this request
 * was actually sent to: the browser's Origin header, or (for clients that
 * send none) the Host header. A fix writes this address into Whisparr along
 * with the webhook's secret token, so a request must not be able to point
 * it somewhere else.
 */
export function requestBoundOrigin(
  bodyOrigin: string | null | undefined,
  request: Pick<Request, 'headers'>,
): string | null {
  if (!bodyOrigin) {
    return null;
  }
  const claimed = parseUrl(bodyOrigin);
  const originHeader = request.headers.origin;
  const hostHeader = request.headers.host;
  const sent =
    typeof originHeader === 'string' && originHeader !== 'null'
      ? parseUrl(originHeader)
      : null;
  const matches = sent
    ? claimed?.origin === sent.origin
    : typeof hostHeader === 'string' &&
      claimed?.host === hostHeader.trim().toLowerCase();
  if (!claimed || !matches) {
    throw new BadRequestException(
      'The address doesn’t match the one this request was sent to.',
    );
  }
  return bodyOrigin;
}

@Controller('api/setup-check')
export class SetupCheckController {
  constructor(private readonly setupCheck: SetupCheckService) {}

  @Get()
  run(@Query('origin') origin?: string) {
    return this.setupCheck.run(typeof origin === 'string' ? origin : null);
  }

  @Post('fix/:id')
  fix(
    @Param('id') id: string,
    @Body() body: SetupFixDto,
    @Req() request: Request,
  ) {
    return this.setupCheck.fix(id, requestBoundOrigin(body?.origin, request));
  }
}
