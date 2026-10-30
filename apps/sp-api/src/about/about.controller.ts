import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AboutService } from './about.service';
import { ReleaseNotesService } from './release-notes.service';
import { UpdateCheckService } from './update-check.service';

export class ReleaseNotesQueryDto {
  /** The version this browser last ran. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  since?: string;
}

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
    private readonly releaseNotes: ReleaseNotesService,
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

  @Get('changes')
  changes(@Query() query: ReleaseNotesQueryDto) {
    return this.releaseNotes.since(query.since);
  }
}
