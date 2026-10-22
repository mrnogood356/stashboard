import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { runWithRequestedCatalogProvider } from '../providers/catalog/catalog-provider-context';
import {
  type CatalogProviderKey,
  getCatalogProviderLabel,
} from '../providers/catalog/catalog-provider.util';
import {
  ProwlarrAdapter,
  ProwlarrAdapterBaseConfig,
  ProwlarrRelease,
} from '../providers/prowlarr/prowlarr.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import {
  compareReleaseMatch,
  matchRelease,
  ReleaseMatch,
  ReleaseMatchScene,
} from '../requests/release-match.util';
import { buildReleaseQueries } from './release-queries.util';

/**
 * A release, and how well its name fits the scene (null: unknown). Its
 * download link carries Prowlarr's API key, so it never leaves the server.
 */
export type MatchedProwlarrRelease = Omit<ProwlarrRelease, 'downloadUrl'> & {
  match: ReleaseMatch | null;
};

/** Prowlarr only remembers search results for about this long. */
const RELEASE_TTL_MS = 30 * 60_000;
const MAX_REMEMBERED_RELEASES = 2_000;

export interface ProwlarrSearchResult {
  releases: MatchedProwlarrRelease[];
  /** What was searched for, so an empty result can say so. */
  queries: string[];
  notice?: string;
}

interface SceneForSearch extends ReleaseMatchScene {
  id: string;
  /** Catalog the scene came from, e.g. "FansDB". */
  source: string;
  provider: CatalogProviderKey;
}

/**
 * Finds downloads for a scene through Prowlarr, for scenes Whisparr can't
 * request (it only knows StashDB): searches Prowlarr's indexers with a few
 * queries built from the scene, says how well each release fits, and sends
 * the chosen one to the download client set up in Prowlarr. With Finished
 * downloads on, usenet releases go to SABnzbd instead, to be moved into the
 * library once they're done.
 */
