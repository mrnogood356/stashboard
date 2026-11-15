import { BadRequestException, Injectable } from '@nestjs/common';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import type { StashdbSceneFacets } from '../providers/stashdb/stashdb.types';

/** The newest scenes looked at for a performer's or studio's categories. */
const MAX_SCENES = 500;
/** Categories change slowly: an hour's old list is fine, and saves the catalog's time. */
const CACHE_MS = 60 * 60_000;
const CACHE_SIZE = 200;

/**
 * A catalog performer's or studio's own categories and studios, the most
 * used first with how many of their scenes have each, so the lists to
 * filter by open with something in them and never offer a dead end.
 */
@Injectable()
export class SceneFacetsService {
  private readonly cache = new Map<
    string,
    { at: number; value: Promise<StashdbSceneFacets> }
  >();

  constructor(
    private readonly catalogProviderService: CatalogProviderService,
    private readonly stashdbAdapter: StashdbAdapter,
  ) {}

  forPerformer(performerId: string): Promise<StashdbSceneFacets> {
    return this.facets('performer', performerId);
  }

  forStudio(studioId: string): Promise<StashdbSceneFacets> {
    return this.facets('studio', studioId);
  }

  private async facets(
    kind: 'performer' | 'studio',
    rawId: string,
  ): Promise<StashdbSceneFacets> {
    const id = rawId.trim();
    if (!id) {
      throw new BadRequestException(`A ${kind} id is required.`);
    }
    const provider =
      await this.catalogProviderService.getConfiguredCatalogProvider();
    const key = `${provider.baseUrl}|${kind}|${id}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.value;
    }

    const value = this.stashdbAdapter.getSceneFacets({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      ...(kind === 'performer' ? { performerId: id } : { studioId: id }),
      maxScenes: MAX_SCENES,
    });
    this.cache.set(key, { at: Date.now(), value });
    // A failed look isn't kept: the next one asks again.
    value.catch(() => this.cache.delete(key));
    if (this.cache.size > CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return value;
  }
}
