import { Injectable } from '@nestjs/common';
import { resolveAppVersion } from '../health/health.controller';
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

/**
 * What changed since the version a browser last saw, from the CHANGELOG.md
 * that ships in the image: the "What's new" note after an update. Nothing
 * for edge or local builds, which aren't releases.
 */
@Injectable()
export class ReleaseNotesService {
  private releases: ReleaseNotes[] | null = null;
  /** Swapped in tests. */
  version: () => string = resolveAppVersion;
  changelog: () => string | null = readChangelog;

  since(seen: string | undefined): ReleaseNotesResponse {
    const current = this.version();
    if (!seen || !parseVersion(current)) {
      return { current, releases: [] };
    }
    this.releases ??= parseChangelog(this.changelog() ?? '');
    return {
      current,
      releases: this.releases
        .filter(
          (release) =>
            compareVersions(release.version, seen) === 1 &&
            compareVersions(release.version, current) !== 1,
        )
        .slice(0, MAX_RELEASES),
    };
  }
}
