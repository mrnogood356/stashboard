import type { RecentLogEntry } from '../logging/recent-logs';

export interface BuildInfo {
  version: string;
  /** Full commit SHA the image was built from; null for a local build. */
  commit: string | null;
  /** When the image was built (ISO); null for a local build. */
  builtAt: string | null;
  /** The GitHub repository the image was built from ("owner/name"); null for a local build. */
  repository: string | null;
}

export interface AboutResponse {
  build: BuildInfo;
  /** The last warnings and errors, newest first. */
  recentErrors: RecentLogEntry[];
}

export type UpdateStatus = 'up-to-date' | 'behind' | 'unknown';

export interface UpdateCheckResponse {
  status: UpdateStatus;
  /** Commits on main this build doesn't have, when behind. */
  behindBy: number | null;
  /** Why it couldn't be checked, in plain words. */
  reason: string | null;
  checkedAt: string;
}

export interface IntegrationHealth {
  type: string;
  label: string;
  reachable: boolean;
  /** The latest error: from this check, or the last one recorded. */
  error: string | null;
  errorAt: string | null;
  lastOkAt: string | null;
}

export interface DiskHealth {
  label: string;
  path: string;
  freeBytes: number | null;
  totalBytes: number | null;
  error: string | null;
}

export type JobHealthStatus =
  'ok' | 'running' | 'warn' | 'failed' | 'off' | 'never';

export interface JobHealth {
  id: string;
  label: string;
  status: JobHealthStatus;
  lastRunAt: string | null;
  message: string | null;
}

export interface HealthResponse {
  checkedAt: string;
  database: { ok: boolean; error: string | null };
  integrations: IntegrationHealth[];
  disks: DiskHealth[];
  jobs: JobHealth[];
}
