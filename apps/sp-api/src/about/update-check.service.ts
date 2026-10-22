import { Injectable, Logger } from '@nestjs/common';
import { fetchWithTimeout } from '../providers/fetch-with-timeout';
import type { UpdateCheckResponse } from './about.types';
import { resolveBuildInfo } from './build-info';

const CACHE_MS = 60 * 60_000;
const TIMEOUT_MS = 5_000;

/**
 * Whether main has commits this build doesn't, from GitHub's compare API, in
 * the repository the image was built from (STASHBOARD_UPDATE_REPO overrides
 * it). A private repository needs a read-only GITHUB_TOKEN; without one (or
 * when GitHub can't be reached) it says it can't check, and nothing else.
 * Asked at most once an hour.
 */
@Injectable()
export class UpdateCheckService {
  private readonly logger = new Logger(UpdateCheckService.name);
  private cached: { result: UpdateCheckResponse; until: number } | null = null;
  private pending: Promise<UpdateCheckResponse> | null = null;
  /** Swapped in tests. */
  fetch: typeof fetchWithTimeout = fetchWithTimeout;
  env: NodeJS.ProcessEnv = process.env;

  async check(): Promise<UpdateCheckResponse> {
    if (this.cached && Date.now() < this.cached.until) {
      return this.cached.result;
    }
    // One request to GitHub however many pages ask at once.
    this.pending ??= this.ask().finally(() => {
      this.pending = null;
    });
    const result = await this.pending;
    this.cached = { result, until: Date.now() + CACHE_MS };
    return result;
  }

  private async ask(): Promise<UpdateCheckResponse> {
    const build = resolveBuildInfo(this.env);
    const commit = build.commit;
    if (!commit) {
      return unknown('This build doesn’t say which commit it was made from.');
    }
    const repo = this.env.STASHBOARD_UPDATE_REPO?.trim() || build.repository;
    if (!repo) {
      return unknown('This build doesn’t say which repository it came from.');
    }
    const token = this.env.GITHUB_TOKEN?.trim();
    try {
      const response = await this.fetch(
        `https://api.github.com/repos/${repo}/compare/${commit}...main`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'stashboard',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        TIMEOUT_MS,
      );
      if (!response.ok) {
        return unknown(
          response.status === 404 || response.status === 401
            ? token
              ? 'GitHub didn’t accept the token, or doesn’t know this commit.'
              : 'The repository is private; set GITHUB_TOKEN to check.'
            : `GitHub answered ${response.status}.`,
        );
      }
      const body = (await response.json()) as {
        status?: string;
        ahead_by?: number;
      };
      // ahead_by: commits on main that aren't in this build.
      const behindBy = typeof body.ahead_by === 'number' ? body.ahead_by : 0;
      return {
        status: behindBy > 0 ? 'behind' : 'up-to-date',
        behindBy: behindBy > 0 ? behindBy : null,
        reason: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      // Debug only: offline installs would otherwise fill Recent errors.
      this.logger.debug(
        `Checking for updates failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return unknown('Couldn’t reach GitHub.');
    }
  }
}

function unknown(reason: string): UpdateCheckResponse {
  return {
    status: 'unknown',
    behindBy: null,
    reason,
    checkedAt: new Date().toISOString(),
  };
}
