import { BadRequestException, Injectable } from '@nestjs/common';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';

export interface PendingSceneDto {
  editId: string;
  title: string;
  date: string | null;
  duration: number | null;
  studioName: string | null;
  performers: string[];
  imageUrl: string | null;
  votes: number;
  submittedAt: string | null;
  /** The edit on the catalog's own site, to read or vote on it. */
  url: string;
}

export interface PendingScenesDto {
  total: number;
  items: PendingSceneDto[];
}

/** New edits come in slowly; a few minutes' old list saves the catalog's time. */
const CACHE_MS = 10 * 60_000;
const CACHE_SIZE = 200;
const PER_PAGE = 25;

/**
 * Scenes submitted to the catalog for a studio or performer that aren't
 * accepted yet: what's on its way, before it can be requested.
 */
@Injectable()
export class PendingScenesService {
  private readonly cache = new Map<
    string,
    { at: number; value: Promise<PendingScenesDto> }
  >();

  constructor(
    private readonly catalogProviderService: CatalogProviderService,
    private readonly stashdbAdapter: StashdbAdapter,
  ) {}

  forStudio(studioId: string): Promise<PendingScenesDto> {
    return this.pending('STUDIO', studioId);
  }

  forPerformer(performerId: string): Promise<PendingScenesDto> {
    return this.pending('PERFORMER', performerId);
  }

  private async pending(
    kind: 'STUDIO' | 'PERFORMER',
    rawId: string,
  ): Promise<PendingScenesDto> {
    const id = rawId.trim();
    if (!id) {
      throw new BadRequestException(
        `A ${kind === 'STUDIO' ? 'studio' : 'performer'} id is required.`,
      );
    }
    const provider =
      await this.catalogProviderService.getConfiguredCatalogProvider();
    const key = `${provider.baseUrl}|${kind}|${id}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.value;
    }
    const site = siteOf(provider.baseUrl);
    const value = this.stashdbAdapter
      .getPendingScenes(
        { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
        { kind, id },
        PER_PAGE,
      )
      .then(({ total, scenes }) => ({
        total,
        items: scenes.map((scene) => ({
          editId: scene.editId,
          title: scene.title ?? 'Untitled scene',
          date: scene.date,
          duration: scene.duration,
          studioName: scene.studio?.name ?? null,
          performers: scene.performers.map((performer) => performer.name),
          imageUrl: withStashImageSize(scene.imageUrl, 600),
          votes: scene.votes,
          submittedAt: scene.submittedAt,
          url: `${site}/edits/${encodeURIComponent(scene.editId)}`,
        })),
      }));
    this.cache.set(key, { at: Date.now(), value });
    // A failed look isn't kept: the next one asks again.
    value.catch(() => this.cache.delete(key));
    if (this.cache.size > CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return value;
  }
}

/** The catalog's website from its GraphQL address: https://stashdb.org/graphql → https://stashdb.org. */
export function siteOf(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/graphql\/?$/i, '')
    .replace(/\/+$/, '');
}
