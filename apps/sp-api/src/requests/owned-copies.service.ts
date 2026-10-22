import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { IntegrationsService } from '../integrations/integrations.service';
import { stashMediaUrl } from '../media/media-url.util';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { runWithRequestedCatalogProvider } from '../providers/catalog/catalog-provider-context';
import { type CatalogProviderKey } from '../providers/catalog/catalog-provider.util';
import {
  StashAdapter,
  type StashAdapterBaseConfig,
  type StashSceneCopy,
} from '../providers/stash/stash.adapter';
import {
  StashdbAdapter,
  type StashdbSceneFingerprints,
} from '../providers/stashdb/stashdb.adapter';
import { WhisparrAdapter } from '../providers/whisparr/whisparr.adapter';
import {
  type OwnedCopiesDto,
  type OwnedCopyDto,
  type OwnedCopyReason,
} from './dto/owned-copies.dto';

/** Each lookup gets this long; a slow one just doesn't warn. */
const CHECK_TIMEOUT_MS = 8_000;
/** Most-submitted fingerprints of each kind that are looked up. */
const MAX_FINGERPRINTS = 12;
/** Library scenes from the same day that are compared by title and studio. */
const SAME_DAY_LIMIT = 50;
const MAX_COPIES = 5;
/**
 * How far apart two phashes may be and still be the same video: a re-encode
 * or a different resolution moves a phash a few bits, a different scene
 * moves it far more.
 */
const PHASH_MAX_DISTANCE = 4;
/** A near phash only counts when the lengths agree this closely (seconds). */
const DURATION_TOLERANCE_S = 5;

/**
 * "You already have this": before a catalog scene is requested or
 * downloaded, looks for a copy you likely have. A Stash scene linked to it
 * (or to a scene StashDB merged with it), a Stash file with one of its
 * fingerprints, a Stash scene with the same title, studio and date, or a file
 * Whisparr already has. Every lookup fails soft: when one can't answer, it
 * just doesn't warn.
 */
