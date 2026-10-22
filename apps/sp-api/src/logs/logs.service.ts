import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { LogQueryResult } from '../logging/log-buffer';
import { LOG_FILE_PATTERN, type LogFileInfo } from '../logging/log-file-writer';
import {
  parseLogLevel,
  resolveLoggingConfig,
  type StashboardLogLevel,
} from '../logging/log-levels';
import { appLogger, StashboardLogger } from '../logging/stashboard-logger';
import { PrismaService } from '../prisma/prisma.service';
import type {
  LogQueryDto,
  LogSettingsResponse,
  UpdateLogSettingsDto,
} from './dto/logs.dto';

const KEY = 'GLOBAL';

export interface LogsResponse extends LogQueryResult {
  /** The level being logged at now; nothing more detailed is kept. */
  level: StashboardLogLevel;
  /** How many entries are kept in memory at most. */
  capacity: number;
}

export interface LogFilesResponse {
  enabled: boolean;
  directory: string | null;
  files: LogFileInfo[];
}

/**
 * Settings → Logs: the recent log, the log files, and the level, which is
 * saved in the database and applied at once (and again on every start).
 */
@Injectable()
export class LogsService implements OnModuleInit {
  private readonly log = new Logger('Logging');
  /** Swapped in tests. */
  logger: StashboardLogger = appLogger;
  env: NodeJS.ProcessEnv = process.env;

  constructor(private readonly prisma: PrismaService) {}

  /** A level saved in Settings → Logs wins over LOG_LEVEL. */
  async onModuleInit(): Promise<void> {
    try {
      const saved = await this.prisma.logSettings.findUnique({
        where: { key: KEY },
      });
      if (saved) {
        this.apply(parseLogLevel(saved.level) ?? 'info', saved.fileEnabled);
      }
    } catch (error) {
      this.log.warn(
        `Couldn't read the saved log settings; using LOG_LEVEL for now: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  query(query: LogQueryDto): LogsResponse {
    return {
      ...this.logger.buffer.query({ ...query, limit: query.limit ?? 200 }),
      level: this.logger.level,
      capacity: this.logger.buffer.capacity,
    };
  }

  contexts(): string[] {
    return this.logger.buffer.contexts();
  }

  clear(): void {
    this.logger.buffer.clear();
    this.log.log('Cleared the in-memory log.');
  }

  async files(): Promise<LogFilesResponse> {
    await this.logger.flush();
    const files = this.logger.files();
    return {
      enabled: this.logger.filesEnabled,
      directory: this.logger.logDirectory,
      files: files ? await files.list() : [],
    };
  }

  /** Full path of one log file; only stashboard.txt and its rotated copies. */
  async filePath(name: string): Promise<string> {
    const directory = this.logger.logDirectory;
    if (!LOG_FILE_PATTERN.test(name) || basename(name) !== name) {
      throw new BadRequestException('Not a log file name.');
    }
    if (!directory) {
      throw new NotFoundException('Log files are off.');
    }
    await this.logger.flush();
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      throw new NotFoundException('No such log file.');
    }
    return path;
  }

  async settings(): Promise<LogSettingsResponse> {
    const saved = await this.prisma.logSettings
      .findUnique({ where: { key: KEY } })
      .catch(() => null);
    return this.describe(!!saved);
  }

  async updateSettings(
    body: UpdateLogSettingsDto,
  ): Promise<LogSettingsResponse> {
    await this.prisma.logSettings.upsert({
      where: { key: KEY },
      create: { key: KEY, level: body.level, fileEnabled: body.fileEnabled },
      update: { level: body.level, fileEnabled: body.fileEnabled },
    });
    const before = this.logger.level;
    this.apply(body.level, body.fileEnabled);
    if (before !== body.level) {
      this.log.log(`Log level changed from ${before} to ${body.level}.`);
    }
    return this.describe(true);
  }

  private apply(level: StashboardLogLevel, fileEnabled: boolean): void {
    this.logger.setLevel(level);
    if (this.logger.filesEnabled !== fileEnabled) {
      this.logger.setFileEnabled(fileEnabled);
    }
  }

  private describe(saved: boolean): LogSettingsResponse {
    return {
      level: this.logger.level,
      fileEnabled: this.logger.filesEnabled,
      saved,
      envLevel: resolveLoggingConfig(this.env).level,
      fileDirectory: this.logger.logDirectory,
      fileError: this.logger.fileError,
    };
  }
}
