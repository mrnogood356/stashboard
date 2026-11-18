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
      // The first start since this was added. An install that already has
      // its admin account was running the release before this one; a fresh
      // install has nothing to catch up on.
      const existing = (await this.prisma.adminUser.count()) > 0;
      const previous = existing ? this.releaseBefore(current) : null;
      this.previous = previous;
      await this.prisma.appVersionState.create({
        data: {
          key: STATE_KEY,
          lastVersion: current,
          previousVersion: previous,
        },
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

  /**
   * What's new since `seen` (this browser's last version). Notes already
   * closed in any browser aren't shown again, so a browser that forgot what
   * it saw doesn't get them a second time.
   */
  async since(seen: string | undefined): Promise<ReleaseNotesResponse> {
    const current = this.version();
    const closed = await this.notesSeen();
    const from = newest([seen || this.previous, closed]);
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

  /** "What's new" for this version was closed: don't show it again anywhere. */
  async markSeen(version: string): Promise<void> {
    const current = this.version();
    if (
      !this.prisma ||
      !parseVersion(version) ||
      compareVersions(version, current) === 1
    ) {
      return;
    }
    const closed = await this.notesSeen();
    if (closed && compareVersions(closed, version) !== -1) {
      return;
    }
    await this.prisma.appVersionState.upsert({
      where: { key: STATE_KEY },
      create: {
        key: STATE_KEY,
        lastVersion: current,
        previousVersion: this.previous,
        notesSeenVersion: version,
      },
      update: { notesSeenVersion: version },
    });
  }

  private async notesSeen(): Promise<string | null> {
    const state = await this.prisma?.appVersionState
      .findUnique({ where: { key: STATE_KEY } })
      .catch(() => null);
    const value = state?.notesSeenVersion ?? null;
    return value && parseVersion(value) ? value : null;
  }

  /** The running release's own notes, for "What's new" in About. */
  latest(): ReleaseNotesResponse {
    const current = this.version();
    const newest = this.known().find(
      (release) => compareVersions(release.version, current) !== 1,
    );
    return { current, releases: newest ? [newest] : [] };
  }

  /** The newest release in the changelog older than `version`. */
  private releaseBefore(version: string): string | null {
    return (
      this.known().find(
        (release) => compareVersions(release.version, version) === -1,
      )?.version ?? null
    );
  }

  private known(): ReleaseNotes[] {
    this.releases ??= parseChangelog(this.changelog() ?? '');
    return this.releases;
  }
}

/** The newest of these versions; anything that isn't x.y.z is skipped. */
function newest(versions: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!version || !parseVersion(version)) {
      continue;
    }
    if (!best || compareVersions(version, best) === 1) {
      best = version;
    }
  }
  return best;
}
