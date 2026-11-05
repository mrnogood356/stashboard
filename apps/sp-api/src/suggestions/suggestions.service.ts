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
  rankCandidates,
} from './suggestions.util';

export interface SuggestionDto extends ScenesFeedItemDto {
  reason: SuggestionReason;
}

export interface SuggestionsDto {
  items: SuggestionDto[];
  /** Why there's nothing to show, when there isn't. */
  message: string | null;
}

/** Performers and studios you watch most that are asked about. */
const TOP_PERFORMERS = 8;
const TOP_STUDIOS = 4;
/** Newest scenes asked for per performer or studio. */
const PER_SOURCE = 20;
const KEEP = 60;
/** Worked out again after this long (or after Not interested). */
const TTL_MS = 6 * 60 * 60_000;

/**
 * "You may enjoy": catalog scenes you don't have, picked from what you watch
 * most in Stash (plays, O, ratings, favourites). Never requests anything; each
 * one says why it was picked, and Not interested hides it and makes its
 * reason count less. Everything is worked out here, from your own library.
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);
  private cache: { at: number; value: SuggestionsDto } | null = null;
  private running: Promise<SuggestionsDto> | null = null;

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

  async list(limit = 24): Promise<SuggestionsDto> {
    const value = await this.current();
    return { ...value, items: value.items.slice(0, limit) };
  }

  /** Not interested: never shown again, and its reason counts a little less. */
  async dismiss(sceneId: string, reasonKey: string): Promise<void> {
    const key = reasonKey.trim().slice(0, 120);
    await this.prisma.suggestionDismissal.upsert({
      where: { sceneId },
      create: { sceneId, reasonKey: key },
      update: { reasonKey: key },
    });
    if (this.cache) {
      this.cache = {
        ...this.cache,
        value: {
          ...this.cache.value,
          items: this.cache.value.items.filter((item) => item.id !== sceneId),
        },
      };
    }
  }

  private async current(): Promise<SuggestionsDto> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) {
      return this.cache.value;
    }
    this.running ??= this.build()
      .then((value) => {
        this.cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async build(): Promise<SuggestionsDto> {
    const [stashConfig, provider] = await Promise.all([
      this.stashConfig(),
      this.catalogProvider.getConfiguredCatalogProviderOrNull(),
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
    const performers = profile.performers.slice(0, TOP_PERFORMERS);
    const studios = profile.studios.slice(0, TOP_STUDIOS);
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
            page: 1,
            perPage: PER_SOURCE,
            sort: 'DATE',
            direction: 'DESC',
            includeTagNames: true,
          }),
          `${entry.name}'s scenes`,
        ),
      ),
      ...studios.map((entry) =>
        quietly(
          this.stashdb.getScenesBySort({
            ...catalog,
            page: 1,
            perPage: PER_SOURCE,
            sort: 'DATE',
            direction: 'DESC',
            studioIds: [entry.catalogId],
            includeTagNames: true,
          }),
          `${entry.name}'s scenes`,
        ),
      ),
    ]);
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

    const ranked = rankCandidates(
      shown.filter((scene) => !gone.has(scene.id)),
      profile,
      dismissals,
    );
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
        items.length === 0
          ? 'Nothing new to suggest right now: you have, or have asked for, everything they’ve made lately.'
          : null,
    };
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
