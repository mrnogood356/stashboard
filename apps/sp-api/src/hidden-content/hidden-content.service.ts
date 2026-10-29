import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EMPTY_EXCLUDE_RULES,
  type SceneExcludeRules,
  buildExcludeMatchers,
  parseExcludeTerms,
} from '../scenes/scene-exclude-terms.util';
import {
  HIDDEN_ITEMS_MAX,
  HIDDEN_WORDS_MAX,
  type HiddenContentSettingsDto,
  type HiddenItemDto,
  type HiddenItemKind,
  type UpdateHiddenContentSettingsDto,
} from './dto/hidden-content-settings.dto';

const SETTINGS_KEY = 'GLOBAL';
/** Every catalog list asks for the rules, so keep them for a little while. */
const RULES_TTL_MS = 60_000;

const LIST_BY_KIND = {
  tag: 'tags',
  studio: 'studios',
  performer: 'performers',
} as const satisfies Record<HiddenItemKind, keyof HiddenContentSettingsDto>;

/**
 * The saved, app-wide exclude list: words, tags, studios and performers
 * hidden from every catalog scene list (Scenes, Search, Home, performer and
 * studio pages). Library pages never use it.
 */
@Injectable()
export class HiddenContentService {
  private readonly logger = new Logger(HiddenContentService.name);
  private cached: { expiresAt: number; rules: Promise<SceneExcludeRules> } = {
    expiresAt: 0,
    rules: Promise.resolve(EMPTY_EXCLUDE_RULES),
  };
  /** Saves one at a time, so two quick "Hide" taps can't drop each other. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<HiddenContentSettingsDto> {
    const row = await this.prisma.hiddenContentSettings.findUnique({
      where: { key: SETTINGS_KEY },
    });

    return {
      words: Array.isArray(row?.words) ? row.words : [],
      tags: readItems(row?.tags),
      studios: readItems(row?.studios),
      performers: readItems(row?.performers),
      hideOwned: row?.hideOwned ?? false,
    };
  }

  updateSettings(
    dto: UpdateHiddenContentSettingsDto,
  ): Promise<HiddenContentSettingsDto> {
    return this.serialize(async () => {
      const current =
        dto.performers && dto.hideOwned !== undefined
          ? null
          : await this.getSettings();
      const saved = await this.write({
        words: dto.words,
        tags: dto.tags,
        studios: dto.studios,
        performers: dto.performers ?? current?.performers ?? [],
        hideOwned: dto.hideOwned ?? current?.hideOwned ?? false,
      });
      this.logger.log(`Hidden content saved: ${describeCounts(saved)}.`);
      return saved;
    });
  }

  /** Adds one tag, studio or performer ("Hide this studio"). */
  hideItem(
    kind: HiddenItemKind,
    item: HiddenItemDto,
  ): Promise<HiddenContentSettingsDto> {
    return this.serialize(async () => {
      const current = await this.getSettings();
      const list = LIST_BY_KIND[kind];
      if (current[list].some((entry) => entry.id === item.id.trim())) {
        this.logger.debug(`Hidden content: ${kind} ${item.id} already hidden.`);
        return current;
      }
      const saved = await this.write({
        ...current,
        [list]: [...current[list], item],
      });
      this.logger.log(`Hidden content: now hiding the ${kind} "${item.name}".`);
      return saved;
    });
  }

  /** Takes one tag, studio or performer off the list ("Stop hiding"). */
  unhideItem(
    kind: HiddenItemKind,
    id: string,
  ): Promise<HiddenContentSettingsDto> {
    return this.serialize(async () => {
      const current = await this.getSettings();
      const list = LIST_BY_KIND[kind];
      const removed = current[list].find((entry) => entry.id === id.trim());
      if (!removed) {
        return current;
      }
      const saved = await this.write({
        ...current,
        [list]: current[list].filter((entry) => entry !== removed),
      });
      this.logger.log(
        `Hidden content: stopped hiding the ${kind} "${removed.name}".`,
      );
      return saved;
    });
  }

  /**
   * The saved list, ready to match scenes against. Empty when you asked to
   * see hidden scenes, or when the list can't be read: hiding is never worth
   * breaking a page over.
   */
  async getRules(showHidden = false): Promise<SceneExcludeRules> {
    if (showHidden) {
      return EMPTY_EXCLUDE_RULES;
    }

    const now = Date.now();
    if (this.cached.expiresAt <= now) {
      this.cached = {
        expiresAt: now + RULES_TTL_MS,
        rules: this.loadRules(),
      };
    }

    return this.cached.rules;
  }

  private async write(
    settings: HiddenContentSettingsDto,
  ): Promise<HiddenContentSettingsDto> {
    const data = {
      words: parseExcludeTerms(settings.words, HIDDEN_WORDS_MAX),
      tags: dedupeItems(settings.tags) as unknown as Prisma.InputJsonValue,
      studios: dedupeItems(
        settings.studios,
      ) as unknown as Prisma.InputJsonValue,
      performers: dedupeItems(
        settings.performers,
      ) as unknown as Prisma.InputJsonValue,
      hideOwned: settings.hideOwned === true,
    };
    await this.prisma.hiddenContentSettings.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, ...data },
      update: data,
    });
    this.cached = {
      expiresAt: 0,
      rules: Promise.resolve(EMPTY_EXCLUDE_RULES),
    };

    return this.getSettings();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.saving.then(work, work);
    this.saving = next.catch(() => undefined);
    return next;
  }

  private async loadRules(): Promise<SceneExcludeRules> {
    try {
      const settings = await this.getSettings();
      const rules: SceneExcludeRules = {
        matchers: buildExcludeMatchers(settings.words),
        tagIds: new Set(settings.tags.map((tag) => tag.id)),
        studioIds: new Set(settings.studios.map((studio) => studio.id)),
        performerIds: new Set(
          settings.performers.map((performer) => performer.id),
        ),
        tagNames: new Set(settings.tags.map((tag) => tag.name.toLowerCase())),
        studioNames: new Set(
          settings.studios.map((studio) => studio.name.toLowerCase()),
        ),
      };
      this.logger.debug(
        `Hidden content rules loaded: ${describeCounts(settings)}.`,
      );
      return rules;
    } catch (error) {
      this.logger.warn(
        `Couldn't read the hidden-content list; showing everything. ${(error as Error)?.message ?? ''}`,
      );
      // Try again on the next list rather than in a minute.
      this.cached.expiresAt = 0;
      return EMPTY_EXCLUDE_RULES;
    }
  }
}

function describeCounts(settings: HiddenContentSettingsDto): string {
  return [
    `${settings.words.length} words`,
    `${settings.tags.length} tags`,
    `${settings.studios.length} studios`,
    `${settings.performers.length} performers`,
    ...(settings.hideOwned ? ['and scenes you have'] : []),
  ].join(', ');
}

/** Stored [{ id, name }] lists, ignoring anything malformed. */
function readItems(value: unknown): HiddenItemDto[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeItems(
    value.flatMap((entry) => {
      const item = entry as Record<string, unknown> | null;
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      const name = typeof item?.name === 'string' ? item.name.trim() : '';
      return id ? [{ id, name: name || id }] : [];
    }),
  );
}

function dedupeItems(items: readonly HiddenItemDto[]): HiddenItemDto[] {
  const byId = new Map<string, HiddenItemDto>();
  for (const item of items) {
    const id = item.id.trim();
    if (id && !byId.has(id)) {
      byId.set(id, { id, name: item.name.trim() || id });
    }
  }

  return [...byId.values()].slice(0, HIDDEN_ITEMS_MAX);
}
