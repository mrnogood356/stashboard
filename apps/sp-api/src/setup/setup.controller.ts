import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  DiscoveryResponse,
  ServiceDiscoveryService,
} from './service-discovery.service';
import { SetupService, SetupStatusResponse } from './setup.service';

@Controller('api/setup')
export class SetupController {
  constructor(
    private readonly setupService: SetupService,
    private readonly discovery: ServiceDiscoveryService,
  ) {}

  @Get('status')
  getStatus(): Promise<SetupStatusResponse> {
    return this.setupService.getStatus();
  }

  /** "Find my services": looks for Stash, Whisparr, Prowlarr and SABnzbd nearby. */
  @Post('discover')
  @HttpCode(200)
  discover(@Req() request: Request): Promise<DiscoveryResponse> {
    return this.discovery.discover(request.headers.host);
  }
}
