import { resolveAppVersion } from '../health/health.controller';
import type { BuildInfo } from './about.types';

/** What a local (non-image) build says instead of a commit or build time. */
const DEV_VALUES = new Set(['', 'dev', 'unknown']);

/**
 * The version, commit, build time and repository baked into the image by the
 * publish workflow (STASHBOARD_VERSION, STASHBOARD_COMMIT, STASHBOARD_BUILT_AT,
 * STASHBOARD_REPOSITORY).
 */
export function resolveBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
): BuildInfo {
  const commit = env.STASHBOARD_COMMIT?.trim().toLowerCase() ?? '';
  const builtAt = env.STASHBOARD_BUILT_AT?.trim() ?? '';
  const builtAtDate = DEV_VALUES.has(builtAt) ? null : new Date(builtAt);
  const repository = env.STASHBOARD_REPOSITORY?.trim() ?? '';
  return {
    version: resolveAppVersion(),
    commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
    builtAt:
      builtAtDate && !Number.isNaN(builtAtDate.getTime())
        ? builtAtDate.toISOString()
        : null,
    repository: /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)
      ? repository
      : null,
  };
}
