import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, SceneLifecycle } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { IndexingService } from '../indexing/indexing.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import {
  type CatalogProviderKey,
  getCatalogProviderLabel,
} from '../providers/catalog/catalog-provider.util';
import {
  StashAdapter,
  StashAdapterBaseConfig,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import {
  StashdbAdapter,
  StashdbMatchScene,
} from '../providers/stashdb/stashdb.adapter';
import {
  MatchConfidence,
  parseFileName,
  scoreByName,
} from './match-scoring.util';
import { WhisparrHandoffService } from './whisparr-handoff.service';
import type { UnmatchedScope, UnmatchedSort } from './dto/organizer.dto';
import { DEFAULT_RENAME_PATTERN, splitPath } from './rename.util';
import {
  CANDIDATE_TTL_MS,
  IDLE_RUN,
  LOOKUP_LIMIT,
  MAX_BACKLOG,
  MAX_CACHED_CANDIDATES,
  PAGE_SIZE,
  SCRAPE_TIMEOUT_MS,
  UNMATCHED_FILTER,
  UNMATCHED_FOLDER,
  type Context,
  type MatchCandidateDto,
  type MatchProposalDto,
  type MatchSource,
  type OrganizerRunDto,
  type SceneMatchesDto,
  type UnmatchedSceneDto,
  type WaitingCheckResult,
  type WaitingScene,
  type WhisparrSyncResult,
} from './organizer.model';
import {
  cacheKey,
  candidateId,
  fingerprintGroup,
  hostOf,
  lastFolderName,
  looksTheSame,
  messageOf,
  listDetail,
  pickSure,
  whisparrExtraCopies,
} from './organizer-plan.util';
import { copiesFromPlans, OrganizerFiles } from './organizer-files';
export * from './organizer-plan.util';
export * from './organizer.model';

/** How long "Sync with Whisparr" waits for Stash to rescan. */
const SYNC_SCAN_TIMEOUT_MS = 30 * 60_000;

/** Each list order, as Stash's sort field and direction. */
const UNMATCHED_SORT_ORDER: Record<UnmatchedSort, [string, 'ASC' | 'DESC']> = {
  'added-desc': ['created_at', 'DESC'],
  'added-asc': ['created_at', 'ASC'],
  title: ['title', 'ASC'],
  path: ['path', 'ASC'],
  date: ['date', 'DESC'],
};

@Injectable()
export class OrganizerService
  extends OrganizerFiles
  implements OnModuleInit, OnModuleDestroy
{
  /** Why linking a Whisparr import last failed, by its StashDB id. */
  private readonly linkProblems = new Map<string, string>();
  /**
   * Matches "Match all" found that you haven't checked yet, by scene. Kept
   * in the database so they last through restarts; this is a copy of it,
   * read once on first use and written through on every change.
   */
  private proposalCache: Promise<Map<string, StoredProposal>> | null = null;

  constructor(
    prisma: PrismaService,
    stash: StashAdapter,
    stashdb: StashdbAdapter,
    catalogProvider: CatalogProviderService,
    indexing: IndexingService,
    handoff: WhisparrHandoffService,
  ) {
    super(prisma, stash, stashdb, catalogProvider, indexing, handoff);
  }

  async unmatched(
    page = 1,
    options: { q?: string; sort?: UnmatchedSort; scope?: UnmatchedScope } = {},
  ): Promise<{
    total: number;
    /** How many files "Move … now" would move (first page only). */
    toMove?: number;
    page: number;
    hasMore: boolean;
    items: UnmatchedSceneDto[];
  }> {
    const config = await this.stashConfig();
    const scope = options.scope ?? 'unmatched';
    const q = options.q?.trim() ?? '';
    const [sort, direction] =
      UNMATCHED_SORT_ORDER[options.sort ?? 'added-desc'];
    const [result, toMove] = await Promise.all([
      this.stash.findOrganizerScenes(config, {
        page,
        perPage: PAGE_SIZE,
        sceneFilter:
          scope === 'all'
            ? {}
            : scope === 'unlinked'
              ? { is_missing: 'stash_id' }
              : UNMATCHED_FILTER,
        sort,
        direction,
        q,
      }),
      // Counted with the mover's own plan, so the two always agree. Only on
      // the first page of the plain list: it reads every unmatched scene.
      page === 1 && scope === 'unmatched' && !q
        ? this.getSettings()
            .then((settings) => this.unmatchedMoves(config, settings))
            .then((moves) => moves.length)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    return {
      total: result.total,
      ...(toMove !== null ? { toMove } : {}),
      page,
      hasMore: page * PAGE_SIZE < result.total,
      items: result.items.map((scene) => this.toUnmatched(scene)),
    };
  }

  /** Likely StashDB matches for each scene, best first. */
  async lookup(sceneIds: string[], query?: string): Promise<SceneMatchesDto[]> {
    const ids = [...new Set(sceneIds)].slice(
      0,
      query?.trim() ? 1 : LOOKUP_LIMIT,
    );
    if (ids.length === 0) {
      throw new BadRequestException('Pick at least one scene.');
    }
    const context = await this.context();
    const scenes = (
      await Promise.all(
        ids.map((id) => this.stash.getOrganizerScene(context.config, id)),
      )
    ).filter((scene): scene is StashOrganizerScene => scene !== null);
    return this.findMatches(context, scenes, query?.trim() || undefined);
  }

  /** Fills in a scene from the chosen StashDB match, then renames it if that's switched on. */
  async apply(
    sceneId: string,
    candidateId: string,
  ): Promise<{
    sceneId: string;
    renamedTo: string | null;
    sentToWhisparr: boolean;
    whisparrNote: string | null;
  }> {
    const cached = this.candidates.get(cacheKey(sceneId, candidateId));
    if (!cached || cached.expires < Date.now()) {
      this.logger.warn(
        `Match ${candidateId} for Stash scene ${sceneId} has expired; asked to look it up again.`,
      );
      throw new ConflictException(
        'That match has expired. Look the scene up again.',
      );
    }
    const context = await this.context();
    const scene = await this.stash.getOrganizerScene(context.config, sceneId);
    if (!scene) {
      throw new NotFoundException('That scene is no longer in Stash.');
    }
    await this.applyMatch(context, scene, cached.scene, cached.source);
    this.logger.log(
      `Matched Stash scene ${sceneId} to ${cached.source.name} scene ${candidateId}.`,
    );
    this.candidates.delete(cacheKey(sceneId, candidateId));
    await this.forgetProposals([sceneId]);
    const settings = await this.getSettings();
    let renamedTo: string | null = null;
    let sentToWhisparr = false;
    let whisparrNote: string | null = null;
    if (settings.sendToWhisparr && cached.source.primary) {
      const handed = await this.handOff(
        context.config,
        [sceneId],
        settings,
      ).catch((error: unknown) => {
        whisparrNote = messageOf(error);
        this.logger.warn(
          `Couldn't send Stash scene ${sceneId} to Whisparr: ${messageOf(error)}`,
        );
        return null;
      });
      sentToWhisparr = (handed?.sent.length ?? 0) > 0;
      whisparrNote = whisparrNote ?? handed?.failed[0]?.reason ?? null;
    }
    // Whisparr names the files it takes; rename the rest.
    if (settings.renameAfterMatch && !sentToWhisparr) {
      const result = await this.renameAndNote(
        [sceneId],
        ' after matching',
      ).catch((error: unknown) => {
        this.logger.warn(
          `Couldn't rename Stash scene ${sceneId} after matching: ${messageOf(error)}`,
        );
        return null;
      });
      renamedTo = result?.moved[0]?.to ?? null;
    }
    this.scheduleRefresh();
    return { sceneId, renamedTo, sentToWhisparr, whisparrNote };
  }

  /**
   * Goes through every unmatched scene and finds its best match, without
   * saving it: the matches wait in a list for you to check. Only imports
   * Whisparr knows the scene of are linked straight away.
   */
  startAutoMatch(
    reason: 'manual' | 'nightly' = 'manual',
    /** Just these scenes, picked on the page. */
    sceneIds?: string[],
  ): OrganizerRunDto {
    this.assertIdle();
    const only = sceneIds?.length ? [...new Set(sceneIds)] : null;
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'match',
      message: only
        ? `Looking up ${only.length} ${only.length === 1 ? 'scene' : 'scenes'}…`
        : 'Finding scenes that aren’t matched…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void this.runAutoMatch(reason, only);
    return this.status();
  }

  @Cron('0 4 * * *')
  async nightly(): Promise<void> {
    try {
      const settings = await this.getSettings();
      if (settings.autoMatchNightly && !this.runState.running) {
        this.logger.log('Starting the nightly match.');
        this.startAutoMatch('nightly');
      } else if (settings.autoMatchNightly) {
        this.logger.warn(
          'Nightly match skipped: the organizer is already busy.',
        );
      }
    } catch (error) {
      this.logger.warn(`Nightly match skipped: ${messageOf(error)}`);
    }
  }

  /** Matches found by "Match all", waiting for you to check them. */
  async matchProposals(): Promise<MatchProposalDto[]> {
    return [...(await this.proposalStore()).values()]
      .map((entry) => entry.dto)
      .sort(
        (left, right) =>
          CONFIDENCE_ORDER[left.match.confidence] -
            CONFIDENCE_ORDER[right.match.confidence] ||
          left.scene.fileName.localeCompare(right.scene.fileName),
      );
  }

  /** How many found matches are waiting for you to check. */
  async proposalCount(): Promise<number> {
    return (await this.proposalStore()).size;
  }

  /** Forgets found matches you said no to; the scenes stay unmatched. */
  async dismissProposals(sceneIds: string[]): Promise<{ left: number }> {
    await this.forgetProposals(sceneIds);
    this.logger.log(`Dismissed ${sceneIds.length} found match(es).`);
    return { left: (await this.proposalStore()).size };
  }

  /** Picks one of a found match's alternatives instead; it's still only saved when you save. */
  async chooseProposal(
    sceneId: string,
    candidateId: string,
  ): Promise<MatchProposalDto> {
    const entry = (await this.proposalStore()).get(sceneId);
    const listed = entry
      ? [entry.dto.match, ...entry.dto.alternatives].find(
          (candidate) => candidate.id === candidateId,
        )
      : undefined;
    if (!entry || !entry.choices[candidateId] || !listed) {
      throw new ConflictException(
        'That match is gone. Run Match all again to find it.',
      );
    }
    entry.dto = {
      ...entry.dto,
      match: listed,
      alternatives: [entry.dto.match, ...entry.dto.alternatives].filter(
        (candidate) => candidate.id !== candidateId,
      ),
    };
    await this.storeProposal(sceneId, entry);
    return entry.dto;
  }

  /**
   * Lists a scene's best match for you to check, with the rest as
   * alternatives. False when the matches have already expired.
   */
  private async propose(
    scene: StashOrganizerScene,
    candidates: MatchCandidateDto[],
  ): Promise<boolean> {
    const choices: StoredProposal['choices'] = {};
    const listed = candidates.filter((candidate) => {
      const cached = this.candidates.get(cacheKey(scene.id, candidate.id));
      if (cached) {
        choices[candidate.id] = {
          scene: cached.scene,
          source: storedSource(cached.source),
        };
      }
      return !!cached;
    });
    const [best, ...alternatives] = listed;
    if (!best) {
      return false;
    }
    const entry: StoredProposal = {
      dto: {
        scene: this.toUnmatched(scene),
        match: best,
        alternatives,
        others: alternatives.length,
        foundAt: new Date().toISOString(),
      },
      choices,
    };
    (await this.proposalStore()).set(scene.id, entry);
    await this.storeProposal(scene.id, entry);
    return true;
  }

  /** The found matches, read from the database the first time. */
  private proposalStore(): Promise<Map<string, StoredProposal>> {
    this.proposalCache ??= this.prisma.matchProposal
      .findMany()
      .then((rows) => {
        const store = new Map<string, StoredProposal>();
        for (const row of rows) {
          const entry = asStoredProposal(row.data);
          if (entry) {
            store.set(row.sceneId, entry);
          }
        }
        return store;
      })
      .catch((error: unknown) => {
        // Try the database again next time rather than keep an empty list.
        this.proposalCache = null;
        throw error;
      });
    return this.proposalCache;
  }

  /** Writes a found match through to the database. */
  private async storeProposal(
    sceneId: string,
    entry: StoredProposal,
  ): Promise<void> {
    const data = entry as unknown as Prisma.InputJsonValue;
    await this.prisma.matchProposal
      .upsert({
        where: { sceneId },
        create: { sceneId, data },
        update: { data },
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `Couldn't keep the found match for scene ${sceneId}: ${messageOf(error)}`,
        ),
      );
  }

  /** Drops found matches, e.g. once their scene is matched some other way. */
  private async forgetProposals(sceneIds: string[]): Promise<void> {
    if (sceneIds.length === 0) {
      return;
    }
    // A scene that's matched stays matched even if the list can't be read.
    const store = await this.proposalStore().catch(() => null);
    sceneIds.forEach((id) => store?.delete(id));
    await this.prisma.matchProposal
      .deleteMany({ where: { sceneId: { in: sceneIds } } })
      .catch((error: unknown) =>
        this.logger.warn(`Couldn't forget found matches: ${messageOf(error)}`),
      );
  }

  /** Saves the found matches you checked, then sends or renames them like any match. */
  async startSaveProposals(sceneIds: string[]): Promise<OrganizerRunDto> {
    this.assertIdle();
    const store = await this.proposalStore();
    // Checked again: another run could have started while the list was read.
    this.assertIdle();
    const picked = [...new Set(sceneIds)].filter((id) => store.has(id));
    if (picked.length === 0) {
      throw new ConflictException(
        'Those matches are gone. Run Match all again to find them.',
      );
    }
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'match',
      total: picked.length,
      message: `Saving ${picked.length} ${picked.length === 1 ? 'match' : 'matches'}…`,
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void this.saveProposals(picked);
    return this.status();
  }

  private async saveProposals(sceneIds: string[]): Promise<void> {
    const batchId = randomUUID();
    try {
      const context = await this.context();
      const settings = await this.getSettings();
      const saved: Array<{ id: string; line: string; primary: boolean }> = [];
      const failed: string[] = [];
      const store = await this.proposalStore();
      for (const id of sceneIds) {
        const entry = store.get(id);
        if (!entry) {
          continue;
        }
        try {
          const chosen = entry.choices[entry.dto.match.id];
          if (!chosen) {
            throw new Error('the chosen match is gone; run Match all again');
          }
          // Only the source's name and endpoint were kept; its API key
          // comes from today's settings.
          const source = findSource(context, chosen.source);
          if (!source) {
            throw new Error(
              `${chosen.source.name} isn't set up any more; run Match all again`,
            );
          }
          const scene = await this.stash.getOrganizerScene(context.config, id);
          if (!scene) {
            throw new Error('the scene is no longer in Stash');
          }
          await this.applyMatch(context, scene, chosen.scene, source);
          await this.forgetProposals([id]);
          this.runState.matched += 1;
          saved.push({
            id,
            line: `${entry.dto.scene.fileName} → ${describeMatch(entry.dto.match)}`,
            primary: source.primary,
          });
        } catch (error) {
          this.runState.failed += 1;
          failed.push(`${entry.dto.scene.fileName}: ${messageOf(error)}`);
        }
        this.runState.processed += 1;
      }
      const after = await this.afterMatching(
        context,
        settings,
        saved.map((entry) => entry.id),
        saved.filter((entry) => entry.primary).map((entry) => entry.id),
        batchId,
      );
      const message =
        `Saved ${saved.length} ${saved.length === 1 ? 'match' : 'matches'}` +
        (after.sent ? `, sent ${after.sent} to Whisparr` : '') +
        (after.renamed ? `, renamed ${after.renamed}` : '') +
        '.' +
        (failed.length ? ` ${failed.length} failed.` : '');
      this.finish(message);
      await this.record('match', failed.length ? 'PARTIAL' : 'DONE', message, {
        count: saved.length,
        status: failed.length ? (saved.length ? 'partial' : 'failed') : 'done',
        detail: listDetail([
          ['Saved', saved.map((entry) => entry.line)],
          ['Failed', failed],
          ['Renamed', after.renamedLines],
        ]),
        undo: after.renamed ? { type: 'rename-batch', batchId } : null,
      });
      if (saved.length > 0) {
        this.scheduleRefresh(0);
      }
    } catch (error) {
      this.finish(messageOf(error));
      await this.record('match', 'FAILED', messageOf(error), undefined, error);
    }
  }

  /** What every save of matches is followed by: Whisparr, then renaming. */
  private async afterMatching(
    context: Context,
    settings: Awaited<ReturnType<OrganizerService['getSettings']>>,
    matchedIds: string[],
    catalogMatchedIds: string[],
    batchId: string,
  ): Promise<{ sent: number; renamed: number; renamedLines: string[] }> {
    const sentIds = new Set<string>();
    if (settings.sendToWhisparr && catalogMatchedIds.length > 0) {
      this.runState.message = `Matched ${this.runState.matched}. Sending them to Whisparr…`;
      const handed = await this.handOff(
        context.config,
        catalogMatchedIds,
        settings,
      ).catch((error: unknown) => {
        this.logger.warn(
          `Sending ${catalogMatchedIds.length} matched scene(s) to Whisparr failed: ${messageOf(error)}`,
        );
        return null;
      });
      handed?.sent.forEach((entry) => sentIds.add(entry.sceneId));
    }
    // Whisparr names the files it takes; rename the rest.
    const toRename = matchedIds.filter((id) => !sentIds.has(id));
    let renamedLines: string[] = [];
    if (settings.renameAfterMatch && toRename.length > 0) {
      this.runState.message = `Matched ${this.runState.matched}. Renaming their files…`;
      const renamed = await this.renameScenes(toRename, batchId).catch(
        () => null,
      );
      this.runState.renamed = renamed?.moved.length ?? 0;
      renamedLines = (renamed?.moved ?? []).map(
        (entry) => `${entry.from} → ${entry.to}`,
      );
    }
    return { sent: sentIds.size, renamed: this.runState.renamed, renamedLines };
  }

  private async runAutoMatch(
    reason: 'manual' | 'nightly',
    only: string[] | null = null,
  ): Promise<void> {
    const batchId = randomUUID();
    try {
      const context = await this.context();
      const settings = await this.getSettings();
      await this.record(
        'match',
        'RUNNING',
        reason === 'nightly' ? 'Nightly match started.' : 'Match started.',
      );
      const ids =
        only ?? (await this.collectIds(context.config, UNMATCHED_FILTER));
      this.runState.total = ids.length;
      const matchedIds: string[] = [];
      const linkedLines: string[] = [];
      let found = 0;
      // Whisparr's own imports are linked to the scene they were downloaded
      // for first: that's known, not guessed. The rest are looked up by
      // fingerprint and name and wait for you to check them.
      const whisparrFiles = ids.length > 0 ? await this.whisparrFiles() : [];
      for (let index = 0; index < ids.length; index += LOOKUP_LIMIT) {
        const chunk = ids.slice(index, index + LOOKUP_LIMIT);
        const scenes = (
          await Promise.all(
            chunk.map((id) =>
              this.stash
                .getOrganizerScene(context.config, id)
                .catch(() => null),
            ),
          )
        ).filter((scene): scene is StashOrganizerScene => scene !== null);
        const linked = await this.linkFromWhisparr(
          context,
          scenes,
          whisparrFiles,
        );
        this.runState.matched += linked.length;
        matchedIds.push(...linked);
        await this.forgetProposals(linked);
        linked.forEach((id) => {
          const scene = scenes.find((entry) => entry.id === id);
          linkedLines.push(this.toUnmatched(scene!).fileName);
        });
        const toMatch = scenes.filter((scene) => !linked.includes(scene.id));
        let results: SceneMatchesDto[] = [];
        try {
          results = await this.findMatches(context, toMatch);
        } catch (error) {
          this.runState.failed += chunk.length;
          this.logger.warn(`Match lookup failed: ${messageOf(error)}`);
        }
        for (const result of results) {
          const scene = scenes.find((entry) => entry.id === result.sceneId);
          // A weak guess isn't worth checking; it stays in the list to pick by hand.
          if (
            !scene ||
            result.candidates[0]?.confidence === 'weak' ||
            !(await this.propose(scene, result.candidates))
          ) {
            this.runState.skipped += 1;
            continue;
          }
          found += 1;
        }
        this.runState.processed = Math.min(ids.length, index + chunk.length);
        this.runState.message = `Checked ${this.runState.processed} of ${ids.length}. Found ${found} to check.`;
      }
      // Imports Whisparr has that never got linked show as "waiting for
      // import" even with the file in Stash; link those too (not when only
      // a few scenes were picked).
      const waiting = only ? [] : await this.waitingStashIds();
      const linkedWaiting =
        waiting.length > 0 ? await this.linkWaitingScenes(waiting) : [];
      const after = await this.afterMatching(
        context,
        settings,
        matchedIds,
        matchedIds,
        batchId,
      );
      let tidied = 0;
      if (settings.moveUnmatched && !only) {
        this.runState.message =
          'Moving what’s still unmatched to the Unmatched folder…';
        const moved = await this.moveUnmatchedFiles(
          context.config,
          settings,
          batchId,
        ).catch((error: unknown) => {
          this.logger.warn(
            `Moving unmatched files failed: ${messageOf(error)}`,
          );
          return null;
        });
        tidied = moved?.moved ?? 0;
      }
      const notFound = ids.length - matchedIds.length - found;
      const message =
        ids.length === 0 && !only
          ? linkedWaiting.length
            ? `Every scene is matched; linked ${linkedWaiting.length} waiting for import.`
            : 'Every scene is already matched.'
          : `Checked ${ids.length}: found matches for ${found} to check before they’re saved` +
            (matchedIds.length
              ? `, linked ${matchedIds.length} Whisparr imports`
              : '') +
            (linkedWaiting.length
              ? `, linked ${linkedWaiting.length} waiting for import`
              : '') +
            (tidied
              ? `, moved ${tidied} unmatched to ${UNMATCHED_FOLDER}`
              : '') +
            (after.sent ? `, sent ${after.sent} to Whisparr` : '') +
            (after.renamed ? `, renamed ${after.renamed}` : '') +
            `.` +
            (notFound > 0 ? ` Nothing likely for ${notFound}.` : '') +
            (this.runState.failed ? ` ${this.runState.failed} failed.` : '');
      this.finish(message);
      await this.record('match', 'DONE', message, {
        count: found + matchedIds.length,
        detail: listDetail([
          [
            'Found, waiting for you to check',
            [...(await this.proposalStore()).values()]
              .filter((entry) => ids.includes(entry.dto.scene.id))
              .map(
                (entry) =>
                  `${entry.dto.scene.fileName} → ${describeMatch(entry.dto.match)}`,
              ),
          ],
          ['Linked from Whisparr', linkedLines],
          ['Renamed', after.renamedLines],
        ]),
        undo:
          after.renamed || tidied ? { type: 'rename-batch', batchId } : null,
      });
      if (matchedIds.length > 0) {
        this.scheduleRefresh(0);
      }
    } catch (error) {
      this.finish(messageOf(error));
      await this.record('match', 'FAILED', messageOf(error), undefined, error);
    }
  }

  /**
   * Looks every scene up in each source, in order: the main catalog, then the
   * other stash-boxes. Fingerprint matches win; otherwise the file name is
   * searched everywhere and the results are scored together.
   */
  private async findMatches(
    context: Context,
    scenes: StashOrganizerScene[],
    query?: string,
  ): Promise<SceneMatchesDto[]> {
    const groups = query
      ? scenes.map(() => [])
      : scenes.map((scene) => fingerprintGroup(scene.files));
    const withPrints = groups
      .map((group, index) => ({ group, index }))
      .filter((entry) => entry.group.length > 0);
    // Scene index → the first source that knows its fingerprint, and what it found.
    const byPrint = new Map<
      number,
      { source: MatchSource; matches: StashdbMatchScene[] }
    >();
    for (const source of context.sources) {
      const pending = withPrints.filter((entry) => !byPrint.has(entry.index));
      if (pending.length === 0) {
        break;
      }
      try {
        const lists = await this.stashdb.findScenesByFingerprints(
          source.api,
          pending.map((entry) => entry.group),
          source.primary,
        );
        pending.forEach((entry, position) => {
          const matches = lists[position] ?? [];
          if (matches.length > 0) {
            byPrint.set(entry.index, { source, matches });
          }
        });
      } catch (error) {
        this.logger.warn(
          `Fingerprint lookup on ${source.name} failed: ${messageOf(error)}`,
        );
      }
    }

    const results: SceneMatchesDto[] = [];
    for (const [index, scene] of scenes.entries()) {
      const file = scene.files[0] ?? null;
      const duration = file?.duration ?? null;
      const printed = byPrint.get(index);
      const pool = new Map<
        string,
        { scene: StashdbMatchScene; source: MatchSource }
      >();
      let candidates: MatchCandidateDto[] = [];
      let searchedFor: string | null = null;
      if (printed) {
        candidates = printed.matches.map((match) => {
          pool.set(candidateId(printed.source, match), {
            scene: match,
            source: printed.source,
          });
          const diff =
            duration && match.duration
              ? Math.abs(duration - match.duration)
              : 0;
          return this.toCandidate(match, printed.source, {
            score: diff > 15 ? 0.8 : 1,
            confidence: diff > 15 ? 'likely' : 'exact',
            reasons:
              diff > 15
                ? ['Same video fingerprint', 'Different length']
                : ['Same video fingerprint'],
          });
        });
      } else {
        const { folder } = file ? splitPath(file.path) : { folder: '' };
        const fromFile = parseFileName(
          file?.basename ?? scene.title ?? '',
          lastFolderName(folder),
        );
        const typed = query ? parseFileName(query) : null;
        // Your own words decide the search; the file name still helps rank the results.
        const parsed = typed
          ? {
              text: query!.trim(),
              tokens: [...new Set([...typed.tokens, ...fromFile.tokens])],
              date: typed.date ?? fromFile.date,
              compact: `${typed.compact} ${fromFile.compact}`,
            }
          : fromFile;
        searchedFor = parsed.text || null;
        if (parsed.text) {
          for (const source of context.sources) {
            let found = await this.stashdb
              .searchScenesByText(source.api, parsed.text, 8, source.primary)
              .catch(() => [] as StashdbMatchScene[]);
            if (found.length === 0 && parsed.tokens.length > 4) {
              await this.pause(250);
              found = await this.stashdb
                .searchScenesByText(
                  source.api,
                  parsed.tokens.slice(0, 4).join(' '),
                  8,
                  source.primary,
                )
                .catch(() => [] as StashdbMatchScene[]);
            }
            await this.pause(250);
            for (const match of found) {
              pool.set(candidateId(source, match), { scene: match, source });
              candidates.push(
                this.toCandidate(
                  match,
                  source,
                  scoreByName(parsed, duration, match),
                ),
              );
            }
          }
        }
      }
      // Best first; on a tie, the earlier source (your main catalog) first.
      const order = new Map(
        context.sources.map((source, position) => [source.name, position]),
      );
      candidates.sort(
        (left, right) =>
          right.score - left.score ||
          (order.get(left.source) ?? 0) - (order.get(right.source) ?? 0),
      );
      const top = candidates.slice(0, 6);
      for (const candidate of top) {
        const entry = pool.get(candidate.id);
        if (entry) {
          this.remember(scene.id, candidate.id, entry.scene, entry.source);
        }
      }
      results.push({ sceneId: scene.id, searchedFor, candidates: top });
    }
    return results;
  }

  private toCandidate(
    match: StashdbMatchScene,
    source: MatchSource,
    score: { score: number; confidence: MatchConfidence; reasons: string[] },
  ): MatchCandidateDto {
    return {
      id: candidateId(source, match),
      source: source.name,
      title: match.title,
      date: match.date,
      studio: match.studio?.name ?? null,
      performers: match.performers.map(
        (performer) => performer.as ?? performer.name,
      ),
      cast: match.performers.map((performer) => ({
        name: performer.as ?? performer.name,
        imageUrl: performer.imageUrl ?? null,
      })),
      studioImageUrl: match.studio?.imageUrl ?? null,
      tags: match.tags.map((tag) => tag.name),
      imageUrl: match.imageUrl,
      duration: match.duration,
      code: match.code,
      score: score.score,
      confidence: score.confidence,
      reasons: score.reasons,
    };
  }

  private remember(
    sceneId: string,
    candidateId: string,
    scene: StashdbMatchScene,
    source: MatchSource,
  ): void {
    if (this.candidates.size >= MAX_CACHED_CANDIDATES) {
      const now = Date.now();
      for (const [key, value] of this.candidates) {
        if (
          value.expires < now ||
          this.candidates.size >= MAX_CACHED_CANDIDATES
        ) {
          this.candidates.delete(key);
        }
        if (this.candidates.size < MAX_CACHED_CANDIDATES * 0.8) {
          break;
        }
      }
    }
    this.candidates.set(cacheKey(sceneId, candidateId), {
      scene,
      source,
      expires: Date.now() + CANDIDATE_TTL_MS,
    });
  }

  private async applyMatch(
    context: Context,
    scene: StashOrganizerScene,
    match: StashdbMatchScene,
    source: MatchSource,
  ): Promise<void> {
    const endpoint = source.endpoint;
    const identify = context.identify;
    const studioId = match.studio
      ? await this.stash.ensureStudio(context.config, {
          name: match.studio.name,
          stashId: match.studio.id,
          endpoint,
          imageUrl: match.studio.imageUrl,
          create: identify?.createMissing.studio !== false,
        })
      : null;
    // Stash's Identify can leave out male performers; matching does the same.
    const performers =
      identify?.includeMalePerformers === false
        ? match.performers.filter(
            (performer) => performer.gender?.toUpperCase() !== 'MALE',
          )
        : match.performers;
    const performerIds: string[] = [];
    for (const performer of performers) {
      const id = await this.stash.ensurePerformer(context.config, {
        name: performer.name,
        disambiguation: performer.disambiguation,
        gender: performer.gender,
        stashId: performer.id,
        endpoint,
        imageUrl: performer.imageUrl,
        create: identify?.createMissing.performers !== false,
      });
      if (id) {
        performerIds.push(id);
      }
    }
    const tagIds = new Set(scene.tagIds);
    for (const tag of match.tags) {
      const id = await this.stash.ensureTag(
        context.config,
        tag.name,
        identify?.createMissing.tags !== false,
      );
      if (id) {
        tagIds.add(id);
      }
    }
    await this.stash.applySceneMatch(context.config, scene.id, {
      title: match.title,
      code: match.code,
      details: match.details,
      director: match.director,
      date: match.date,
      urls: match.urls,
      studioId,
      performerIds: [...new Set(performerIds)],
      tagIds: [...tagIds],
      coverImageUrl: match.imageUrl,
      stashIds: [
        ...scene.stashIds.filter((entry) => entry.endpoint !== endpoint),
        { endpoint, stashId: match.id },
      ],
    });
  }

  /**
   * Identifies scenes Stash just picked up. A file Whisparr imported is
   * linked straight to the StashDB scene it was downloaded for: no guessing,
   * no fingerprints needed. The same video fingerprint is saved too; a
   * likely name match joins the found-matches list for you to check. Scenes
   * already linked to the catalog are left alone.
   */
  async identifyNewScenes(sceneIds: string[]): Promise<{
    linked: string[];
    matched: string[];
    /** Found a likely match, waiting for you to check it. */
    proposed: string[];
    left: string[];
  }> {
    const done = {
      linked: [] as string[],
      matched: [] as string[],
      proposed: [] as string[],
    };
    if (sceneIds.length === 0) {
      return { ...done, left: [] };
    }
    const context = await this.context();
    const primary = context.sources.find((source) => source.primary);
    const loaded = (
      await Promise.all(
        sceneIds.map((id) =>
          this.stash
            .getOrganizerScene(context.config, id)
            .catch((error: unknown) => {
              this.logger.warn(
                `Couldn't load Stash scene ${id} to identify it: ${messageOf(error)}`,
              );
              return null;
            }),
        ),
      )
    ).filter((scene): scene is StashOrganizerScene => scene !== null);
    const alreadyLinked = new Set(
      loaded
        .filter(
          (scene) =>
            primary &&
            scene.stashIds.some((entry) => entry.endpoint === primary.endpoint),
        )
        .map((scene) => scene.id),
    );
    const scenes = loaded.filter((scene) => !alreadyLinked.has(scene.id));

    done.linked.push(
      ...(await this.linkFromWhisparr(
        context,
        scenes,
        await this.whisparrFiles(),
      )),
    );
    const rest = scenes.filter((scene) => !done.linked.includes(scene.id));

    for (let index = 0; index < rest.length; index += LOOKUP_LIMIT) {
      const chunk = rest.slice(index, index + LOOKUP_LIMIT);
      const results = await this.findMatches(context, chunk).catch(
        (error: unknown) => {
          this.logger.warn(`Match lookup failed: ${messageOf(error)}`);
          return [] as SceneMatchesDto[];
        },
      );
      for (const result of results) {
        // Only the same video fingerprint is saved unseen; a name match
        // waits in the found-matches list for you to check.
        const sure = pickSure(result.candidates);
        const pick = sure?.confidence === 'exact' ? sure : null;
        const scene = chunk.find((entry) => entry.id === result.sceneId);
        const best = result.candidates[0];
        if (scene && !pick && best && best.confidence !== 'weak') {
          if (await this.propose(scene, result.candidates)) {
            done.proposed.push(scene.id);
          }
        }
        const cached = pick
          ? this.candidates.get(cacheKey(result.sceneId, pick.id))
          : undefined;
        if (!scene || !cached) {
          continue;
        }
        try {
          await this.applyMatch(context, scene, cached.scene, cached.source);
          done.matched.push(scene.id);
        } catch (error) {
          this.logger.warn(
            `Couldn't save match for scene ${scene.id}: ${messageOf(error)}`,
          );
        }
      }
    }
    if (done.linked.length + done.matched.length > 0) {
      await this.forgetProposals([...done.linked, ...done.matched]);
      this.scheduleRefresh();
    }
    this.logger.log(
      `Identified new scenes: ${sceneIds.length} checked, ${done.linked.length} linked from Whisparr, ${done.matched.length} matched by fingerprint, ${done.proposed.length} waiting for you to check, ${alreadyLinked.size} already linked.`,
    );
    const identified = new Set([...done.linked, ...done.matched]);
    return {
      ...done,
      // Including scenes Stash couldn't show us, so another step can try them.
      left: sceneIds.filter(
        (id) => !identified.has(id) && !alreadyLinked.has(id),
      ),
    };
  }

  /**
   * Scenes Whisparr has a file for that Stash's copy isn't linked to (they
   * show as "waiting for import" though the file is there): finds each by
   * Whisparr's file path and links it to its StashDB scene.
   */
  async linkWaitingScenes(stashIds: string[]): Promise<string[]> {
    const wanted = new Set(stashIds);
    const files = (await this.whisparrFiles()).filter((file) =>
      wanted.has(file.stashId),
    );
    if (files.length === 0) {
      return [];
    }
    const context = await this.context();
    const scenes: StashOrganizerScene[] = [];
    const owners: typeof files = [];
    for (const file of files) {
      const found = await this.stashScenesForFile(
        context.config,
        file.filePath,
      );
      for (const scene of found) {
        if (!scenes.some((entry) => entry.id === scene.id)) {
          scenes.push(scene);
        }
        // Found by name in another folder: own it by where Stash has it.
        scene.files.forEach((entry) =>
          owners.push({ ...file, filePath: entry.path }),
        );
      }
    }
    const linked = await this.linkFromWhisparr(context, scenes, owners);
    if (linked.length > 0) {
      this.scheduleRefresh();
    }
    this.logger.log(
      `Linked ${linked.length} of ${files.length} scene(s) waiting for import to their catalog scenes.`,
    );
    return linked;
  }

  /** StashDB ids Whisparr has a file for that Stash doesn't show as in the library yet. */
  protected async waitingStashIds(): Promise<string[]> {
    const rows = await this.prisma.sceneIndex
      .findMany({
        where: { whisparrHasFile: true, NOT: { stashAvailable: true } },
        select: { stashId: true },
        take: MAX_BACKLOG,
      })
      .catch(() => [] as Array<{ stashId: string }>);
    return rows.map((row) => row.stashId);
  }

  // ---------- sync with Whisparr ----------

  /** "Sync with Whisparr" from the page, in the background. */
  startWhisparrSync(): OrganizerRunDto {
    this.assertIdle();
    void this.syncWithWhisparr().catch((error: unknown) =>
      this.logger.debug(`Whisparr sync ended early: ${messageOf(error)}`),
    );
    return this.status();
  }

  /**
   * Gets Stash and Whisparr back in step after imports that copy or
   * hardlink: Stash rescans the folders it's out of date on (Whisparr's
   * scenes it hasn't picked up, files that moved away), then the extra
   * copies are removed and scenes waiting for import are linked. Runs as
   * the organizer's background run, so the page shows its progress.
   */
  async syncWithWhisparr(): Promise<WhisparrSyncResult> {
    this.assertIdle();
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'sync',
      total: 3,
      message: 'Checking what Stash is out of date on…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    try {
      const result = await this.runWhisparrSync();
      this.finish(result.message);
      await this.record(
        'sync',
        result.failed && !result.removed && !result.linked ? 'FAILED' : 'DONE',
        result.message,
      );
      if (result.rescanned + result.removed + result.linked > 0) {
        this.scheduleRefresh(0);
      }
      return result;
    } catch (error) {
      this.finish(messageOf(error));
      await this.record('sync', 'FAILED', messageOf(error), undefined, error);
      throw error;
    }
  }

  private async runWhisparrSync(): Promise<WhisparrSyncResult> {
    if (!(await this.handoff.isAvailable())) {
      throw new ConflictException(
        'Set up Whisparr in Settings → Integrations first.',
      );
    }
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    const pattern = settings.renamePattern || DEFAULT_RENAME_PATTERN;
    const plan = () =>
      this.planAll(
        config,
        pattern,
        settings.skipWhisparrFiles,
        settings.renameRoot,
        false,
      );
    const problems: string[] = [];

    // 1. Rescan where Stash is out of date.
    const [files, waiting] = await Promise.all([
      this.whisparrFiles(),
      this.waitingStashIds(),
    ]);
    const waitingSet = new Set(waiting);
    const folders = new Set<string>();
    for (const file of files) {
      if (waitingSet.has(file.stashId)) {
        folders.add(splitPath(file.filePath).folder);
      }
    }
    const before = await plan().catch((error: unknown) => {
      problems.push(messageOf(error));
      return [] as Awaited<ReturnType<typeof plan>>;
    });
    for (const entry of before) {
      if (entry.state === 'gone' && entry.from) {
        folders.add(splitPath(entry.from).folder);
      } else if (entry.state === 'taken' && entry.to) {
        folders.add(splitPath(entry.to).folder);
      }
    }
    const toScan = [...folders].filter(Boolean);
    this.runState.processed = 0;
    if (toScan.length > 0) {
      this.runState.message = `Rescanning ${toScan.length} ${toScan.length === 1 ? 'folder' : 'folders'} in Stash…`;
      const job = await this.stash.scanPaths(config, toScan);
      this.markRescanned(toScan);
      const outcome = job
        ? await this.stash.waitForJob(config, job, {
            sleep: this.pause,
            timeoutMs: SYNC_SCAN_TIMEOUT_MS,
          })
        : 'FINISHED';
      if (outcome !== 'FINISHED') {
        problems.push(`Stash’s scan ${outcome.toLowerCase()}`);
      }
    }
    this.runState.processed = 1;

    // 2. Remove extra copies: the preview's, and Whisparr's imports Stash
    // added to a scene that already had the same video.
    this.runState.message = 'Removing extra copies…';
    const after =
      toScan.length > 0
        ? await plan().catch((error: unknown) => {
            this.logger.warn(
              `Couldn't re-plan after the Stash scan; using the earlier plan: ${messageOf(error)}`,
            );
            return before;
          })
        : before;
    const multiFile = await this.scenesWithSeveralFiles(config);
    const copies = [
      ...copiesFromPlans(after),
      ...whisparrExtraCopies(
        multiFile,
        // Whisparr's files as they are now, after the rescan.
        (await this.whisparrFiles()).map((file) => file.filePath),
      ),
    ];
    const removal = await this.removeCopies(config, copies);
    this.runState.renamed = removal.removed;
    this.runState.failed = removal.failed.length;
    this.runState.processed = 2;

    // 3. Link scenes waiting for an import that already happened.
    this.runState.message = 'Linking scenes waiting for import…';
    const linked =
      waiting.length > 0
        ? await this.linkWaitingScenes(waiting).catch((error: unknown) => {
            problems.push(messageOf(error));
            return [] as string[];
          })
        : [];
    this.runState.matched = linked.length;
    this.runState.processed = 3;
    if (linked.length > 0) {
      await this.indexing
        .requestImmediateRefresh(waiting, 'whisparr-sync')
        .catch((error: unknown) =>
          this.logger.debug(
            `Refresh after Whisparr sync failed: ${messageOf(error)}`,
          ),
        );
    }

    const steps = [
      ...(toScan.length
        ? [
            `rescanned ${toScan.length} ${toScan.length === 1 ? 'folder' : 'folders'}`,
          ]
        : []),
      ...(removal.removed
        ? [
            `removed ${removal.removed} extra ${removal.removed === 1 ? 'copy' : 'copies'}`,
          ]
        : []),
      ...(linked.length
        ? [
            `linked ${linked.length} ${linked.length === 1 ? 'scene' : 'scenes'}`,
          ]
        : []),
    ];
    const sentence = (text: string) => ` ${text.replace(/[.\s]+$/, '')}.`;
    const failedNote = removal.failed.length
      ? sentence(
          `${removal.failed.length} ${removal.failed.length === 1 ? 'copy' : 'copies'} couldn’t be removed: ${removal.failed[0].reason}`,
        )
      : '';
    const problemNote = problems.length ? sentence(problems[0]) : '';
    const summary = steps.length
      ? `${steps.join(', ').replace(/^./, (first) => first.toUpperCase())}.`
      : 'Stash and Whisparr already agree. Nothing to tidy up.';
    return {
      rescanned: toScan.length,
      removed: removal.removed,
      linked: linked.length,
      failed: removal.failed.length,
      steps,
      message: `${summary}${failedNote}${problemNote}`,
    };
  }

  /** Scenes with more than one file (empty if this Stash can't filter on that). */
  private async scenesWithSeveralFiles(
    config: StashAdapterBaseConfig,
  ): Promise<StashOrganizerScene[]> {
    const scenes: StashOrganizerScene[] = [];
    try {
      for (let page = 1; page <= MAX_BACKLOG / 100; page += 1) {
        const result = await this.stash.findOrganizerScenes(config, {
          page,
          perPage: 100,
          sceneFilter: { file_count: { value: 1, modifier: 'GREATER_THAN' } },
        });
        scenes.push(...result.items);
        if (page * 100 >= result.total || result.items.length === 0) {
          break;
        }
      }
    } catch (error) {
      this.logger.warn(
        `Couldn't list scenes with several files: ${messageOf(error)}`,
      );
    }
    return scenes;
  }

  /**
   * The Stash scenes with this file. When nothing is at that exact path (the
   * path mapping is off, or the file was moved since), a single scene with
   * a file of the same name anywhere in the library counts.
   */
  protected async stashScenesForFile(
    config: StashAdapterBaseConfig,
    filePath: string,
  ): Promise<StashOrganizerScene[]> {
    const find = (value: string, modifier: 'EQUALS' | 'INCLUDES') =>
      this.stash
        .findOrganizerScenes(config, {
          page: 1,
          perPage: 5,
          sceneFilter: { path: { value, modifier } },
        })
        .then((found) => found.items)
        .catch(() => [] as StashOrganizerScene[]);
    const exact = await find(filePath, 'EQUALS');
    if (exact.length > 0) {
      return exact;
    }
    const name = splitPath(filePath).basename;
    if (!name) {
      return [];
    }
    const named = (await find(name, 'INCLUDES')).filter((scene) =>
      scene.files.some((file) =>
        looksTheSame(splitPath(file.path).basename, name),
      ),
    );
    return named.length === 1 ? named : [];
  }

  /**
   * Fixes what it can for every scene the Acquisition page shows as waiting
   * for import (a stale status, a file Stash has but never linked), then
   * says why each one left is still waiting.
   */
  async checkWaitingScenes(): Promise<WaitingCheckResult> {
    const waiting = (only?: string[]) =>
      this.prisma.sceneIndex.findMany({
        where: {
          computedLifecycle: SceneLifecycle.IMPORT_PENDING,
          ...(only ? { stashId: { in: only } } : {}),
        },
        select: {
          stashId: true,
          title: true,
          whisparrQueueStatus: true,
          whisparrQueueState: true,
        },
        take: MAX_BACKLOG,
      });
    const before = await waiting();
    if (before.length === 0) {
      return { checked: 0, fixed: 0, left: [] };
    }
    const ids = before.map((row) => row.stashId);
    // A fresh look at Whisparr and Stash clears anything only out of date.
    await this.indexing.requestImmediateRefresh(ids, 'waiting-check');
    let left = await waiting(ids);
    if (left.length > 0) {
      const linked = await this.linkWaitingScenes(
        left.map((row) => row.stashId),
      );
      if (linked.length > 0) {
        await this.indexing.requestImmediateRefresh(
          left.map((row) => row.stashId),
          'waiting-check',
        );
        left = await waiting(ids);
      }
    }
    this.logger.log(
      `Checked ${before.length} scene(s) waiting for import: ${before.length - left.length} fixed, ${left.length} still waiting.`,
    );
    return {
      checked: before.length,
      fixed: before.length - left.length,
      left: await this.explainWaiting(left),
    };
  }

  /**
   * Counts Whisparr's StashDB scene as the one Stash has its file linked
   * to, so it stops waiting for import. Stash allows one StashDB link per
   * scene, so Stashboard remembers the pair itself.
   */
  async markSameScene(stashId: string): Promise<WaitingCheckResult> {
    const file = (await this.whisparrFiles()).find(
      (entry) => entry.stashId === stashId,
    );
    if (!file) {
      throw new NotFoundException('Whisparr no longer lists a file for it.');
    }
    const context = await this.context();
    const primary = context.sources.find((source) => source.primary);
    if (!primary) {
      throw new ConflictException('Set up StashDB or FansDB first.');
    }
    const [scene] = await this.stashScenesForFile(
      context.config,
      file.filePath,
    );
    if (!scene) {
      throw new NotFoundException('Stash has no file at this path.');
    }
    const linkedTo = scene.stashIds.find(
      (entry) => entry.endpoint === primary.endpoint,
    )?.stashId;
    if (!linkedTo) {
      throw new ConflictException(
        `Stash hasn’t linked this file to ${primary.name} yet. Match it in Library Tools first.`,
      );
    }
    await this.rememberSameScene(stashId, linkedTo);
    this.logger.log(
      `Counted Whisparr's scene ${stashId} as the same as Stash's ${primary.name} scene ${linkedTo}.`,
    );
    this.linkProblems.delete(stashId);
    await this.indexing.requestImmediateRefresh([stashId], 'waiting-link');
    return this.checkWaitingScenes();
  }

  /** Whisparr's stashId is the scene Stash has as aliasOf. */
  protected async rememberSameScene(
    stashId: string,
    aliasOf: string,
  ): Promise<void> {
    if (stashId === aliasOf) {
      return;
    }
    await this.prisma.sceneStashAlias.upsert({
      where: { stashId },
      create: { stashId, aliasOf },
      update: { aliasOf },
    });
  }

  /**
   * Files deleted outside Whisparr (Duplicates, Samples): Whisparr keeps
   * listing them until it looks again, and they'd show as waiting for
   * import. Have it look again, then refresh those scenes here.
   */
  async forgetDeletedFiles(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    const gone = (await this.whisparrFiles()).filter((file) =>
      paths.some((path) => sameFile(path, file.filePath)),
    );
    if (gone.length === 0) {
      return;
    }
    await this.handoff
      .refreshMovies(gone.map((file) => file.movieId))
      .catch((error: unknown) =>
        this.logger.warn(
          `Couldn't ask Whisparr to look for deleted files again: ${messageOf(error)}`,
        ),
      );
    this.refreshSoon(gone.map((file) => file.stashId));
  }

  /** Whisparr's refresh runs in the background; look again once it's had time. */
  protected refreshSoon(stashIds: string[], delayMs = 20_000): void {
    setTimeout(() => {
      void this.indexing
        .requestImmediateRefresh(stashIds, 'whisparr-refresh')
        .catch((error: unknown) =>
          this.logger.debug(
            `Refresh after Whisparr rescan failed: ${messageOf(error)}`,
          ),
        );
    }, delayMs).unref?.();
  }

  /** Why each scene still waits, in words for the Acquisition page. */
  protected async explainWaiting(
    rows: Array<{
      stashId: string;
      title: string | null;
      whisparrQueueStatus?: string | null;
      whisparrQueueState?: string | null;
    }>,
    /** Ask Whisparr to look again for files Stash has nothing at. */
    nudge = true,
  ): Promise<WaitingScene[]> {
    if (rows.length === 0) {
      return [];
    }
    const [files, context] = await Promise.all([
      this.whisparrFiles(),
      this.context(),
    ]);
    const primary = context.sources.find((source) => source.primary);
    const catalog = primary?.name ?? 'the catalog';
    const explained: WaitingScene[] = [];
    const lookAgain: Array<{ movieId: number; stashId: string }> = [];
    for (const row of rows) {
      const file = files.find((entry) => entry.stashId === row.stashId);
      const base = {
        stashId: row.stashId,
        title: row.title,
        path: null,
        linkedTo: null,
      };
      // Still in Whisparr's queue: the download finished and Whisparr is
      // moving it into your library. Nothing for Stash to do yet.
      if (row.whisparrQueueStatus && !file) {
        const step = (row.whisparrQueueState ?? row.whisparrQueueStatus)
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase();
        explained.push({
          ...base,
          kind: 'importing',
          reason: `The download finished and Whisparr is importing it (Whisparr says: ${step}). It shows up in Stash after Whisparr moves the file and Stash scans it.`,
        });
        continue;
      }
      if (!file) {
        explained.push({
          ...base,
          kind: 'no-whisparr-file',
          reason:
            files.length === 0
              ? 'Couldn’t ask Whisparr for its files, so there’s no telling where the file is. Check that Whisparr is reachable.'
              : 'Whisparr says it has this scene, but lists no file for it now (deleted or moved by hand). Open it in Whisparr and rescan or search again.',
        });
        continue;
      }
      const [scene] = await this.stashScenesForFile(
        context.config,
        file.filePath,
      );
      const linkedTo = scene?.stashIds.find(
        (entry) => entry.endpoint === primary?.endpoint,
      )?.stashId;
      const problem = this.linkProblems.get(row.stashId);
      const linkedHere = scene?.stashIds.some(
        (entry) =>
          entry.endpoint === primary?.endpoint && entry.stashId === row.stashId,
      );
      const other = !linkedHere && linkedTo ? linkedTo : null;
      if (!scene) {
        lookAgain.push({ movieId: file.movieId, stashId: row.stashId });
      }
      explained.push({
        ...base,
        path: file.filePath,
        linkedTo: other,
        kind: !scene
          ? 'not-in-stash'
          : problem
            ? 'not-linked'
            : other
              ? 'other-scene'
              : linkedHere
                ? 'catching-up'
                : 'not-linked',
        reason: !scene
          ? 'Whisparr has the file at the path below, but Stash has nothing there. Usually Stash hasn’t scanned that folder yet, or the Whisparr folder mapping (Settings → Integrations) points somewhere else. Asked Whisparr to look again too, in case the file was deleted.'
          : problem
            ? problem
            : other
              ? `Stash links this file to a different ${catalog} scene (${other}). If it’s the same scene, say so and it will count as in your library.`
              : linkedHere
                ? 'Stash has it linked; the status should catch up within a few minutes.'
                : `Stash has the file, but it isn’t linked to this ${catalog} scene yet, so it doesn’t count as in your library. Check it in Match & rename.`,
      });
    }
    if (nudge && lookAgain.length > 0) {
      await this.handoff
        .refreshMovies(lookAgain.map((entry) => entry.movieId))
        .catch((error: unknown) =>
          this.logger.warn(
            `Couldn't ask Whisparr to look again at ${lookAgain.length} scene(s): ${messageOf(error)}`,
          ),
        );
      this.refreshSoon(lookAgain.map((entry) => entry.stashId));
    }
    return explained;
  }

  /** Every file Whisparr has, as Stash sees it; none when Whisparr can't be asked. */
  protected async whisparrFiles(): Promise<
    Array<{
      stashId: string;
      filePath: string;
      folder: string | null;
      movieId: number;
    }>
  > {
    return this.handoff
      .filesAsStashSees(await this.getSettings())
      .catch((error: unknown) => {
        this.logger.warn(
          `Couldn't ask Whisparr which files it imported: ${messageOf(error)}`,
        );
        return [];
      });
  }

  /**
   * Links each scene whose file Whisparr imported to the StashDB scene it
   * was downloaded for. When StashDB merged that scene into another, the
   * scene is linked to both, so Whisparr's old id still finds it. Scenes
   * linked to some other StashDB scene are left for the user to decide.
   * Returns the ids it linked.
   */
  protected async linkFromWhisparr(
    context: Context,
    scenes: StashOrganizerScene[],
    files: Array<{ stashId: string; filePath: string }>,
  ): Promise<string[]> {
    const primary = context.sources.find((source) => source.primary);
    if (!primary || scenes.length === 0 || files.length === 0) {
      return [];
    }
    const linkTo = new Map<string, string>();
    for (const scene of scenes) {
      const owner = files.find((file) =>
        scene.files.some((entry) => sameFile(entry.path, file.filePath)),
      );
      const has = (stashId: string) =>
        scene.stashIds.some(
          (entry) =>
            entry.endpoint === primary.endpoint && entry.stashId === stashId,
        );
      if (owner && !has(owner.stashId)) {
        linkTo.set(scene.id, owner.stashId);
      }
    }
    if (linkTo.size === 0) {
      return [];
    }
    const answers = await this.stashdb
      .getMatchScenesById(primary.api, [...new Set(linkTo.values())])
      .catch((error: unknown) => {
        this.logger.warn(
          `Couldn't load scenes from ${primary.name}: ${messageOf(error)}`,
        );
        return null;
      });
    if (!answers) {
      return [];
    }
    const linked: string[] = [];
    for (const scene of scenes) {
      const wanted = linkTo.get(scene.id);
      if (!wanted) {
        continue;
      }
      const match = answers.get(wanted);
      if (!match) {
        this.linkProblems.set(
          wanted,
          `${primary.name} has no scene ${wanted} any more; it was probably deleted. Check the scene in Whisparr.`,
        );
        continue;
      }
      const current = scene.stashIds.filter(
        (entry) => entry.endpoint === primary.endpoint,
      );
      try {
        if (current.length === 0) {
          await this.applyMatch(context, scene, match, primary);
          await this.rememberSameScene(wanted, match.id);
          linked.push(scene.id);
        } else if (current.some((entry) => entry.stashId === match.id)) {
          // Merged into the scene Stash already links. Stash keeps one
          // StashDB link per scene, so remember the old id here.
          await this.rememberSameScene(wanted, match.id);
          linked.push(scene.id);
        }
        this.linkProblems.delete(wanted);
      } catch (error) {
        this.linkProblems.set(
          wanted,
          `Linking it to ${primary.name} failed: ${messageOf(error)}`,
        );
        this.logger.warn(
          `Couldn't link scene ${scene.id} to ${match.id}: ${messageOf(error)}`,
        );
      }
    }
    return linked;
  }

  // ---------- finished downloads ----------

  /**
   * Links a scene a finished download became to the exact catalog scene it
   * was downloaded for: no guessing, the same save as a chosen match. Its
   * file isn't renamed here: finished downloads go into their own folder
   * inside the downloads destination (placeInSceneFolder) instead. Throws
   * with a plain reason when it can't.
   */
  async linkDownloadedScene(
    sceneId: string,
    catalog: { provider: CatalogProviderKey; sceneId: string },
  ): Promise<{ title: string | null }> {
    const context = await this.context();
    const source = await this.sourceForProvider(context, catalog.provider);
    const answers = await this.stashdb.getMatchScenesById(source.api, [
      catalog.sceneId,
    ]);
    const match = answers.get(catalog.sceneId);
    if (!match) {
      throw new NotFoundException(
        `${source.name} has no scene ${catalog.sceneId} any more.`,
      );
    }
    const scene = await this.stash.getOrganizerScene(context.config, sceneId);
    if (!scene) {
      throw new NotFoundException('That scene is no longer in Stash.');
    }
    await this.applyMatch(context, scene, match, source);
    this.logger.log(
      `Linked Stash scene ${sceneId} to ${source.name} scene ${catalog.sceneId}${match.title ? ` (“${match.title}”)` : ''}.`,
    );
    await this.forgetProposals([sceneId]);
    this.scheduleRefresh();
    return { title: match.title ?? null };
  }

  /**
   * StashDB or FansDB as a match source: with Stashboard's own address and key,
   * and the endpoint Stash knows it by, so the link lines up with Stash's.
   */
  private async sourceForProvider(
    context: Context,
    provider: CatalogProviderKey,
  ): Promise<MatchSource> {
    const label = getCatalogProviderLabel(provider);
    const integration = await this.prisma.integrationConfig.findUnique({
      where: { type: provider },
    });
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== 'CONFIGURED' ||
      !baseUrl
    ) {
      throw new ConflictException(
        `${label} isn’t set up in Stashboard any more, so the scene can’t be linked.`,
      );
    }
    const api = { baseUrl, apiKey: integration.apiKey ?? null };
    const host = hostOf(baseUrl);
    const known = context.sources.find(
      (source) =>
        hostOf(source.api.baseUrl) === host || hostOf(source.endpoint) === host,
    );
    if (known) {
      return { ...known, api };
    }
    const base = baseUrl.replace(/\/+$/, '');
    return {
      key: 'dl',
      name: label,
      kind: 'catalog',
      api,
      endpoint: base.endsWith('/graphql') ? base : `${base}/graphql`,
      primary: false,
    };
  }

  // ---------- one scene, for "Why is it like this?" ----------

  /**
   * Why one scene still waits for import, in the same words as the
   * Acquisition page's check. Only looks: nothing is linked or refreshed.
   */
  async explainWaitingScene(row: {
    stashId: string;
    title: string | null;
    whisparrQueueStatus?: string | null;
    whisparrQueueState?: string | null;
  }): Promise<WaitingScene | null> {
    const [explained] = await this.explainWaiting([row], false);
    return explained ?? null;
  }

  /**
   * Whisparr's file for one of these catalog scenes (or at one of these
   * paths), as Stash would see it. Null when Whisparr has none; throws when
   * Whisparr isn't set up or can't be asked, unlike whisparrFiles().
   */
  async whisparrFileFor(
    stashIds: string[],
    paths: string[] = [],
  ): Promise<{
    stashId: string;
    filePath: string;
    folder: string | null;
    movieId: number;
  } | null> {
    if (!(await this.handoff.isAvailable())) {
      throw new ConflictException('Whisparr isn’t set up in Stashboard.');
    }
    const files = await this.handoff.filesAsStashSees(await this.getSettings());
    return (
      files.find((file) => stashIds.includes(file.stashId)) ??
      files.find((file) =>
        paths.some((path) => sameFile(path, file.filePath)),
      ) ??
      null
    );
  }

  /** The Stash scenes linked to any of these catalog scenes. */
  async stashScenesLinkedTo(
    stashIds: string[],
  ): Promise<StashOrganizerScene[]> {
    const config = await this.stashConfig();
    const found: StashOrganizerScene[] = [];
    for (const stashId of new Set(stashIds)) {
      const result = await this.stash.findOrganizerScenes(config, {
        page: 1,
        perPage: 10,
        sceneFilter: {
          stash_id_endpoint: { stash_id: stashId, modifier: 'EQUALS' },
        },
      });
      for (const scene of result.items) {
        if (!found.some((entry) => entry.id === scene.id)) {
          found.push(scene);
        }
      }
    }
    return found;
  }

  /** One Stash scene with its files and stash-box links. */
  async stashScene(sceneId: string): Promise<StashOrganizerScene | null> {
    return this.stash.getOrganizerScene(await this.stashConfig(), sceneId);
  }

  /** Your main catalog as Stash links scenes to it; null when none is set up. */
  async primaryCatalog(): Promise<{ name: string; endpoint: string } | null> {
    const sources = await this.buildSources(
      await this.stashConfig(),
      await this.getSettings(),
    );
    const primary = sources.find((source) => source.primary);
    return primary ? { name: primary.name, endpoint: primary.endpoint } : null;
  }

  /** "Try Stash's scrapers" on one scene. */
  async scrapeOne(sceneId: string): Promise<{
    sceneId: string;
    filled: boolean;
    title: string | null;
    renamedTo: string | null;
  }> {
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    const scrapers = await this.stash.listFragmentSceneScrapers(config);
    if (scrapers.length === 0) {
      throw new ConflictException(
        'Stash has no scrapers that can look up a file. Install some in Stash under Settings → Metadata Providers.',
      );
    }
    const job = await this.stash.identifyWithScrapers(
      config,
      scrapers.map((scraper) => scraper.id),
      [sceneId],
    );
    if (job) {
      await this.stash.waitForJob(config, job, {
        sleep: this.pause,
        timeoutMs: SCRAPE_TIMEOUT_MS,
      });
    }
    const scene = await this.stash.getOrganizerScene(config, sceneId);
    const filled = Boolean(scene?.title);
    this.logger.log(
      filled
        ? `Stash's scrapers filled in scene ${sceneId} as “${scene?.title}”.`
        : `Stash's scrapers found nothing for scene ${sceneId}.`,
    );
    let renamedTo: string | null = null;
    if (filled && settings.renameAfterMatch) {
      const result = await this.renameAndNote(
        [sceneId],
        ' after matching',
      ).catch((error: unknown) => {
        this.logger.warn(
          `Couldn't rename Stash scene ${sceneId} after matching: ${messageOf(error)}`,
        );
        return null;
      });
      renamedTo = result?.moved[0]?.to ?? null;
    }
    if (filled) {
      this.scheduleRefresh();
    }
    return { sceneId, filled, title: scene?.title ?? null, renamedTo };
  }

  // ---------- Unmatched folder ----------
}

const CONFIDENCE_ORDER: Record<MatchConfidence, number> = {
  exact: 0,
  strong: 1,
  likely: 2,
  weak: 3,
};

/** A source as a found match keeps it: enough to find it again, no API key. */
interface StoredSource {
  key: string;
  name: string;
  kind: MatchSource['kind'];
  endpoint: string;
  primary: boolean;
}

/** A found match as it's kept in the database. */
interface StoredProposal {
  dto: MatchProposalDto;
  /** Every listed match by candidate id; the chosen one is dto.match. */
  choices: Record<string, { scene: StashdbMatchScene; source: StoredSource }>;
}

function storedSource(source: MatchSource): StoredSource {
  return {
    key: source.key,
    name: source.name,
    kind: source.kind,
    endpoint: source.endpoint,
    primary: source.primary,
  };
}

/** Today's source a found match came from, by endpoint, else by name. */
function findSource(
  context: Context,
  stored: StoredSource,
): MatchSource | undefined {
  return (
    context.sources.find((source) => source.endpoint === stored.endpoint) ??
    context.sources.find((source) => source.name === stored.name)
  );
}

/** A database row read back, or null when it isn't one we recognise. */
function asStoredProposal(value: Prisma.JsonValue): StoredProposal | null {
  const entry = value as unknown as Partial<StoredProposal> | null;
  return entry?.dto?.match && entry.dto.scene && entry.choices
    ? (entry as StoredProposal)
    : null;
}

/** "Title · Studio · date" for the activity log. */
function describeMatch(match: MatchCandidateDto): string {
  return [match.title ?? 'Untitled', match.studio, match.date, match.source]
    .filter(Boolean)
    .join(' · ');
}

/** The same file, allowing for slash direction and letter case (Windows, SMB). */
function sameFile(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();
  return normalize(left) === normalize(right);
}
