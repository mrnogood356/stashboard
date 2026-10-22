import { Controller, Get } from '@nestjs/common';
import { AboutService } from './about.service';
import { UpdateCheckService } from './update-check.service';

/**
 * Settings → About & health. Three calls so each part of the page shows as
 * soon as it's ready: the build and recent errors at once, health after its
 * checks, and the update check (GitHub) last.
 */
@Controller('api/about')
export class AboutController {
  constructor(
    private readonly about: AboutService,
    private readonly updates: UpdateCheckService,
  ) {}

  @Get()
  get() {
    return this.about.about();
  }

  @Get('health')
  health() {
    return this.about.health();
  }

  @Get('update')
  update() {
    return this.updates.check();
  }
}
