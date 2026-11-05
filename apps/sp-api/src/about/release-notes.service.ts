import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { resolveAppVersion } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import type { ReleaseNotesResponse } from './about.types';
import {
  compareVersions,
  parseChangelog,
  parseVersion,
  readChangelog,
  type ReleaseNotes,
} from './changelog';

/** More than this many releases at once is a summary nobody reads. */
const MAX_RELEASES = 5;
const STATE_KEY = 'GLOBAL';

/**
 * What changed since the version a browser last saw, from the CHANGELOG.md
 * that ships in the image: the "What's new" note after an update. Nothing
 * for edge or local builds, which aren't releases.
 *
 * A browser can forget its version (Safari on iPhone clears a site's storage
 * after about a week without a visit), so the server also remembers the
 * release it ran before this one and answers for such a browser with that.
 */
@Injectable()
export class ReleaseNotesService implements OnModuleInit {
  private readonly logger = new Logger(ReleaseNotesService.name);
  private releases: ReleaseNotes[] | null = null;
  /** The release this server ran before the current one, once known. */
  private previous: string | null = null;
  /** Swapped in tests. */
  version: () => string = resolveAppVersion;
  changelog: () => string | null = readChangelog;

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.recordRun().catch((error: unknown) => {
      this.logger.warn(
        `Couldn't remember which version ran last: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Notes this server keeps on which release it ran, for the fallback above. */
  async recordRun(): Promise<void> {
    const current = this.version();
    if (!this.prisma || !parseVersion(current)) {
      return;
    }
    const state = await this.prisma.appVersionState.findUnique({
      where: { key: STATE_KEY },
    });
    if (!state) {
      await this.prisma.appVersionState.create({
        data: { key: STATE_KEY, lastVersion: current },
      });
      return;
    }
    if (state.lastVersion === current) {
      this.previous = state.previousVersion;
      return;
    }
    this.previous = state.lastVersion;
    await this.prisma.appVersionState.update({
      where: { key: STATE_KEY },
      data: { lastVersion: current, previousVersion: state.lastVersion },
    });
  }

  since(seen: string | undefined): ReleaseNotesResponse {
    const current = this.version();
    const from = seen || this.previous;
    if (!from || !parseVersion(current)) {
      return { current, releases: [] };
    }
    return {
      current,
      releases: this.known()
        .filter(
          (release) =>
            compareVersions(release.version, from) === 1 &&
            compareVersions(release.version, current) !== 1,
        )
        .slice(0, MAX_RELEASES),
    };
  }

  /** The running release's own notes, for "What's new" in About. */
  latest(): ReleaseNotesResponse {
    const current = this.version();
    const newest = this.known().find(
      (release) => compareVersions(release.version, current) !== 1,
    );
    return { current, releases: newest ? [newest] : [] };
  }

  private known(): ReleaseNotes[] {
    this.releases ??= parseChangelog(this.changelog() ?? '');
    return this.releases;
  }
}
