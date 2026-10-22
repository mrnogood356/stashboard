import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  IntegrationStatus,
  IntegrationType,
  Request,
  RequestStatus,
} from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { IndexingService } from '../indexing/indexing.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import {
  WhisparrAdapter,
  WhisparrRelease,
} from '../providers/whisparr/whisparr.adapter';
import { RequestOptionsDto } from './dto/request-options.dto';
import {
  compareReleaseMatch,
  matchRelease,
  ReleaseMatch,
  ReleaseMatchScene,
} from './release-match.util';
import { SubmitSceneRequestDto } from './dto/submit-scene-request.dto';
import { SubmitSceneRequestResponseDto } from './dto/submit-scene-request-response.dto';

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly indexingService: IndexingService,
    private readonly integrationsService: IntegrationsService,
    private readonly catalogProviderService: CatalogProviderService,
    private readonly whisparrAdapter: WhisparrAdapter,
    private readonly stashdbAdapter: StashdbAdapter,
    private readonly prisma: PrismaService,
  ) {}

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  async getRequestOptions(stashId: string): Promise<RequestOptionsDto> {
    const normalizedStashId = stashId.trim();
    if (!normalizedStashId) {
      throw new BadRequestException('Scene stashId is required.');
    }

    const whisparrConfig = await this.getWhisparrConfig();
    const catalogConfig = await this.getActiveCatalogConfig();

    const scene = await this.stashdbAdapter.getSceneById(
      normalizedStashId,
      catalogConfig,
    );

    const [rootFolders, qualityProfiles, tags] = await Promise.all([
      this.whisparrAdapter.getRootFolders(whisparrConfig),
      this.whisparrAdapter.getQualityProfiles(whisparrConfig),
      this.whisparrAdapter.getTags(whisparrConfig),
    ]);

    if (rootFolders.filter((folder) => folder.accessible).length === 0) {
      throw new ConflictException(
        'No accessible Whisparr root folders are available.',
      );
    }

    if (qualityProfiles.length === 0) {
      throw new ConflictException(
        'No Whisparr quality profiles are available.',
      );
    }

    return {
      scene: {
        stashId: scene.id,
        title: scene.title,
        studio: scene.studioName,
      },
      defaults: {
        monitored: true,
        searchForMovie: true,
      },
      rootFolders,
      qualityProfiles,
      tags,
    };
  }

  async submitSceneRequest(
    stashId: string,
    dto: SubmitSceneRequestDto,
  ): Promise<SubmitSceneRequestResponseDto> {
    const normalizedStashId = stashId.trim();
    if (!normalizedStashId) {
      throw new BadRequestException('Scene stashId is required.');
    }

    const whisparrConfig = await this.getWhisparrConfig();
    const catalogConfig = await this.getActiveCatalogConfig();

    const scene = await this.stashdbAdapter.getSceneById(
      normalizedStashId,
      catalogConfig,
    );
    const title = scene.title.trim();
    const studio = scene.studioName?.trim() ?? '';

    if (!title) {
      this.logger.warn(
        `Can't request scene ${normalizedStashId}: its metadata has no title.`,
      );
      throw new ConflictException(
        'Scene metadata is missing a title required for Whisparr submission.',
      );
    }

    if (!studio) {
      this.logger.warn(
        `Can't request “${title}” (${normalizedStashId}): its metadata has no studio.`,
      );
      throw new ConflictException(
        'Scene metadata is missing a studio required for Whisparr submission.',
      );
    }

    const existingMovie = await this.whisparrAdapter.findMovieByStashId(
      normalizedStashId,
      whisparrConfig,
    );
    if (existingMovie) {
      const request = await this.upsertLocalRequestRow(normalizedStashId);
      await this.indexingService.seedRequestedScene({
        stashId: normalizedStashId,
        requestStatus: request.status,
        requestUpdatedAt: request.updatedAt,
        title: scene.title,
        description: scene.details,
        imageUrl: scene.imageUrl,
        studioId: scene.studioId,
        studioName: scene.studioName,
        studioImageUrl: scene.studioImageUrl,
        performerNames: scene.performers.map((performer) => performer.name),
        releaseDate: scene.releaseDate,
        duration: scene.duration,
        whisparrMovieId: existingMovie.movieId,
        whisparrHasFile: existingMovie.hasFile,
      });
      void this.indexingService.requestImmediateRefresh(
        [normalizedStashId],
        'request-existing-movie',
      );
      this.logger.log(
        `Requested “${title}” (${normalizedStashId}); already in Whisparr (movie ${existingMovie.movieId}).`,
      );
      await this.activity?.record({
        kind: 'request',
        title: `Requested “${title}” (already in Whisparr)`,
      });
      return {
        accepted: true,
        alreadyExists: true,
        stashId: normalizedStashId,
        whisparrMovieId: existingMovie.movieId,
      };
    }

    const [rootFolders, qualityProfiles, tags] = await Promise.all([
      this.whisparrAdapter.getRootFolders(whisparrConfig),
      this.whisparrAdapter.getQualityProfiles(whisparrConfig),
      this.whisparrAdapter.getTags(whisparrConfig),
    ]);

    if (rootFolders.filter((folder) => folder.accessible).length === 0) {
      throw new ConflictException(
        'No accessible Whisparr root folders are available.',
      );
    }

    if (qualityProfiles.length === 0) {
      throw new ConflictException(
        'No Whisparr quality profiles are available.',
      );
    }

    const selectedRootFolder = rootFolders.find(
      (folder) => folder.path === dto.rootFolderPath,
    );
    if (!selectedRootFolder) {
      throw new BadRequestException(
        'Selected root folder does not exist in Whisparr.',
      );
    }
    if (!selectedRootFolder.accessible) {
      throw new BadRequestException(
        'Selected root folder is not accessible in Whisparr.',
      );
    }

    const selectedQualityProfile = qualityProfiles.find(
      (profile) => profile.id === dto.qualityProfileId,
    );
    if (!selectedQualityProfile) {
      throw new BadRequestException(
        'Selected quality profile does not exist in Whisparr.',
      );
    }

    const allowedTagIds = new Set(tags.map((tag) => tag.id));
    for (const tagId of dto.tags) {
      if (!allowedTagIds.has(tagId)) {
        throw new BadRequestException(
          `Selected tag id ${tagId} does not exist in Whisparr.`,
        );
      }
    }

    const createdMovie = await this.whisparrAdapter.createMovie(
      {
        title,
        studio,
        foreignId: normalizedStashId,
        monitored: dto.monitored,
        rootFolderPath: dto.rootFolderPath,
        addOptions: {
          searchForMovie: dto.searchForMovie,
        },
        qualityProfileId: dto.qualityProfileId,
        tags: dto.tags,
      },
      whisparrConfig,
    );

    const request = await this.upsertLocalRequestRow(normalizedStashId);
    await this.indexingService.seedRequestedScene({
      stashId: normalizedStashId,
      requestStatus: request.status,
      requestUpdatedAt: request.updatedAt,
      title: scene.title,
      description: scene.details,
      imageUrl: scene.imageUrl,
      studioId: scene.studioId,
      studioName: scene.studioName,
      studioImageUrl: scene.studioImageUrl,
      performerNames: scene.performers.map((performer) => performer.name),
      releaseDate: scene.releaseDate,
      duration: scene.duration,
      whisparrMovieId: createdMovie.movieId ?? undefined,
      whisparrHasFile: false,
    });
    void this.indexingService.requestImmediateRefresh(
      [normalizedStashId],
      'request-submitted',
    );
    this.logger.log(
      `Requested “${title}” in Whisparr (movie ${createdMovie.movieId ?? 'unknown'}, scene ${normalizedStashId}${dto.searchForMovie ? ', searching' : ''}).`,
    );
    await this.activity?.record({
      kind: 'request',
      title: `Requested “${title}” in Whisparr`,
      detail: dto.searchForMovie ? 'Whisparr is searching for it.' : null,
    });

    return {
      accepted: true,
      alreadyExists: false,
      stashId: normalizedStashId,
      whisparrMovieId: createdMovie.movieId ?? null,
    };
  }

  /**
   * Every release Whisparr's indexers have for a requested scene, best first,
   * so you can choose the exact one to download. Whisparr builds the search
   * itself, and indexers match loosely, so each release says how well its
   * name fits the scene (studio, date, performers, title).
   */
  async getReleases(stashId: string): Promise<{
    movieId: number;
    releases: MatchedRelease[];
    /** When nothing came back, a likely reason on Whisparr's side. */
    notice?: string;
  }> {
    const { movieId, whisparrConfig } =
      await this.requireWhisparrMovie(stashId);
    const [releases, scene] = await Promise.all([
      this.whisparrAdapter.searchReleases(whisparrConfig, movieId),
      this.findReleaseMatchScene(stashId.trim()),
    ]);
    this.logger.debug(
      `Release search for scene ${stashId.trim()} (movie ${movieId}) returned ${releases.length} release(s).`,
    );
    if (releases.length > 0) {
      return {
        movieId,
        releases: sortReleases(
          releases.map((release) => ({
            ...release,
            match: scene ? matchRelease(release.title, scene) : null,
          })),
        ),
      };
    }
    const health = await this.whisparrAdapter
      .getIndexerHealth(whisparrConfig)
      .catch((error: unknown) => {
        this.logger.debug(
          `Couldn't read Whisparr indexer health: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
    return { movieId, releases: [], ...indexerNotice(health) };
  }

  private async findReleaseMatchScene(
    stashId: string,
  ): Promise<ReleaseMatchScene | null> {
    const row = await this.prisma.sceneIndex
      .findUnique({
        where: { stashId },
        select: {
          title: true,
          studioName: true,
          releaseDate: true,
          performerNames: true,
        },
      })
      .catch(() => null);
    if (!row) {
      return null;
    }
    return {
      title: row.title,
      studio: row.studioName,
      releaseDate: row.releaseDate,
      performers: (row.performerNames ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    };
  }

  /** Downloads the chosen release. */
  async grabRelease(
    stashId: string,
    release: { guid: string; indexerId: number },
  ): Promise<{ accepted: true }> {
    const normalizedStashId = stashId.trim();
    const { movieId, whisparrConfig } =
      await this.requireWhisparrMovie(normalizedStashId);
    // Without the movie, Whisparr refuses a release whose name it can't
    // match to a scene ("Unable to find matching movie").
    await this.whisparrAdapter.grabRelease(whisparrConfig, release, movieId);
    this.logger.log(
      `Sent release to Whisparr for scene ${normalizedStashId} (movie ${movieId}, indexer ${release.indexerId}).`,
    );
    await this.upsertLocalRequestRow(normalizedStashId);
    void this.indexingService.requestImmediateRefresh(
      [normalizedStashId],
      'release-grabbed',
    );
    await this.noteGrab(normalizedStashId);
    return { accepted: true };
  }

  private async noteGrab(stashId: string): Promise<void> {
    if (!this.activity) {
      return;
    }
    const scene = await this.prisma.sceneIndex
      .findUnique({ where: { stashId }, select: { title: true } })
      .catch(() => null);
    await this.activity.record({
      kind: 'request',
      title: scene?.title
        ? `Picked a release of “${scene.title}” to download`
        : 'Picked a release to download',
    });
  }

  private async requireWhisparrMovie(stashId: string) {
    const normalizedStashId = stashId.trim();
    if (!normalizedStashId) {
      throw new BadRequestException('Scene stashId is required.');
    }
    const whisparrConfig = await this.getWhisparrConfig();
    const movie = await this.whisparrAdapter.findMovieByStashId(
      normalizedStashId,
      whisparrConfig,
    );
    if (!movie) {
      this.logger.warn(
        `Scene ${normalizedStashId} isn't in Whisparr yet, so releases can't be picked.`,
      );
      throw new ConflictException(
        'Request this scene in Whisparr first, then pick a release.',
      );
    }
    return { movieId: movie.movieId, whisparrConfig };
  }

  private async upsertLocalRequestRow(stashId: string): Promise<Request> {
    return this.prisma.request.upsert({
      where: { stashId },
      create: {
        stashId,
        status: RequestStatus.REQUESTED,
      },
      update: {
        status: RequestStatus.REQUESTED,
      },
    });
  }

  private async getWhisparrConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  }> {
    const integration = await this.getIntegration(IntegrationType.WHISPARR);

    if (!integration.enabled) {
      this.logger.warn('Whisparr is turned off, so the request was refused.');
      throw new ConflictException('WHISPARR integration is disabled.');
    }

    if (integration.status !== IntegrationStatus.CONFIGURED) {
      this.logger.warn(
        'Whisparr is not set up yet, so the request was refused.',
      );
      throw new ConflictException('WHISPARR integration is not configured.');
    }

    const baseUrl = integration.baseUrl?.trim();
    if (!baseUrl) {
      throw new BadRequestException(
        'WHISPARR integration is missing a base URL.',
      );
    }

    return {
      baseUrl,
      apiKey: integration.apiKey,
    };
  }

  private async getActiveCatalogConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  }> {
    const catalogProvider =
      // Requests always use the instance provider, never a browse-only one.
      await this.catalogProviderService.getInstanceCatalogProvider();

    return {
      baseUrl: catalogProvider.baseUrl,
      apiKey: catalogProvider.apiKey,
    };
  }

  private async getIntegration(type: IntegrationType) {
    try {
      return await this.integrationsService.findOne(type);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new ConflictException(
          `${type} integration has not been created yet.`,
        );
      }

      throw error;
    }
  }
}

/** Releases Whisparr would accept first, then the higher custom-format score, then the most seeders. */
/** Why an empty search may not mean no indexer has the scene. */
export function indexerNotice(
  health: {
    searchable: number;
    paused: Array<{ name: string; until: string }>;
  } | null,
): { notice?: string } {
  if (!health) {
    return {};
  }
  if (health.searchable === 0) {
    return {
      notice:
        'No indexer in Whisparr is enabled for interactive search. Turn it on under Settings → Indexers in Whisparr.',
    };
  }
  if (health.paused.length === 0) {
    return {};
  }
  const names = health.paused.map((entry) => entry.name).join(', ');
  const last = health.paused
    .map((entry) => entry.until)
    .sort()
    .pop() as string;
  const until = new Date(last).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return {
    notice: `Whisparr paused ${health.paused.length} of ${health.searchable} indexers after errors, until about ${until}: ${names}. Its System → Status page says why.`,
  };
}

/** A release, and how well its name fits the scene (null: unknown). */
export type MatchedRelease = WhisparrRelease & { match: ReleaseMatch | null };

/**
 * Releases Whisparr would take first, then the ones whose name fits the
 * scene best, then custom format score, resolution and seeders.
 */
export function sortReleases<
  T extends WhisparrRelease & { match?: ReleaseMatch | null },
>(releases: T[]): T[] {
  return [...releases].sort((left, right) => {
    if (left.rejected !== right.rejected) {
      return left.rejected ? 1 : -1;
    }
    const match = compareReleaseMatch(left.match ?? null, right.match ?? null);
    if (match !== 0) {
      return match;
    }
    const score =
      (right.customFormatScore ?? 0) - (left.customFormatScore ?? 0);
    if (score !== 0) {
      return score;
    }
    const resolution = (right.resolution ?? 0) - (left.resolution ?? 0);
    if (resolution !== 0) {
      return resolution;
    }
    return (right.seeders ?? -1) - (left.seeders ?? -1);
  });
}
