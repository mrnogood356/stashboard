import { Injectable, Logger } from '@nestjs/common';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashAdapter } from '../providers/stash/stash.adapter';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { isSceneStatusRequestable } from '../scene-status/dto/scene-status.dto';
import { SceneStatusService } from '../scene-status/scene-status.service';
import {
  EMPTY_EXCLUDE_RULES,
  applyExcludeRules,
} from '../scenes/scene-exclude-terms.util';
import type { ScenesFeedItemDto } from '../scenes/dto/scenes-feed.dto';
import { ScenesService } from '../scenes/scenes.service';
import {
  type SuggestionReason,
  buildTasteProfile,
  pickSources,
  rankCandidates,
  reshuffle,
} from './suggestions.util';

export interface SuggestionDto extends ScenesFeedItemDto {
  reason: SuggestionReason;
}

export interface SuggestionsDto {
  items: SuggestionDto[];
  /** Why there's nothing to show, when there isn't. */
  message: string | null;
}

/**
 * Performers and studios asked about: the ones you watch most every time,
 * and a few more drawn at random from the next ones down.
 */
const TOP_PERFORMERS = 5;
const EXTRA_PERFORMERS = 4;
const PERFORMER_POOL = 20;
const TOP_STUDIOS = 2;
const EXTRA_STUDIOS = 2;
const STUDIO_POOL = 10;
/** Scenes asked for per performer or studio (one page). */
const PER_SOURCE = 20;
/** How deep a shuffle can reach into someone's scenes (pages of PER_SOURCE). */
const MAX_PAGE = 10;
/** Enough kept that Not interested and Request leave something to fill the gap. */
const KEEP = 150;
/** Scenes shown lately, pushed down by the next shuffle. */
const RECENT_LIMIT = 120;
/** Worked out again after this long (or after Not interested). */
const TTL_MS = 6 * 60 * 60_000;
/** Lists kept for different picks of categories. */
const MAX_LISTS = 8;
/** Categories a list can be narrowed to. */
const MAX_TAGS = 10;

function normalizeTagIds(tagIds: string[]): string[] {
  return [
    ...new Set(
      tagIds.map((id) => id.trim().slice(0, 64)).filter((id) => id.length > 0),
    ),
  ]
    .sort()
    .slice(0, MAX_TAGS);
}

