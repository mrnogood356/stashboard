import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { IntegrationsService } from '../integrations/integrations.service';
import {
  WhisparrAdapter,
  type WhisparrImportProblem,
} from '../providers/whisparr/whisparr.adapter';

/** Whisparr's queue is asked at most this often; the page refreshes on its own. */
const LIST_TTL_MS = 20_000;
/** How long Import waits for Whisparr to finish before saying it's still importing. */
const IMPORT_WAIT_MS = 20_000;
const IMPORT_POLL_MS = 2_000;

export interface WhisparrImportItemDto extends WhisparrImportProblem {
  /** Whisparr can tell which scene it is, so Import can bring it in. */
  canImport: boolean;
}

export interface WhisparrImportsDto {
  /** Whisparr is set up; false means there's nothing to look at. */
  configured: boolean;
  /** Whisparr's queue page, where its own Manual Import is. */
  whisparrQueueUrl: string | null;
  items: WhisparrImportItemDto[];
  /** Whisparr couldn't be asked just now. */
  unreachable: boolean;
}

export interface WhisparrImportResultDto extends WhisparrImportsDto {
  /** Whisparr finished the import, or is still at it (big files take a while). */
  importState: 'done' | 'importing';
}

type WhisparrConfig = { baseUrl: string; apiKey: string | null };

/**
 * Finished Whisparr downloads it couldn't bring in on its own: shown on
 * Downloads with what Whisparr says is wrong, imported the way its own
 * Manual Import does when it knows the scene, or taken off its queue.
 */
@Injectable()
export class WhisparrImportsService {
  private readonly logger = new Logger(WhisparrImportsService.name);
  private cached: { at: number; value: WhisparrImportsDto } | null = null;
  /** Swapped in tests so they don't wait. */
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly integrations: IntegrationsService,
    private readonly whisparr: WhisparrAdapter,
  ) {}

  async list(now = Date.now()): Promise<WhisparrImportsDto> {
    if (this.cached && now - this.cached.at < LIST_TTL_MS) {
      return this.cached.value;
    }
    const config = await this.config();
    if (!config) {
      return {
        configured: false,
        whisparrQueueUrl: null,
        items: [],
        unreachable: false,
      };
    }
    const whisparrQueueUrl = `${config.baseUrl.replace(/\/+$/, '')}/activity/queue`;
    let value: WhisparrImportsDto;
    try {
      const problems = await this.whisparr.getImportProblems(config);
      value = {
        configured: true,
        whisparrQueueUrl,
        unreachable: false,
        items: problems.map((problem) => ({
          ...problem,
          // Which files go to which scene is worked out on Import, from
          // Whisparr's own Manual Import; it says when it can't tell.
          canImport: problem.downloadId !== null,
        })),
      };
    } catch (error) {
      this.logger.debug(
        `Couldn't read Whisparr's queue for Downloads: ${error instanceof Error ? error.message : String(error)}`,
      );
      value = {
        configured: true,
        whisparrQueueUrl,
        items: [],
        unreachable: true,
      };
    }
    this.cached = { at: now, value };
    return value;
  }

  /**
   * Imports a stuck download as Whisparr's Manual Import does: every video
   * in it that Whisparr can tie to a scene (samples left out).
   */
  async import(queueId: number): Promise<WhisparrImportResultDto> {
    const config = await this.requireConfig();
    const problem = await this.find(config, queueId);
    if (!problem.downloadId) {
      throw new BadRequestException(
        'Whisparr didn’t say where this download is. Import it from Whisparr’s queue.',
      );
    }
    const files = await this.whisparr.getManualImportFiles(
      config,
      problem.downloadId,
    );
    const videos = files.filter(
      (file) => !file.rejections.some((reason) => /sample/i.test(reason)),
    );
    // The queue's scene stands in for a file Whisparr couldn't place only
    // when that's the one video there: with several, one could be another
    // scene, so those are left to Whisparr's Manual Import.
    const unplaced = videos.filter((file) => file.movieId === null);
    const fallback = unplaced.length === 1 ? problem.movieId : null;
    const picked = videos.flatMap((file) => {
      const movieId = file.movieId ?? fallback;
      return movieId !== null ? [{ item: file, movieId }] : [];
    });
    if (picked.length === 0) {
      throw new BadRequestException(
        files.length === 0
          ? 'Whisparr found no videos in this download.'
          : 'Whisparr can’t tell which scene this is. Pick it in Whisparr’s Manual Import.',
      );
    }
    const commandId = await this.whisparr.startManualImport(
      config,
      picked.map((file) => ({
        ...file,
        downloadId: problem.downloadId ?? undefined,
      })),
      'auto',
    );
    this.logger.log(
      `Asked Whisparr to import “${problem.title}” (${picked.length} file${picked.length === 1 ? '' : 's'}).`,
    );
    const importState = await this.waitForImport(config, commandId, problem);
    return { ...(await this.refreshed()), importState };
  }

  /**
   * Whisparr runs the import as a command after answering. Waits a little
   * for it: a failure is reported, a long import is "still importing".
   */
  private async waitForImport(
    config: WhisparrConfig,
    commandId: number | null,
    problem: WhisparrImportProblem,
  ): Promise<'done' | 'importing'> {
    if (commandId === null) {
      return 'importing';
    }
    for (let waited = 0; waited < IMPORT_WAIT_MS; waited += IMPORT_POLL_MS) {
      await this.sleep(IMPORT_POLL_MS);
      const command = await this.whisparr
        .getCommandStatus(config, commandId)
        .catch(() => null);
      if (command?.status === 'completed') {
        return 'done';
      }
      if (
        command &&
        ['failed', 'aborted', 'cancelled'].includes(command.status)
      ) {
        this.cached = null;
        throw new BadGatewayException(
          `Whisparr couldn’t import “${problem.title}”${command.message ? `: ${command.message}` : '.'}`,
        );
      }
    }
    return 'importing';
  }

  /** Takes it off Whisparr's queue, and out of the download client when asked. */
  async remove(
    queueId: number,
    removeFromClient: boolean,
  ): Promise<WhisparrImportsDto> {
    const config = await this.requireConfig();
    const problem = await this.find(config, queueId);
    await this.whisparr.removeQueueItem(config, queueId, removeFromClient);
    this.logger.log(
      `Removed “${problem.title}” from Whisparr’s queue${removeFromClient ? ' and the download client' : ''}.`,
    );
    return this.refreshed();
  }

  private async find(
    config: WhisparrConfig,
    queueId: number,
  ): Promise<WhisparrImportProblem> {
    const problem = (await this.whisparr.getImportProblems(config)).find(
      (entry) => entry.queueId === queueId,
    );
    if (!problem) {
      this.cached = null;
      throw new NotFoundException(
        'That download isn’t waiting in Whisparr any more.',
      );
    }
    return problem;
  }

  private refreshed(): Promise<WhisparrImportsDto> {
    this.cached = null;
    return this.list();
  }

  private async requireConfig(): Promise<WhisparrConfig> {
    const config = await this.config();
    if (!config) {
      throw new BadRequestException('Whisparr isn’t set up.');
    }
    return config;
  }

  private async config(): Promise<WhisparrConfig | null> {
    try {
      const integration = await this.integrations.findOne(
        IntegrationType.WHISPARR,
      );
      const baseUrl = integration.baseUrl?.trim();
      return integration.enabled &&
        integration.status === IntegrationStatus.CONFIGURED &&
        baseUrl
        ? { baseUrl, apiKey: integration.apiKey }
        : null;
    } catch {
      return null;
    }
  }
}