@Injectable()
export class DownloadsService {
  private readonly logger = new Logger(DownloadsService.name);
  /** Releases from recent searches, by indexer and guid, for the grab. */
  private readonly releases = new Map<
    string,
    { release: ProwlarrRelease; expires: number }
  >();

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly catalogProviderService: CatalogProviderService,
    private readonly stashdbAdapter: StashdbAdapter,
    private readonly prowlarrAdapter: ProwlarrAdapter,
  ) {}

  @Optional()
  @Inject(ActivityService)
  private readonly activity?: ActivityService;

  @Optional()
  @Inject(DownloadHandoffService)
  private readonly handoff?: DownloadHandoffService;

  /** Whether "Find downloads" can be offered. */
  async getStatus(): Promise<{ prowlarr: { configured: boolean } }> {
    return { prowlarr: { configured: (await this.findConfig()) !== null } };
  }

  async searchReleases(
    sceneId: string,
    provider?: CatalogProviderKey,
    /** Your own words; searched as typed instead of the built queries. */
    typed?: string,
  ): Promise<ProwlarrSearchResult> {
    const config = await this.requireConfig();
    const scene = await this.loadScene(sceneId, provider);
    const queries = typed?.trim() ? [typed.trim()] : buildReleaseQueries(scene);
    if (queries.length === 0) {
      throw new ConflictException(
        'This scene has no title, studio or performers to search for.',
      );
    }

    this.logger.debug(
      `Searching Prowlarr for scene ${scene.id} with ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}: ${queries.map((query) => `“${query}”`).join(', ')}.`,
    );
    const results = await Promise.allSettled(
      queries.map((query) => this.prowlarrAdapter.search(config, query)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length === results.length) {
      this.logger.warn(
        `Every Prowlarr search for scene ${scene.id} failed: ${failures[0].reason instanceof Error ? failures[0].reason.message : String(failures[0].reason)}`,
      );
      throw failures[0].reason;
    }
    for (const failure of failures) {
      this.logger.warn(
        `A Prowlarr search for scene ${scene.id} failed: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`,
      );
    }

    // The same release often comes back for more than one query.
    const byGuid = new Map<string, ProwlarrRelease>();
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        continue;
      }
      for (const release of result.value) {
        if (!byGuid.has(release.guid)) {
          byGuid.set(release.guid, release);
        }
      }
    }

    byGuid.forEach((release) => this.remember(release));
    const releases = sortProwlarrReleases(
      [...byGuid.values()].map(({ downloadUrl: _link, ...release }) => ({
        ...release,
        match: matchRelease(release.title, scene),
      })),
    );
    this.logger.log(
      `Prowlarr found ${releases.length} release(s) for “${scene.title ?? scene.id}” (${scene.source}).`,
    );
    return releases.length > 0
      ? { releases, queries }
      : {
          releases,
          queries,
          notice: `None of Prowlarr’s indexers found anything for ${queries.map((query) => `“${query}”`).join(', ')}.`,
        };
  }

  /**
   * Sends one release from the search to Prowlarr's download client, or,
   * with Finished downloads on, a usenet release straight to SABnzbd.
   */
  async grabRelease(
    sceneId: string,
    release: {
      guid: string;
      indexerId: number;
      title?: string | null;
      indexer?: string | null;
    },
    provider?: CatalogProviderKey,
  ): Promise<{ accepted: true; sentTo: 'prowlarr' | 'sabnzbd' }> {
    const config = await this.requireConfig();
    if (this.handoff && (await this.handoff.isActive())) {
      const found = this.recall(release.indexerId, release.guid);
      if (!found) {
        this.logger.warn(
          `Release ${release.guid} from indexer ${release.indexerId} has expired from the search results; asked to search again.`,
        );
        throw new ConflictException(
          'That search result has expired. Search again and pick it once more.',
        );
      }
      // Torrents still go through Prowlarr's own download client.
      if (found.protocol === 'usenet' && found.downloadUrl) {
        const scene = await this.loadScene(sceneId, provider);
        const nzb = await this.prowlarrAdapter.fetchNzb(
          config,
          found.downloadUrl,
        );
        await this.handoff.send({
          nzb,
          releaseTitle: found.title,
          scene: { id: scene.id, provider: scene.provider, title: scene.title },
        });
        this.logger.log(
          `Sent “${found.title}”${found.indexer ? ` from ${found.indexer}` : ''} to SABnzbd for “${scene.title ?? scene.id}”.`,
        );
        return { accepted: true, sentTo: 'sabnzbd' };
      }
    }
    await this.prowlarrAdapter.grab(config, {
      guid: release.guid,
      indexerId: release.indexerId,
    });

    const scene = await this.loadScene(sceneId, provider).catch(
      (error: unknown) => {
        this.logger.debug(
          `Couldn't load scene ${sceneId} for the activity note: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      },
    );
    const releaseTitle = release.title?.trim() || 'A release';
    const detail = [
      releaseTitle,
      release.indexer?.trim() ? `from ${release.indexer.trim()}` : null,
      scene ? `for “${scene.title ?? scene.id}” (${scene.source})` : null,
    ]
      .filter(Boolean)
      .join(', ');
    this.logger.log(`Sent a release to download through Prowlarr: ${detail}.`);
    await this.activity?.record({
      kind: 'request',
      title: scene?.title
        ? `Sent a release of “${scene.title}” to download through Prowlarr`
        : 'Sent a release to download through Prowlarr',
      detail: `${detail}.`,
    });
    return { accepted: true, sentTo: 'prowlarr' };
  }

  /** Keeps a release from a search for a while, so a grab can find it. */
  private remember(release: ProwlarrRelease): void {
    const now = Date.now();
    if (this.releases.size >= MAX_REMEMBERED_RELEASES) {
      for (const [key, entry] of this.releases) {
        if (
          entry.expires < now ||
          this.releases.size >= MAX_REMEMBERED_RELEASES
        ) {
          this.releases.delete(key);
        }
        if (this.releases.size < MAX_REMEMBERED_RELEASES * 0.8) {
          break;
        }
      }
    }
    this.releases.set(releaseKey(release.indexerId, release.guid), {
      release,
      expires: now + RELEASE_TTL_MS,
    });
  }

  private recall(indexerId: number, guid: string): ProwlarrRelease | null {
    const key = releaseKey(indexerId, guid);
    const entry = this.releases.get(key);
    if (!entry || entry.expires < Date.now()) {
      this.releases.delete(key);
      return null;
    }
    return entry.release;
  }

  /** What the scene's name, studio, date and performers are. */
  private async loadScene(
    sceneId: string,
    provider?: CatalogProviderKey,
  ): Promise<SceneForSearch> {
    const id = sceneId.trim();
    if (!id) {
      throw new BadRequestException('Scene id is required.');
    }
    const { value, provider: used } = await runWithRequestedCatalogProvider(
      provider ?? null,
      () =>
        this.catalogProviderService.withDetailFallback((catalog) =>
          this.stashdbAdapter.getSceneById(id, catalog),
        ),
    );
    return {
      id: value.id,
      title: value.title?.trim() || null,
      studio: value.studioName,
      releaseDate: value.releaseDate,
      performers: value.performers.map((performer) => performer.name),
      source: getCatalogProviderLabel(used.integrationType),
      provider: used.providerKey,
    };
  }

  private async requireConfig(): Promise<ProwlarrAdapterBaseConfig> {
    const config = await this.findConfig();
    if (!config) {
      this.logger.warn(
        'Prowlarr is not set up, so the download search was refused.',
      );
      throw new ConflictException(
        'Set up Prowlarr in Settings → Integrations to search for downloads.',
      );
    }
    return config;
  }

  /** Prowlarr's address and key, when it's turned on and passed its test. */
  private async findConfig(): Promise<ProwlarrAdapterBaseConfig | null> {
    let integration;
    try {
      integration = await this.integrationsService.findOne(
        IntegrationType.PROWLARR,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
    const baseUrl = integration.baseUrl?.trim();
    if (
      !integration.enabled ||
      integration.status !== IntegrationStatus.CONFIGURED ||
      !baseUrl
    ) {
      return null;
    }
    return { baseUrl, apiKey: integration.apiKey };
  }
}

function releaseKey(indexerId: number, guid: string): string {
  return `${indexerId}:${guid}`;
}

/** Best match first, then the most seeders, then the newest. */
export function sortProwlarrReleases<
  T extends Omit<ProwlarrRelease, 'downloadUrl'> & {
    match: ReleaseMatch | null;
  },
>(releases: T[]): T[] {
  return [...releases].sort((left, right) => {
    const match = compareReleaseMatch(left.match, right.match);
    if (match !== 0) {
      return match;
    }
    const seeders = (right.seeders ?? -1) - (left.seeders ?? -1);
    if (seeders !== 0) {
      return seeders;
    }
    return (
      (left.ageHours ?? Number.MAX_SAFE_INTEGER) -
      (right.ageHours ?? Number.MAX_SAFE_INTEGER)
    );
  });
}