/**
 * "You may enjoy": catalog scenes you don't have, picked from what you watch
 * most in Stash (plays, O, ratings, favourites). Never requests anything; each
 * one says why it was picked, and Not interested hides it and makes its
 * reason count less. Everything is worked out here, from your own library.
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);
  /** One list per set of categories picked ('' for none). */
  private readonly cache = new Map<
    string,
    { at: number; value: SuggestionsDto }
  >();
  private readonly running = new Map<string, Promise<SuggestionsDto>>();
  /** How many scenes each performer or studio has, learnt as they're asked about. */
  private readonly sourceTotals = new Map<string, number>();
  /** What the last few lists put first, for a shuffle to move past. */
  private recentlyShown = new Set<string>();
  /** Used by tests for a fixed draw. */
  random: () => number = Math.random;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly catalogProvider: CatalogProviderService,
    private readonly stash: StashAdapter,
    private readonly stashdb: StashdbAdapter,
    private readonly sceneStatus: SceneStatusService,
    private readonly scenes: ScenesService,
    private readonly hiddenContent: HiddenContentService,
  ) {}

  /** `tagIds`: catalog categories; only scenes in at least one of them. */
  async list(limit = 24, tagIds: string[] = []): Promise<SuggestionsDto> {
    return this.shown(await this.current(normalizeTagIds(tagIds)), limit);
  }

  /**
   * A fresh set now: other people and studios you watch in the mix, deeper
   * into their scenes, and what was just shown moved down.
   */
  async shuffle(limit = 24, tagIds: string[] = []): Promise<SuggestionsDto> {
    const tags = normalizeTagIds(tagIds);
    return this.shown(await this.run(tags, true), limit);
  }

  /** Works the list out once at a time per set of categories, and keeps it. */
  private run(tags: string[], shuffled: boolean): Promise<SuggestionsDto> {
    const key = tags.join(',');
    const pending = this.running.get(key);
    if (pending) {
      return pending;
    }
    const work = this.build(shuffled, tags)
      .then((value) => {
        this.cache.delete(key);
        this.cache.set(key, { at: Date.now(), value });
        while (this.cache.size > MAX_LISTS) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          this.cache.delete(oldest);
        }
        return value;
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, work);
    return work;
  }

  /** The first `limit`, without any requested or brought in since; remembered as shown. */
  private async shown(
    value: SuggestionsDto,
    limit: number,
  ): Promise<SuggestionsDto> {
    // The list is kept for hours; a scene requested or brought in since is dropped.
    const statuses = await this.sceneStatus.resolveForScenes(
      value.items.map((item) => item.id),
    );
    const items = value.items
      .filter((item) => {
        const status = statuses.get(item.id);
        return !status || isSceneStatusRequestable(status);
      })
      .slice(0, limit);
    for (const item of items) {
      this.recentlyShown.add(item.id);
    }
    if (this.recentlyShown.size > RECENT_LIMIT) {
      this.recentlyShown = new Set(
        [...this.recentlyShown].slice(-RECENT_LIMIT),
      );
    }
    return { ...value, items };
  }

  /** Not interested: never shown again, and its reason counts a little less. */
  async dismiss(sceneId: string, reasonKey: string): Promise<void> {
    const key = reasonKey.trim().slice(0, 120);
    await this.prisma.suggestionDismissal.upsert({
      where: { sceneId },
      create: { sceneId, reasonKey: key },
      update: { reasonKey: key },
    });
    for (const [key, entry] of this.cache) {
      this.cache.set(key, {
        ...entry,
        value: {
          ...entry.value,
          items: entry.value.items.filter((item) => item.id !== sceneId),
        },
      });
    }
  }

  private async current(tags: string[]): Promise<SuggestionsDto> {
    const cached = this.cache.get(tags.join(','));
    if (cached && Date.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    return this.run(tags, false);
  }

  private async build(
    shuffled = false,
    tags: string[] = [],
  ): Promise<SuggestionsDto> {
    const tagKey = tags.length > 0 ? `|${tags.join(',')}` : '';
    const [stashConfig, provider] = await Promise.all([
      this.stashConfig(),
      // The instance's own catalog, never one a page is browsing: the list is shared.
      this.catalogProvider.getInstanceCatalogProvider().catch(() => null),
    ]);
    if (!stashConfig || !provider) {
      return {
        items: [],
        message: 'Needs Stash and a catalog set up in Settings → Integrations.',
      };
    }
    const watched = await this.stash.listWatchHistory(
      stashConfig,
      provider.providerKey,
    );
    const profile = buildTasteProfile(watched);
    const performers = pickSources(
      profile.performers,
      TOP_PERFORMERS,
      EXTRA_PERFORMERS,
      PERFORMER_POOL,
      this.random,
    );
    const studios = pickSources(
      profile.studios,
      TOP_STUDIOS,
      EXTRA_STUDIOS,
      STUDIO_POOL,
      this.random,
    );
    if (performers.length === 0 && studios.length === 0) {
      return {
        items: [],
        message:
          'Watch a few scenes in Stash (with performers or studios linked to the catalog) and suggestions show up here.',
      };
    }

    const catalog = { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
    const quietly = <T>(work: Promise<T>, what: string): Promise<T | null> =>
      work.catch((error: unknown) => {
        this.logger.debug(
          `You may enjoy: couldn't get ${what}: ${(error as Error)?.message}`,
        );
        return null;
      });
    const results = await Promise.all([
      ...performers.map((entry) =>
        quietly(
          this.stashdb.getScenesForPerformer({
            ...catalog,
            performerId: entry.catalogId,
            page: this.pageFor(
              `performer:${entry.catalogId}${tagKey}`,
              shuffled,
            ),
            perPage: PER_SOURCE,
            sort: 'DATE',
            direction: 'DESC',
            includeTagNames: true,
            ...(tags.length > 0 ? { tagIds: tags } : {}),
          }),
          `${entry.name}'s scenes`,
        ),
      ),
      ...studios.map((entry) =>
        quietly(
          this.stashdb.getScenesBySort({
            ...catalog,
            page: this.pageFor(`studio:${entry.catalogId}${tagKey}`, shuffled),
            perPage: PER_SOURCE,
            sort: 'DATE',
            direction: 'DESC',
            studioIds: [entry.catalogId],
            includeTagNames: true,
            ...(tags.length > 0
              ? { tagFilter: { tagIds: tags, mode: 'OR' as const } }
              : {}),
          }),
          `${entry.name}'s scenes`,
        ),
      ),
    ]);
    this.learnTotals(
      [
        ...performers.map((entry) => `performer:${entry.catalogId}${tagKey}`),
        ...studios.map((entry) => `studio:${entry.catalogId}${tagKey}`),
      ],
      results.map((result) => result?.total ?? null),
    );
    const candidates = results.flatMap((result) => result?.scenes ?? []);

    const rules =
      (await this.hiddenContent.getRules(false).catch(() => null)) ??
      EMPTY_EXCLUDE_RULES;
    const shown = applyExcludeRules(
      candidates,
      EMPTY_EXCLUDE_RULES,
      rules,
    ).scenes;
    const dismissed = await this.prisma.suggestionDismissal.findMany({
      select: { sceneId: true, reasonKey: true },
    });
    const gone = new Set(dismissed.map((row) => row.sceneId));
    const dismissals = new Map<string, number>();
    for (const row of dismissed) {
      dismissals.set(row.reasonKey, (dismissals.get(row.reasonKey) ?? 0) + 1);
    }

    const ordered = rankCandidates(
      shown.filter((scene) => !gone.has(scene.id)),
      profile,
      dismissals,
    );
    const ranked = shuffled
      ? reshuffle(ordered, this.recentlyShown, this.random)
      : ordered;
    const statuses = await this.sceneStatus.resolveForScenes(
      ranked.map((entry) => entry.scene.id),
    );
    const items = ranked
      .filter((entry) => {
        const status = statuses.get(entry.scene.id);
        return !status || isSceneStatusRequestable(status);
      })
      .slice(0, KEEP)
      .map((entry): SuggestionDto => {
        const status = statuses.get(entry.scene.id) ?? {
          state: 'NOT_REQUESTED' as const,
        };
        return {
          ...this.scenes.toScenesFeedItem(
            entry.scene,
            provider.integrationType,
            status,
            true,
          ),
          localSceneId: null,
          reason: entry.reason,
        };
      });
    this.logger.log(
      `You may enjoy: ${items.length} suggestion(s) from ${performers.length} performer(s) and ${studios.length} studio(s) you watch.`,
    );
    return {
      items,
      message:
        items.length === 0 && tags.length > 0
          ? 'Nothing in those categories from who you watch most. Try other categories, or Shuffle.'
          : items.length === 0
            ? 'Nothing new to suggest right now: you have, or have asked for, everything they’ve made lately.'
            : null,
    };
  }

  /**
   * Their newest scenes the first time; a shuffle reaches a random page of
   * the ones they have (newest still the likeliest), once their count is known.
   */
  private pageFor(key: string, shuffled: boolean): number {
    const total = this.sourceTotals.get(key);
    if (!shuffled || !total) {
      return 1;
    }
    const pages = Math.max(
      1,
      Math.min(MAX_PAGE, Math.ceil(total / PER_SOURCE)),
    );
    return 1 + Math.floor(this.random() ** 1.5 * pages);
  }

  private learnTotals(keys: string[], totals: Array<number | null>): void {
    keys.forEach((key, index) => {
      const total = totals[index];
      if (typeof total === 'number' && total > 0) {
        this.sourceTotals.set(key, total);
      }
    });
  }

  private async stashConfig(): Promise<{
    baseUrl: string;
    apiKey: string | null;
  } | null> {
    try {
      const integration = await this.integrations.findOne(
        IntegrationType.STASH,
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
