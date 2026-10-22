import type { LogLevel as NestLogLevel } from '@nestjs/common';
import { join } from 'node:path';

/**
 * Stashboard's log levels, most to least important. Nest's names map onto
 * them: log → info, verbose → trace, fatal → error (marked fatal).
 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type StashboardLogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: StashboardLogLevel = 'info';

const RANK: Record<StashboardLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** True when an entry at `level` is shown with the threshold `threshold`. */
export function isLevelEnabled(
  level: StashboardLogLevel,
  threshold: StashboardLogLevel,
): boolean {
  return RANK[level] <= RANK[threshold];
}

export function isLogLevel(value: unknown): value is StashboardLogLevel {
  return (
    typeof value === 'string' &&
    (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * A level as people write it: any case, and Nest's or the *arr apps' names
 * ("log", "verbose", "warning", "information", "fatal") too.
 */
export function parseLogLevel(
  value: string | undefined | null,
): StashboardLogLevel | null {
  const name = value?.trim().toLowerCase();
  if (!name) {
    return null;
  }
  if (isLogLevel(name)) {
    return name;
  }
  switch (name) {
    case 'log':
    case 'information':
      return 'info';
    case 'verbose':
      return 'trace';
    case 'warning':
      return 'warn';
    case 'fatal':
      return 'error';
    default:
      return null;
  }
}

/** Nest's level for one call, as Stashboard's. */
export function fromNestLevel(level: NestLogLevel): StashboardLogLevel {
  return parseLogLevel(level) ?? 'info';
}

export type LogFormat = 'text' | 'json';

export interface LoggingConfig {
  level: StashboardLogLevel;
  /** Where the level came from, for the startup line. */
  levelSource: 'LOG_LEVEL' | 'STASHBOARD_LOG_LEVELS' | 'default';
  format: LogFormat;
  /** Folder the log files go in. */
  fileDirectory: string;
  fileEnabled: boolean;
}

/**
 * Logging as the environment sets it, before any level saved in Settings →
 * Logs (which wins once saved):
 * - LOG_LEVEL: error, warn, info (default), debug or trace.
 * - STASHBOARD_LOG_LEVELS: the older comma list of Nest levels
 *   ("error,warn,log,debug"); the most detailed one listed is used.
 * - LOG_FORMAT=json: one JSON object per line on the console.
 * - LOG_FILE=false: no log files (APP_DATA_DIR/logs/stashboard.txt).
 */
export function resolveLoggingConfig(
  env: NodeJS.ProcessEnv = process.env,
): LoggingConfig {
  const dataDir = env.APP_DATA_DIR?.trim() || '/var/lib/stashboard';
  return {
    ...resolveEnvLogLevel(env),
    format: env.LOG_FORMAT?.trim().toLowerCase() === 'json' ? 'json' : 'text',
    fileDirectory: join(dataDir, 'logs'),
    fileEnabled: !['false', '0', 'off', 'no'].includes(
      env.LOG_FILE?.trim().toLowerCase() ?? '',
    ),
  };
}

export function resolveEnvLogLevel(
  env: NodeJS.ProcessEnv = process.env,
): Pick<LoggingConfig, 'level' | 'levelSource'> {
  const fromLogLevel = parseLogLevel(env.LOG_LEVEL);
  if (fromLogLevel) {
    return { level: fromLogLevel, levelSource: 'LOG_LEVEL' };
  }
  const legacy = env.STASHBOARD_LOG_LEVELS?.split(',')
    .map((name) => parseLogLevel(name))
    .filter((level): level is StashboardLogLevel => level !== null);
  if (legacy && legacy.length > 0) {
    return {
      level: legacy.reduce((most, level) =>
        RANK[level] > RANK[most] ? level : most,
      ),
      levelSource: 'STASHBOARD_LOG_LEVELS',
    };
  }
  return { level: DEFAULT_LOG_LEVEL, levelSource: 'default' };
}

/** Entries in LOG_LEVEL or STASHBOARD_LOG_LEVELS that aren't levels (typos). */
export function unknownEnvLogLevels(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...(env.LOG_LEVEL?.trim() ? [env.LOG_LEVEL.trim()] : []),
    ...(env.STASHBOARD_LOG_LEVELS?.split(',') ?? []),
  ]
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && parseLogLevel(name) === null);
}