@Injectable()
export class OwnedCopiesService {
  private readonly logger = new Logger(OwnedCopiesService.name);

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly catalogProviderService: CatalogProviderService,
    private readonly stashdbAdapter: StashdbAdapter,
    private readonly stashAdapter: StashAdapter,
    private readonly whisparrAdapter: WhisparrAdapter,
    private readonly prisma: PrismaService,
  ) {}

  async findOwnedCopies(
    sceneId: string,
    provider?: CatalogProviderKey,
  ): Promise<OwnedCopiesDto> {
    const id = sceneId.trim();
    if (!id) {
      return { copies: [] };
    }

    const [stash, identity, aliases, whisparr] = await Promise.all([
      this.soft('Stash settings', this.getStashConfig(), null),
      this.soft('catalog scene', this.loadIdentity(id, provider), null),
      this.soft('merged scenes', this.findAliases(id), []),
      this.soft('Whisparr', this.findWhisparrFile(id), null),
    ]);

    const found: Array<{ reason: OwnedCopyReason; copies: StashSceneCopy[] }> =
      [];
    if (stash) {
      const lookups = await Promise.all([
        this.soft(
          'linked scenes',
          this.stashAdapter.findSceneCopies(stash, [linkedTo(id)]),
          [],
        ),
        aliases.length > 0
          ? this.soft(
              'merged scenes',
              this.stashAdapter.findSceneCopies(stash, aliases.map(linkedTo)),
              [],
            )
          : [],
        this.soft('fingerprints', this.findByFingerprints(stash, identity), []),
        this.soft('same title', this.findBySameTitle(stash, identity), []),
      ]);
      found.push(
        { reason: 'LINKED', copies: lookups[0] },
        { reason: 'MERGED', copies: lookups[1] },
        { reason: 'FINGERPRINT', copies: lookups[2] },
        { reason: 'TITLE', copies: lookups[3] },
      );
    }

    // The strongest reason wins when one scene turns up more than once.
    const seen = new Set<string>();
    const copies: OwnedCopyDto[] = [];
    for (const { reason, copies: list } of found) {
      for (const copy of list) {
        if (seen.has(copy.id)) {
          continue;
        }
        seen.add(copy.id);
        copies.push(toCopyDto(reason, copy));
      }
    }
    if (whisparr) {
      copies.push({
        reason: 'WHISPARR',
        stashSceneId: null,
        title: identity?.title ?? null,
        studio: identity?.studioName ?? null,
        date: identity?.date ?? null,
        path: null,
        imageUrl: null,
        whisparrUrl: whisparr.viewUrl,
      });
    }

    const result = copies.slice(0, MAX_COPIES);
    if (result.length > 0) {
      this.logger.log(
        `Already-have check for scene ${id}: ${result.length} likely ${result.length === 1 ? 'copy' : 'copies'} (${[...new Set(result.map((copy) => copy.reason))].join(', ')}).`,
      );
    } else {
      this.logger.debug(`Already-have check for scene ${id}: nothing found.`);
    }
    return { copies: result };
  }

  /** Files with one of the scene's oshash, md5 or (exact) phash fingerprints. */
  private async findByFingerprints(
    stash: StashAdapterBaseConfig,
    identity: StashdbSceneFingerprints | null,
  ): Promise<StashSceneCopy[]> {
    const prints = identity?.fingerprints ?? [];
    const exact = prints
      .filter((print) => print.algorithm !== 'PHASH')
      .slice(0, MAX_FINGERPRINTS)
      .map((print) =>
        print.algorithm === 'OSHASH'
          ? { oshash: { value: print.hash, modifier: 'EQUALS' } }
          : { checksum: { value: print.hash, modifier: 'EQUALS' } },
      );
    const perceptual = prints
      .filter((print) => print.algorithm === 'PHASH')
      .slice(0, MAX_FINGERPRINTS)
      .map((print) => ({
        phash_distance: {
          value: print.hash,
          distance: PHASH_MAX_DISTANCE,
          modifier: 'EQUALS',
        },
      }));
    // Separate lookups: an older Stash without phash_distance still answers
    // the file hashes.
    const [byHash, byPhash] = await Promise.all([
      exact.length > 0
        ? this.soft(
            'file hashes',
            this.stashAdapter.findSceneCopies(stash, exact),
            [],
          )
        : [],
      perceptual.length > 0
        ? this.soft(
            'phashes',
            this.stashAdapter.findSceneCopies(stash, perceptual),
            [],
          )
        : [],
    ]);
    // A near phash alone can be a different cut (a trailer, a compilation):
    // when both lengths are known, they have to agree too.
    return [
      ...byHash,
      ...byPhash.filter((copy) =>
        sameDuration(copy.duration, identity?.duration),
      ),
    ];
  }

  /** Library scenes from the same day whose title and studio match closely. */
  private async findBySameTitle(
    stash: StashAdapterBaseConfig,
    identity: StashdbSceneFingerprints | null,
  ): Promise<StashSceneCopy[]> {
    if (!identity?.date || !identity.title || !identity.studioName) {
      return [];
    }
    const sameDay = await this.stashAdapter.findSceneCopies(
      stash,
      [{ date: { value: identity.date, modifier: 'EQUALS' } }],
      SAME_DAY_LIMIT,
    );
    return sameDay.filter(
      (copy) =>
        sameStudio(copy.studioName, identity.studioName) &&
        similarTitle(copy.title, identity.title),
    );
  }

  /** The catalog scene's title, studio, date and fingerprints. */
  private async loadIdentity(
    id: string,
    provider?: CatalogProviderKey,
  ): Promise<StashdbSceneFingerprints> {
    const { value } = await runWithRequestedCatalogProvider(
      provider ?? null,
      () =>
        this.catalogProviderService.withDetailFallback(async (catalog) => {
          const scene = await this.stashdbAdapter.getSceneFingerprints(id, {
            baseUrl: catalog.baseUrl,
            apiKey: catalog.apiKey,
          });
          if (!scene) {
            throw new NotFoundException(`Scene ${id} not found.`);
          }
          return scene;
        }),
    );
    return value;
  }

  /** Scenes Stashboard knows are the same as this one (StashDB merges). */
  private async findAliases(id: string): Promise<string[]> {
    const rows = await this.prisma.sceneStashAlias.findMany({
      where: { OR: [{ stashId: id }, { aliasOf: id }] },
      select: { stashId: true, aliasOf: true },
    });
    const ids = new Set(rows.flatMap((row) => [row.stashId, row.aliasOf]));
    ids.delete(id);
    return [...ids];
  }

  private async findWhisparrFile(
    id: string,
  ): Promise<{ viewUrl: string } | null> {
    const integration = await this.integrationsService.findOne(
      IntegrationType.WHISPARR,
    );
    const baseUrl = integration.baseUrl?.trim();
    if (
      !integration.enabled ||
      integration.status !== IntegrationStatus.CONFIGURED ||
      !baseUrl
    ) {
      return null;
    }
    const movie = await this.whisparrAdapter.findMovieByStashId(id, {
      baseUrl,
      apiKey: integration.apiKey,
    });
    return movie?.hasFile
      ? {
          viewUrl: this.whisparrAdapter.buildSceneViewUrl(
            baseUrl,
            movie.movieId,
          ),
        }
      : null;
  }

  private async getStashConfig(): Promise<StashAdapterBaseConfig | null> {
    const integration = await this.integrationsService.findOne(
      IntegrationType.STASH,
    );
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

  /** The lookup's answer, or the fallback when it fails or takes too long. */
  private async soft<T>(
    what: string,
    lookup: Promise<T>,
    fallback: T,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        this.logger.debug(`Already-have check: ${what} took too long.`);
        resolve(fallback);
      }, CHECK_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        lookup.catch((error: unknown) => {
          this.logger.debug(
            `Already-have check: ${what} failed. ${(error as Error)?.message ?? ''}`,
          );
          return fallback;
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function linkedTo(stashId: string): Record<string, unknown> {
  return { stash_id_endpoint: { stash_id: stashId, modifier: 'EQUALS' } };
}

function toCopyDto(
  reason: OwnedCopyReason,
  copy: StashSceneCopy,
): OwnedCopyDto {
  return {
    reason,
    stashSceneId: copy.id,
    title: copy.title ?? fileName(copy.path),
    studio: copy.studioName,
    date: copy.date,
    path: copy.path,
    imageUrl: copy.screenshotVersion
      ? stashMediaUrl(
          `scenes/${encodeURIComponent(copy.id)}/screenshot`,
          copy.screenshotVersion,
          480,
        )
      : null,
    whisparrUrl: null,
  };
}

function fileName(path: string | null): string | null {
  return path?.split(/[\\/]/).pop() || null;
}

/** Lowercase letters and digits only, words split by one space. */
function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True unless both lengths are known and differ by more than a few seconds. */
export function sameDuration(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  if (typeof left !== 'number' || typeof right !== 'number') {
    return true;
  }
  if (left <= 0 || right <= 0) {
    return true;
  }
  return Math.abs(left - right) <= DURATION_TOLERANCE_S;
}

/** "Brazzers Exxtra" and "BrazzersExxtra" are the same studio. */
export function sameStudio(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalize(left).replace(/ /g, '');
  const b = normalize(right).replace(/ /g, '');
  return a.length > 0 && a === b;
}

/**
 * The same title, ignoring case and punctuation, or one inside the other
 * when the shorter is long enough not to match by chance.
 */
export function similarTitle(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 12 && longer.includes(shorter);
}
