import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrganizerSettings } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  StashAdapterBaseConfig,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import {
  canSee,
  findEmptyFolders,
  removeEmptyFolders,
} from './folder-cleanup.util';
import {
  HandoffResult,
  mapPath,
  PathCheckResult,
} from './whisparr-handoff.service';
import {
  DEFAULT_RENAME_PATTERN,
  findRoot,
  joinPath,
  splitPath,
  validatePattern,
} from './rename.util';
import {
  DEFAULT_WHISPARR_NAMING,
  tokensOnlyWhisparrKnows,
  type WhisparrNamingOptions,
} from './whisparr-naming.util';
import {
  IDLE_RUN,
  MATCHED_FILTER,
  MAX_BACKLOG,
  PREVIEW_LIMIT,
  UNMATCHED_FILTER,
  UNMATCHED_FOLDER,
  type OrganizerRunDto,
  type RenamePlanDto,
  type RenamePreviewDto,
  type RenameState,
  type TakenInfo,
} from './organizer.model';
import {
  dedupeTargets,
  inSceneFolder,
  isUnderFolder,
  type ExtraCopy,
  listDetail,
  looksTheSame,
  messageOf,
  pickTargetRoot,
  planRename,
  planUnmatchedMove,
  samePath,
  staticPrefix,
  whisparrFolderFor,
  whisparrFolderFormat,
  withoutRepeatedPrefix,
} from './organizer-plan.util';
import { OrganizerCore } from './organizer-core';
import type { NewActivity } from '../activity/activity.model';

/**
 * The organizer's file work: renaming and undo, moving unmatched files,
 * cleaning up empty folders, and handing scenes to (or repairing) Whisparr.
 */
/**
 * Don't ask Stash to rescan the same folder more often than this. A file that
 * stays gone or taken shows in every preview; rescanning its folder each time
 * only fills Stash's job list.
 */
const RESCAN_EVERY_MS = 6 * 60 * 60_000;
/** "Taken" files whose other file is looked at for each preview. */
const TAKEN_CHECK_LIMIT = 100;
/** Files the preview lists as skipped, with their paths. */
const SKIPPED_LIMIT = 500;

export abstract class OrganizerFiles extends OrganizerCore {
  /** When each folder was last sent to Stash to rescan, for files it has out of date. */
  private readonly rescanAsked = new Map<string, number>();

  /**
   * Moves every unmatched scene's file (or just these scenes', when given)
   * into the Unmatched folder, in the background.
   */
  startMoveUnmatched(sceneIds?: string[]): OrganizerRunDto {
    this.assertIdle();
    const only = sceneIds?.length ? [...new Set(sceneIds)] : null;
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'unmatched',
      message: 'Finding unmatched files…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void (async () => {
      try {
        const config = await this.stashConfig();
        const settings = await this.getSettings();
        const batchId = randomUUID();
        const result = await this.moveUnmatchedFiles(
          config,
          settings,
          batchId,
          only,
        );
        const message =
          result.moved === 0 && result.failed === 0
            ? only
              ? `Nothing to move: the picked files are already in ${UNMATCHED_FOLDER}, or are matched.`
              : `Every unmatched file is already in ${UNMATCHED_FOLDER}.`
            : `Moved ${result.moved} ${result.moved === 1 ? 'file' : 'files'} to ${UNMATCHED_FOLDER}` +
              (result.failed
                ? `, ${result.failed} couldn’t be moved (${result.firstError})`
                : '') +
              '.';
        this.finish(message);
        await this.record(
          'unmatched',
          result.failed && !result.moved ? 'FAILED' : 'DONE',
          message,
          {
            ...movedActivity(result.moved, result.failed, batchId),
            detail: listDetail([
              ['Moved', result.lines.moved],
              ['Couldn’t move', result.lines.failed],
            ]),
          },
        );
        if (result.moved > 0) {
          this.scheduleRefresh(0);
        }
      } catch (error) {
        this.finish(messageOf(error));
        await this.record(
          'unmatched',
          'FAILED',
          messageOf(error),
          undefined,
          error,
        );
      }
    })();
    return this.status();
  }

  /**
   * The moves "Move what's left to Unmatched" would make now: one per
   * unmatched scene whose file isn't in its Unmatched folder yet and that
   * can be moved (it's inside one of Stash's library folders).
   */
  protected async unmatchedMoves(
    config: StashAdapterBaseConfig,
    settings: OrganizerSettings,
    /** Just these scenes (still only the unmatched ones among them). */
    only: string[] | null = null,
  ): Promise<RenamePlanDto[]> {
    const roots = await this.stash.getLibraryRoots(config);
    const target = pickTargetRoot(settings.renameRoot, roots);
    const scenes: StashOrganizerScene[] = [];
    if (only) {
      const picked = await Promise.all(
        only.map((id) =>
          this.stash.getOrganizerScene(config, id).catch(() => null),
        ),
      );
      scenes.push(
        ...picked.filter(
          (scene): scene is StashOrganizerScene =>
            scene !== null && isUnmatched(scene),
        ),
      );
    }
    for (let page = 1; !only && page <= MAX_BACKLOG / 100; page += 1) {
      const result = await this.stash.findOrganizerScenes(config, {
        page,
        perPage: 100,
        sceneFilter: UNMATCHED_FILTER,
      });
      scenes.push(...result.items);
      if (page * 100 >= result.total || result.items.length === 0) {
        break;
      }
    }
    // Files Whisparr imported belong to Whisparr, matched or not: moving one
    // makes Whisparr lose it. Like renaming, refuse when Whisparr can't be asked.
    const whisparrPaths = settings.skipWhisparrFiles
      ? new Set(
          (
            await this.handoff.filesAsStashSees(settings).catch((error) => {
              throw new ConflictException(
                `Couldn’t ask Whisparr which files are its own, so nothing was moved: ${messageOf(error)}`,
              );
            })
          ).map((file) => file.filePath.normalize('NFC').toLowerCase()),
        )
      : new Set<string>();
    return dedupeTargets(
      scenes.map((scene) => planUnmatchedMove(scene, roots, target)),
    ).filter(
      (plan) =>
        plan.state === 'ready' &&
        plan.fileId &&
        plan.from &&
        plan.to &&
        !whisparrPaths.has(plan.from.normalize('NFC').toLowerCase()),
    );
  }

  /**
   * Moves unmatched scenes' files into "Unmatched" inside their library
   * folder (or the chosen one), through Stash, so Stash keeps the scene,
   * plays and markers. Each move is recorded so it can be undone.
   */
  protected async moveUnmatchedFiles(
    config: StashAdapterBaseConfig,
    settings: OrganizerSettings,
    batchId: string,
    only: string[] | null = null,
  ): Promise<{
    moved: number;
    failed: number;
    firstError: string | null;
    /** "from → to" for each moved file, and "file: why" for each that wasn't. */
    lines: { moved: string[]; failed: string[] };
  }> {
    const ready = await this.unmatchedMoves(config, settings, only);
    const lines = { moved: [] as string[], failed: [] as string[] };
    if (this.runState.running) {
      this.runState.total = ready.length;
      this.runState.processed = 0;
    }
    let moved = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const plan of ready) {
      const destination = splitPath(plan.to!);
      try {
        const actual = await this.moveAndCheck(
          config,
          plan,
          destination,
          batchId,
        );
        moved += 1;
        lines.moved.push(`${plan.from} → ${actual}`);
      } catch (error) {
        failed += 1;
        firstError ??= messageOf(error);
        lines.failed.push(`${plan.from}: ${messageOf(error)}`);
      }
      if (this.runState.running) {
        this.runState.processed = moved + failed;
        this.runState.renamed = moved;
        this.runState.message = `Moved ${moved} of ${ready.length} to ${UNMATCHED_FOLDER}…`;
      }
    }
    if (moved > 0) {
      await this.cleanUpAfterMoves(
        config,
        settings,
        ready.map((plan) => plan.from!),
      );
    }
    return { moved, failed, firstError, lines };
  }

  // ---------- empty folders ----------

  /** Whisparr moves whole folders; remove the empty ones it leaves, when allowed. */
  protected async tidyAfterWhisparr(): Promise<string> {
    try {
      const settings = await this.getSettings();
      if (!settings.cleanEmptyFolders || !(await this.folderAccess())) {
        return '';
      }
      const { removed } = await this.cleanEmptyFolders();
      return removed
        ? ` Removed ${removed} empty ${removed === 1 ? 'folder' : 'folders'}.`
        : '';
    } catch {
      return '';
    }
  }

  /** Every empty folder in your library folders (for the "Clean up" button). */
  async emptyFolders(): Promise<{
    available: boolean;
    count: number;
    folders: string[];
    galleries?: number;
    error?: string | null;
  }> {
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    if (!(await this.folderAccess())) {
      return { available: false, count: 0, folders: [] };
    }
    const roots = await this.stash.getLibraryRoots(config);
    const keep = await this.protectedFolders(config, settings);
    const found = new Set<string>();
    for (const root of roots) {
      (await findEmptyFolders(root.replace(/[\\/]+$/, ''), keep)).forEach(
        (folder) => found.add(folder),
      );
    }
    const checked = await this.withoutGalleries(config, [...found]);
    const folders = checked.folders.sort();
    return {
      available: true,
      count: folders.length,
      folders: folders.slice(0, 300),
      galleries: checked.galleries,
      error: checked.error,
    };
  }

  /** "Clean up" from the page: not while a rename, undo or repair is moving files. */
  cleanEmptyFoldersNow(): Promise<{ removed: number; kept: number }> {
    this.assertIdle();
    return this.cleanEmptyFolders();
  }

  async cleanEmptyFolders(): Promise<{ removed: number; kept: number }> {
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    if (!(await this.folderAccess())) {
      throw new ConflictException(
        'Stashboard can’t see your media folders. Add the same /data path to Stashboard’s container first.',
      );
    }
    const roots = await this.stash.getLibraryRoots(config);
    const keep = await this.protectedFolders(config, settings);
    const all: string[] = [];
    for (const root of roots) {
      all.push(...(await findEmptyFolders(root.replace(/[\\/]+$/, ''), keep)));
    }
    const checked = await this.withoutGalleries(config, [...new Set(all)]);
    if (checked.error) {
      throw new ConflictException(checked.error);
    }
    const { removed, kept } = await removeEmptyFolders(checked.folders);
    await this.record(
      'cleanup',
      'DONE',
      `Removed ${removed.length} empty ${removed.length === 1 ? 'folder' : 'folders'}.`,
      { count: removed.length, detail: removed.slice(0, 50).join('\n') },
    );
    return { removed: removed.length, kept: kept.length };
  }

  // ---------- Whisparr ----------

  /**
   * Sends every scene Stash has that Whisparr still shows as missing (and,
   * if that's switched on, scenes Whisparr doesn't know yet).
   */
  startSendAll(): OrganizerRunDto {
    this.assertIdle();
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'whisparr',
      message: 'Finding scenes Whisparr is missing…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void (async () => {
      try {
        const config = await this.stashConfig();
        const settings = await this.getSettings();
        const endpoint = await this.handoff.catalogEndpoint(config);
        if (!endpoint) {
          throw new ConflictException(
            'Stash doesn’t have your main catalog (StashDB) set up, so scenes can’t be linked to Whisparr.',
          );
        }
        const scenes = new Map<string, StashOrganizerScene>();
        for (const stashId of await this.handoff.missingInWhisparr()) {
          const found = await this.stash
            .findOrganizerScenes(config, {
              page: 1,
              perPage: 1,
              sceneFilter: {
                stash_id_endpoint: {
                  endpoint,
                  stash_id: stashId,
                  modifier: 'EQUALS',
                },
              },
            })
            .catch(() => ({ total: 0, items: [] as StashOrganizerScene[] }));
          found.items.forEach((scene) => scenes.set(scene.id, scene));
        }
        if (settings.addToWhisparr) {
          for (let page = 1; page <= MAX_BACKLOG / 100; page += 1) {
            const result = await this.stash.findOrganizerScenes(config, {
              page,
              perPage: 100,
              sceneFilter: {
                stash_id_endpoint: { endpoint, modifier: 'NOT_NULL' },
              },
            });
            result.items.forEach((scene) => scenes.set(scene.id, scene));
            if (page * 100 >= result.total || result.items.length === 0) {
              break;
            }
          }
        }
        const list = [...scenes.values()];
        this.runState.total = list.length;
        const totals: HandoffResult = { sent: [], skipped: {}, failed: [] };
        for (let index = 0; index < list.length; index += 25) {
          const chunk = list.slice(index, index + 25);
          const handed = await this.handoff.send(
            config,
            chunk,
            settings,
            (done) => {
              this.runState.processed = index + done;
              this.runState.message = `Checked ${this.runState.processed} of ${list.length}. Sent ${totals.sent.length}.`;
            },
          );
          totals.sent.push(...handed.sent);
          totals.failed.push(...handed.failed);
          for (const [reason, count] of Object.entries(handed.skipped)) {
            totals.skipped[reason as keyof HandoffResult['skipped']] =
              (totals.skipped[reason as keyof HandoffResult['skipped']] ?? 0) +
              (count ?? 0);
          }
          this.runState.renamed = totals.sent.length;
          this.runState.failed = totals.failed.length;
        }
        const already = totals.skipped['already-has-file'] ?? 0;
        const message =
          list.length === 0
            ? 'Whisparr isn’t missing anything Stash has.'
            : `Sent ${totals.sent.length} to Whisparr` +
              (already ? `, ${already} it already had` : '') +
              (totals.failed.length
                ? `. ${totals.failed.length} couldn’t go: ${totals.failed[0].reason}`
                : '') +
              '.';
        this.finish(message);
        await this.record(
          'whisparr',
          totals.failed.length && !totals.sent.length ? 'FAILED' : 'DONE',
          message,
        );
        this.scheduleRefresh(0);
      } catch (error) {
        this.finish(messageOf(error));
        await this.record(
          'whisparr',
          'FAILED',
          messageOf(error),
          undefined,
          error,
        );
      }
    })();
    return this.status();
  }

  /** Finds and saves where Whisparr sees your media, by trying real files. */
  async detectWhisparrPath(): Promise<{
    found: boolean;
    from: string;
    to: string;
    example: string | null;
    message: string;
  }> {
    const config = await this.stashConfig();
    const endpoint = await this.handoff.catalogEndpoint(config);
    const filter = endpoint
      ? { stash_id_endpoint: { endpoint, modifier: 'NOT_NULL' } }
      : MATCHED_FILTER;
    const sample = await this.stash
      .findOrganizerScenes(config, {
        page: 1,
        perPage: 3,
        sceneFilter: filter,
        sort: 'random',
      })
      .catch(() => ({ total: 0, items: [] as StashOrganizerScene[] }));
    const found = await this.handoff.detectMapping(sample.items);
    if (!found) {
      return {
        found: false,
        from: '',
        to: '',
        example: sample.items[0]?.files[0]?.path ?? null,
        message:
          'Couldn’t find your files from Whisparr. Make sure the Whisparr container has your media share mapped (Unraid → Docker → Whisparr → Edit), then try again.',
      };
    }
    await this.updateSettings({
      whisparrPathFrom: found.from,
      whisparrPathTo: found.to,
    });
    return {
      found: true,
      from: found.from,
      to: found.to,
      example: found.example,
      message: found.from
        ? `Found it: Stash’s ${found.from} is ${found.to} in Whisparr. Saved.`
        : 'Stash and Whisparr see your files at the same place. Saved.',
    };
  }

  /**
   * Where Whisparr's files would go: the "Put files in" folder (or the
   * library folder they're in) plus the fixed start of the pattern, like
   * /data/stash content/scenes for "scenes/{studio}/…".
   */
  async whisparrRelocation(): Promise<{
    destination: string;
    count: number;
    examples: string[];
  } | null> {
    const found = await this.repairPlan();
    return found
      ? {
          destination: found.destination,
          count: found.plan.withFiles.length,
          examples: found.plan.withFiles
            .slice(0, 5)
            .map((movie) => `${movie.path} → ${movie.target}`),
        }
      : null;
  }

  /**
   * Whisparr's naming as a Stashboard pattern ("folder format/file format"),
   * so renamed files land where Whisparr would put them. Null when Whisparr
   * isn't set up; pattern null (with why) when it can't be used as is.
   */
  async whisparrNaming(): Promise<{
    folderFormat: string | null;
    fileFormat: string | null;
    pattern: string | null;
    problem: string | null;
  } | null> {
    const naming = await this.handoff.namingConfig();
    if (!naming) {
      return null;
    }
    if (!naming.fileFormat) {
      return {
        ...naming,
        pattern: null,
        problem: 'Whisparr has no Standard Scene Format set.',
      };
    }
    const pattern = [naming.folderFormat, naming.fileFormat]
      .filter((part): part is string => !!part)
      .map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ''))
      .join('/');
    const problem = validatePattern(pattern);
    return { ...naming, pattern: problem ? null : pattern, problem };
  }

  /** How many scenes "Repair Whisparr" would fix. */
  async whisparrRepairCount(): Promise<{
    count: number;
    destination: string;
    rootFolder: string;
    folderFormat: string;
    /** The folders come from Whisparr's own Scene Folder Format. */
    usesWhisparrNaming: boolean;
    /** What the repair would do to each scene, folders as Stash sees them. */
    scenes: WhisparrRepairSceneDto[];
  } | null> {
    const found = await this.repairPlan();
    if (!found) {
      return null;
    }
    const { plan, settings } = found;
    const toStash = (path: string | null) =>
      path
        ? mapPath(path, settings.whisparrPathTo, settings.whisparrPathFrom)
        : null;
    const scenes: WhisparrRepairSceneDto[] = [
      ...plan.withFiles.map((movie) => ({
        title: movie.title,
        action: 'move' as const,
        from: toStash(movie.path),
        to: toStash(movie.target),
      })),
      ...plan.missing.map((movie) => ({
        title: movie.title,
        // Missing in Whisparr: a new path, and a re-import when Stash has the file.
        action: plan.lost.some((entry) => entry.movieId === movie.id)
          ? ('reimport' as const)
          : ('path' as const),
        from: toStash(movie.path),
        to: toStash(movie.target),
      })),
      ...plan.lost
        .filter(
          (movie) => !plan.missing.some((entry) => entry.id === movie.movieId),
        )
        .map((movie) => ({
          title: movie.title,
          action: 'reimport' as const,
          from: toStash(movie.path),
          to: null,
        })),
    ];
    return {
      count: plan.total,
      destination: found.destination,
      rootFolder: found.rootFolder,
      usesWhisparrNaming: found.whisparrFolderFormat !== null,
      folderFormat:
        found.whisparrFolderFormat ??
        whisparrFolderFormat(settings.renamePattern || DEFAULT_RENAME_PATTERN),
      scenes: scenes.slice(0, REPAIR_LIST_LIMIT),
    };
  }

  protected async repairPlan() {
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    const roots = await this.stash.getLibraryRoots(config);
    const base =
      pickTargetRoot(settings.renameRoot, roots) ??
      roots.map((root) => root.replace(/[\\/]+$/, ''))[0];
    if (!base) {
      return null;
    }
    // Whisparr's own Scene Folder Format decides its folders; your pattern
    // only when Whisparr can't be asked or uses tokens Stashboard can't fill.
    const naming = await this.handoff.namingConfig().catch(() => null);
    const fromWhisparr = naming?.folderFormat?.trim() || null;
    const whisparrFolders =
      fromWhisparr && tokensOnlyWhisparrKnows(fromWhisparr).length === 0
        ? fromWhisparr
        : null;
    const useWhisparr = whisparrFolders !== null;
    const pattern =
      whisparrFolders ?? (settings.renamePattern || DEFAULT_RENAME_PATTERN);
    const fixed = staticPrefix(pattern);
    const { root: cleanBase } = withoutRepeatedPrefix(base, fixed, fixed);
    const destination = fixed.length
      ? joinPath('/', cleanBase, ...fixed)
      : cleanBase;
    const stashHas = new Set(
      await this.handoff.missingInWhisparr().catch(() => [] as string[]),
    );
    const plan = await this.handoff.repairPlan(
      settings,
      roots,
      destination,
      stashHas,
      (movie) =>
        whisparrFolderFor(
          pattern,
          cleanBase,
          movie,
          naming ?? DEFAULT_WHISPARR_NAMING,
        ),
      cleanBase,
    );
    return plan
      ? {
          plan,
          destination,
          rootFolder: cleanBase,
          config,
          settings,
          whisparrFolderFormat: useWhisparr ? naming!.folderFormat : null,
        }
      : null;
  }

  /**
   * Fixes scenes Whisparr lost track of: points them back at the right root
   * folder (nothing moves), lets Whisparr rescan, then imports any still
   * missing straight from where Stash has the file.
   */
  startWhisparrRepair(): OrganizerRunDto {
    this.assertIdle();
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'whisparr',
      message: 'Checking what Whisparr lost…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void (async () => {
      try {
        const found = await this.repairPlan();
        if (!found) {
          throw new ConflictException('Whisparr isn’t set up in Stashboard.');
        }
        const { plan, config, settings } = found;
        this.runState.total = plan.total;
        if (plan.total === 0) {
          const message = 'Whisparr isn’t missing anything from your library.';
          this.finish(message);
          await this.record('whisparr', 'DONE', message);
          return;
        }
        this.runState.message = `Putting ${plan.withFiles.length + plan.missing.length} scenes in their folders in ${found.destination}…`;
        const reset = await this.handoff.resetPaths(plan, (message) => {
          this.runState.message = message;
        });
        const endpoint = await this.handoff.catalogEndpoint(config);
        const scenes: StashOrganizerScene[] = [];
        for (const entry of plan.lost) {
          if (!endpoint) {
            break;
          }
          const result = await this.stash
            .findOrganizerScenes(config, {
              page: 1,
              perPage: 1,
              sceneFilter: {
                stash_id_endpoint: {
                  endpoint,
                  stash_id: entry.stashId,
                  modifier: 'EQUALS',
                },
              },
            })
            .catch(() => ({ total: 0, items: [] as StashOrganizerScene[] }));
          scenes.push(...result.items);
        }
        const totals: HandoffResult = { sent: [], skipped: {}, failed: [] };
        // Import into Whisparr's own folders, whatever the copy setting says.
        const moveSettings = { ...settings, whisparrImportMode: 'move' };
        for (let index = 0; index < scenes.length; index += 25) {
          const handed = await this.handoff.send(
            config,
            scenes.slice(index, index + 25),
            moveSettings,
            (done) => {
              this.runState.processed = index + done;
              this.runState.message = `Re-importing ${this.runState.processed} of ${scenes.length}…`;
            },
          );
          totals.sent.push(...handed.sent);
          totals.failed.push(...handed.failed);
          for (const [reason, count] of Object.entries(handed.skipped)) {
            totals.skipped[reason as keyof HandoffResult['skipped']] =
              (totals.skipped[reason as keyof HandoffResult['skipped']] ?? 0) +
              (count ?? 0);
          }
          this.runState.renamed = totals.sent.length;
          this.runState.failed = totals.failed.length;
        }
        const foundAgain = totals.skipped['already-has-file'] ?? 0;
        const fixedPaths =
          plan.withFiles.length + plan.missing.length - reset.stillWrong;
        if (plan.withFiles.length) {
          // Whisparr moved files: let Stash follow them.
          await this.handoff.scanWhereWhisparrPut(
            config,
            settings,
            plan.withFiles.map((movie) => movie.id),
          );
        }
        const message =
          `Put ${fixedPaths} ${fixedPaths === 1 ? 'scene' : 'scenes'} in their folders in ${found.destination}` +
          (plan.lost.length
            ? `; Whisparr has ${foundAgain + totals.sent.length} of ${plan.lost.length} files back`
            : '') +
          (foundAgain && totals.sent.length
            ? ` (${foundAgain} found by rescanning, ${totals.sent.length} re-imported)`
            : '') +
          (reset.stillWrong
            ? `. ${reset.stillWrong} still point at the wrong folder${reset.errors[0] ? ` (${reset.errors[0]})` : ''}`
            : '') +
          (totals.failed.length
            ? `. ${totals.failed.length} still missing: ${totals.failed[0].reason}`
            : '') +
          (plan.lost.length - scenes.length > 0
            ? `. ${plan.lost.length - scenes.length} aren’t in Stash`
            : '') +
          '.' +
          (await this.tidyAfterWhisparr());
        this.finish(message);
        await this.record(
          'whisparr',
          totals.failed.length || reset.stillWrong ? 'FAILED' : 'DONE',
          message,
        );
        this.scheduleRefresh(30_000);
      } catch (error) {
        this.finish(messageOf(error));
        await this.record(
          'whisparr',
          'FAILED',
          messageOf(error),
          undefined,
          error,
        );
      }
    })();
    return this.status();
  }

  /** "Have Whisparr move them": the same as Repair, which puts every scene in its pattern folder. */
  startWhisparrRelocation(): OrganizerRunDto {
    return this.startWhisparrRepair();
  }

  /** Checks that Whisparr can see a real file with the current folder mapping. */
  async checkWhisparrPath(): Promise<PathCheckResult> {
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    const endpoint = await this.handoff.catalogEndpoint(config);
    const filter = endpoint
      ? { stash_id_endpoint: { endpoint, modifier: 'NOT_NULL' } }
      : MATCHED_FILTER;
    const sample = await this.stash
      .findOrganizerScenes(config, { page: 1, perPage: 1, sceneFilter: filter })
      .catch(() => ({ total: 0, items: [] as StashOrganizerScene[] }));
    return this.handoff.checkPath(config, sample.items[0] ?? null, settings);
  }

  // ---------- renaming ----------

  async renamePreview(patternOverride?: string): Promise<RenamePreviewDto> {
    const settings = await this.getSettings();
    const pattern =
      (patternOverride ?? settings.renamePattern).trim() ||
      DEFAULT_RENAME_PATTERN;
    const problem = validatePattern(pattern);
    if (problem) {
      throw new BadRequestException(problem);
    }
    const config = await this.stashConfig();
    const plans = await this.planAll(
      config,
      pattern,
      settings.skipWhisparrFiles,
      settings.renameRoot,
    );
    const counts: Record<RenameState, number> = {
      ready: 0,
      same: 0,
      missing: 0,
      whisparr: 0,
      outside: 0,
      'no-file': 0,
      gone: 0,
      taken: 0,
      copy: 0,
    };
    for (const plan of plans) {
      counts[plan.state] += 1;
    }
    const changes = plans
      .filter((plan) => plan.state === 'ready')
      .slice(0, PREVIEW_LIMIT);
    await this.markRenamedBefore(changes);
    await this.describeTaken(
      config,
      plans.filter((plan) => plan.state === 'taken'),
    );
    return {
      pattern,
      scanned: plans.length,
      counts,
      changes,
      skipped: plans
        .filter((plan) => plan.state !== 'ready' && plan.state !== 'same')
        .slice(0, SKIPPED_LIMIT),
    };
  }

  /**
   * What the rename preview plans for just these scenes, with the same
   * "taken" and "renamed before" details. Only looks: no rescans.
   */
  async renamePlansFor(
    sceneIds: string[],
  ): Promise<{ pattern: string; plans: RenamePlanDto[] }> {
    const settings = await this.getSettings();
    const pattern = settings.renamePattern || DEFAULT_RENAME_PATTERN;
    const config = await this.stashConfig();
    const plans = await this.planScenes(
      config,
      settings,
      pattern,
      sceneIds,
      false,
    );
    await this.markRenamedBefore(plans);
    await this.describeTaken(
      config,
      plans.filter((plan) => plan.state === 'taken'),
    );
    return { pattern, plans };
  }

  /**
   * Renames that keep coming back: Stashboard made the same one before, and
   * something (usually Whisparr, renaming the files it manages) gave the
   * file its old name again.
   */
  private async markRenamedBefore(plans: RenamePlanDto[]): Promise<void> {
    const fileIds = plans
      .map((plan) => plan.fileId)
      .filter((id): id is string => !!id);
    if (fileIds.length === 0) {
      return;
    }
    const rows = await this.prisma.organizerRename
      .findMany({
        where: { fileId: { in: fileIds }, undoneAt: null },
        orderBy: { createdAt: 'desc' },
        select: { fileId: true, fromPath: true, toPath: true, createdAt: true },
      })
      .catch(() => []);
    for (const plan of plans) {
      const row = rows.find(
        (entry) =>
          entry.fileId === plan.fileId &&
          samePath(entry.fromPath, plan.from ?? '') &&
          samePath(entry.toPath, plan.to ?? ''),
      );
      if (row) {
        plan.renamedBefore = row.createdAt.toISOString();
      }
    }
  }

  /** Renames every matched scene that doesn't follow the pattern yet, in the background. */
  startRenameAll(): OrganizerRunDto {
    this.assertIdle();
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'rename',
      message: 'Working out new names…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void (async () => {
      try {
        await this.record('rename', 'RUNNING', 'Renaming files…');
        const batchId = randomUUID();
        const result = await this.renameScenes(null, batchId);
        const message =
          result.moved.length === 0 && result.failed.length === 0
            ? 'Every file already follows your pattern.'
            : `Renamed ${result.moved.length} ${result.moved.length === 1 ? 'file' : 'files'}` +
              (result.moved[0] ? ` (e.g. ${result.moved[0].to})` : '') +
              (result.failed.length
                ? `, ${result.failed.length} failed (${result.failed[0].reason})`
                : '') +
              '.';
        this.finish(message);
        await this.record(
          'rename',
          result.failed.length && !result.moved.length ? 'FAILED' : 'DONE',
          message,
          {
            ...movedActivity(
              result.moved.length,
              result.failed.length,
              batchId,
            ),
            detail: listDetail([
              [
                'Renamed',
                result.moved.map((entry) => `${entry.from} → ${entry.to}`),
              ],
              ['Failed', result.failed.map((entry) => entry.reason)],
            ]),
          },
        );
        if (result.moved.length > 0) {
          this.scheduleRefresh(0);
        }
      } catch (error) {
        this.finish(messageOf(error));
        await this.record(
          'rename',
          'FAILED',
          messageOf(error),
          undefined,
          error,
        );
      }
    })();
    return this.status();
  }

  /** Renames the scenes picked on the page, unless a background run is moving files. */
  renameSelected(sceneIds: string[] | null) {
    this.assertIdle();
    return this.renameAndNote(sceneIds);
  }

  /** Renames these scenes and adds what happened to the activity log. */
  protected async renameAndNote(
    sceneIds: string[] | null,
    how = '',
  ): Promise<Awaited<ReturnType<OrganizerFiles['renameScenes']>>> {
    const batchId = randomUUID();
    const result = await this.renameScenes(sceneIds, batchId);
    const { moved, failed } = result;
    if (moved.length > 0 || failed.length > 0) {
      const line = `Renamed ${moved.length} file(s)${how}, ${failed.length} failed.`;
      if (failed.length > 0) {
        this.logger.warn(`${line} First problem: ${failed[0].reason}`);
      } else {
        this.logger.log(line);
      }
      moved.forEach((entry) => this.logger.verbose(`Renamed to ${entry.to}`));
      await this.activity?.record({
        kind: 'rename',
        title:
          moved.length > 0
            ? `Renamed ${moved.length} ${moved.length === 1 ? 'file' : 'files'}${how}`
            : `Couldn’t rename ${failed.length} ${failed.length === 1 ? 'file' : 'files'}${how}`,
        detail: [
          ...moved.slice(0, 20).map((entry) => `→ ${entry.to}`),
          ...failed.slice(0, 20).map((entry) => `✕ ${entry.reason}`),
        ].join('\n'),
        ...movedActivity(moved.length, failed.length, batchId),
      });
    }
    return result;
  }

  /** Rename plans for just these scenes, checked against the disk. */
  protected async planScenes(
    config: StashAdapterBaseConfig,
    settings: OrganizerSettings,
    pattern: string,
    sceneIds: string[],
    rescan = true,
  ): Promise<RenamePlanDto[]> {
    const roots = await this.stash.getLibraryRoots(config);
    const managed = settings.skipWhisparrFiles
      ? await this.whisparrManaged()
      : { ids: new Set<string>(), folders: [] };
    const scenes = (
      await Promise.all(
        sceneIds.map((id) => this.stash.getOrganizerScene(config, id)),
      )
    ).filter((scene): scene is StashOrganizerScene => scene !== null);
    const target = pickTargetRoot(settings.renameRoot, roots);
    const naming = await this.whisparrNamingOptions();
    const planned = scenes.map((scene) =>
      planRename(
        scene,
        roots,
        pattern,
        managed.ids,
        target,
        managed.folders,
        naming,
      ),
    );
    await this.markGone(planned, roots, config, rescan);
    return dedupeTargets(planned);
  }

  /**
   * Looks at the file that already has each "taken" plan's new name: is it
   * in Stash, and is it the same size as this one? That decides the fix, so
   * nothing depends on Stash's duplicate finder (which needs both files
   * scanned and fingerprinted).
   */
  protected async describeTaken(
    config: StashAdapterBaseConfig,
    plans: RenamePlanDto[],
  ): Promise<void> {
    for (const plan of plans.slice(0, TAKEN_CHECK_LIMIT)) {
      if (plan.state !== 'taken' || !plan.from || !plan.to) {
        continue;
      }
      const [mine, theirs] = await Promise.all([
        fs.stat(plan.from).catch(() => null),
        fs.stat(plan.to).catch(() => null),
      ]);
      const sameSize = mine && theirs ? mine.size === theirs.size : null;
      const [otherSceneId = null] = (
        await this.stash.sceneIdsForPaths(config, [plan.to]).catch(() => [])
      ).filter((id) => id !== plan.sceneId);
      plan.taken = await this.takenFix(config, plan, otherSceneId, sameSize);
    }
  }

  private async takenFix(
    config: StashAdapterBaseConfig,
    plan: RenamePlanDto,
    otherSceneId: string | null,
    sameSize: boolean | null,
  ): Promise<TakenInfo> {
    const base = { otherSceneId, sameSize };
    if (sameSize === false) {
      return {
        ...base,
        fix: 'none',
        note: 'The two files are different sizes, so they may be different videos (another release or quality). Watch both before deleting either.',
      };
    }
    if (!otherSceneId) {
      return {
        ...base,
        fix: 'scan',
        note: 'Stash hasn’t scanned the file that has the new name, so Duplicates can’t show it. Fix scans that folder; check again once Stash is done.',
      };
    }
    const [mine, other] = await Promise.all([
      this.stash.getOrganizerScene(config, plan.sceneId).catch(() => null),
      this.stash.getOrganizerScene(config, otherSceneId).catch(() => null),
    ]);
    const clash = other?.stashIds.find((entry) =>
      mine?.stashIds.some(
        (own) =>
          own.endpoint === entry.endpoint && own.stashId !== entry.stashId,
      ),
    );
    if (clash) {
      return {
        ...base,
        fix: 'none',
        note: 'Stash has the other file as a scene matched to something else, so they may not be the same scene. Open both and check.',
      };
    }
    return {
      ...base,
      fix: sameSize ? 'merge' : 'none',
      note: sameSize
        ? 'Same size, so almost surely the same video. Stash has it as a separate scene without fingerprints to compare, so Duplicates misses it. Fix merges that scene into this one (keeping this match, plays and markers) and deletes this extra copy, keeping the correctly named file.'
        : 'Stash has the other file as a separate scene. Couldn’t compare sizes; open both and check.',
    };
  }

  /**
   * Fixes "taken" files the safe way: has Stash scan the other file's
   * folder, or merges the other file's scene into this one and deletes this
   * extra copy. Anything that might be a different video is left alone.
   */
  async fixTaken(sceneIds: string[]): Promise<{
    scanned: number;
    merged: number;
    skipped: Array<{ sceneId: string; reason: string }>;
  }> {
    this.assertIdle();
    const settings = await this.getSettings();
    const config = await this.stashConfig();
    const pattern = settings.renamePattern || DEFAULT_RENAME_PATTERN;
    const plans = (
      await this.planScenes(config, settings, pattern, sceneIds, false)
    ).filter((plan) => plan.state === 'taken');
    await this.describeTaken(config, plans);
    const folders: string[] = [];
    const lines = { merged: [] as string[], scanned: [] as string[] };
    const skipped: Array<{ sceneId: string; reason: string }> = [];
    for (const id of sceneIds) {
      if (!plans.some((plan) => plan.sceneId === id)) {
        skipped.push({
          sceneId: id,
          reason: 'Its new name isn’t taken anymore; preview again.',
        });
      }
    }
    for (const plan of plans) {
      const taken = plan.taken;
      if (taken?.fix === 'scan') {
        folders.push(splitPath(plan.to!).folder);
        lines.scanned.push(plan.to!);
        continue;
      }
      if (taken?.fix !== 'merge' || !taken.otherSceneId) {
        skipped.push({
          sceneId: plan.sceneId,
          reason: taken?.note ?? 'Couldn’t check the other file.',
        });
        continue;
      }
      try {
        await this.stash.mergeScenes(
          config,
          [taken.otherSceneId],
          plan.sceneId,
        );
        const merged = await this.stash.getOrganizerScene(config, plan.sceneId);
        const keep = merged?.files.find((file) =>
          looksTheSame(file.path, plan.to!),
        );
        if (!keep || !plan.fileId || keep.id === plan.fileId) {
          throw new Error(
            'merged, but couldn’t tell which file to keep; check the scene',
          );
        }
        await this.stash.removeExtraFile(
          config,
          plan.sceneId,
          keep.id,
          plan.fileId,
        );
        lines.merged.push(`${plan.from} (kept ${plan.to})`);
      } catch (error) {
        skipped.push({ sceneId: plan.sceneId, reason: messageOf(error) });
      }
    }
    if (folders.length > 0) {
      await this.stash.scanPaths(config, folders);
      this.markRescanned(folders);
    }
    const merged = lines.merged.length;
    const scanned = lines.scanned.length;
    if (merged + scanned + skipped.length > 0) {
      await this.activity?.record({
        kind: merged ? 'delete' : 'scan',
        title:
          [
            merged
              ? `Removed ${merged} extra ${merged === 1 ? 'copy' : 'copies'} whose name was taken`
              : '',
            scanned
              ? `asked Stash to scan ${scanned} ${scanned === 1 ? 'file' : 'files'} it didn’t know`
              : '',
          ]
            .filter(Boolean)
            .join(', ') || 'Couldn’t fix the taken names',
        detail: listDetail([
          ['Deleted (the correctly named file was kept)', lines.merged],
          ['Scanning', lines.scanned],
          ['Left alone', skipped.map((entry) => entry.reason)],
        ]),
        status: skipped.length
          ? merged + scanned
            ? 'partial'
            : 'failed'
          : 'done',
        count: merged + scanned,
      });
    }
    if (merged > 0) {
      this.scheduleRefresh(0);
    }
    return { scanned, merged, skipped };
  }

  /** Renames these scenes right away (or every matched scene when null). */
  async renameScenes(
    sceneIds: string[] | null,
    batchId: string,
  ): Promise<{
    moved: Array<{ sceneId: string; from: string; to: string }>;
    failed: Array<{ sceneId: string; reason: string }>;
  }> {
    const settings = await this.getSettings();
    const config = await this.stashConfig();
    const pattern = settings.renamePattern || DEFAULT_RENAME_PATTERN;
    let plans: RenamePlanDto[];
    if (sceneIds) {
      plans = await this.planScenes(config, settings, pattern, sceneIds);
    } else {
      plans = await this.planAll(
        config,
        pattern,
        settings.skipWhisparrFiles,
        settings.renameRoot,
      );
    }
    const ready = plans.filter(
      (plan) => plan.state === 'ready' && plan.fileId && plan.from && plan.to,
    );
    if (this.runState.running && this.runState.kind === 'rename') {
      this.runState.total = ready.length;
    }
    const moved: Array<{ sceneId: string; from: string; to: string }> = [];
    const failed: Array<{ sceneId: string; reason: string }> = [];
    for (const plan of ready) {
      const target = splitPath(plan.to!);
      try {
        const actual = await this.moveAndCheck(config, plan, target, batchId);
        moved.push({ sceneId: plan.sceneId, from: plan.from!, to: actual });
      } catch (error) {
        const reason = messageOf(error);
        if (/already exists/i.test(reason)) {
          failed.push({
            sceneId: plan.sceneId,
            reason: `A file named ${splitPath(plan.to!).basename} is already there (Whisparr's copy, say), so this one may be a duplicate. Check Tools → Duplicates`,
          });
        } else if (/no such file or directory/i.test(reason)) {
          // Stash's record is out of date: the file was moved outside Stash.
          this.rescanFolders(config, [splitPath(plan.from!).folder]);
          failed.push({
            sceneId: plan.sceneId,
            reason: `${plan.from} isn't there anymore (moved outside Stash). Stash is rescanning that folder; preview again once it's done`,
          });
        } else {
          failed.push({ sceneId: plan.sceneId, reason });
        }
      }
      if (this.runState.running && this.runState.kind === 'rename') {
        this.runState.processed = moved.length + failed.length;
        this.runState.renamed = moved.length;
        this.runState.failed = failed.length;
        this.runState.message = `Renamed ${moved.length} of ${ready.length}…`;
      }
    }
    if (moved.length > 0) {
      await this.cleanUpAfterMoves(
        config,
        settings,
        ready
          .filter((plan) =>
            moved.some((entry) => entry.sceneId === plan.sceneId),
          )
          .map((plan) => plan.from!),
      );
    }
    return { moved, failed };
  }

  /**
   * Asks Stash to move a file, then checks where it really ended up. Stash
   * normally creates missing folders; if it didn't (or put the file
   * elsewhere), that's reported instead of counted as done. Whatever moved is
   * recorded, so Undo can put it back.
   */
  protected async moveAndCheck(
    config: StashAdapterBaseConfig,
    plan: RenamePlanDto,
    target: { folder: string; basename: string },
    batchId: string,
  ): Promise<string> {
    await this.stash.moveFile(
      config,
      plan.fileId!,
      target.folder,
      target.basename,
    );
    const after = await this.stash
      .getOrganizerScene(config, plan.sceneId)
      .catch(() => null);
    const actual =
      after?.files.find((file) => file.id === plan.fileId)?.path ?? plan.to!;
    if (!samePath(actual, plan.from!)) {
      await this.prisma.organizerRename.create({
        data: {
          batchId,
          sceneId: plan.sceneId,
          fileId: plan.fileId!,
          fromPath: plan.from!,
          toPath: actual,
        },
      });
    }
    if (samePath(actual, plan.to!)) {
      return actual;
    }
    if (samePath(actual, plan.from!)) {
      throw new Error(`Stash didn’t move ${plan.from} (asked for ${plan.to}).`);
    }
    throw new Error(
      `Stash put it at ${actual} instead of ${plan.to}. Your Stash version may not support moving into new folders; update Stash and try again.`,
    );
  }

  /** Puts the files from the last rename run back where they were. */
  async undoLast(): Promise<OrganizerRunDto> {
    this.assertIdle();
    const last = await this.prisma.organizerRename.findFirst({
      where: { undoneAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!last) {
      throw new ConflictException('There’s nothing to undo.');
    }
    return this.undoBatch(last.batchId);
  }

  /** Puts the files from one rename (or move) batch back where they were. */
  async undoBatch(batchId: string): Promise<OrganizerRunDto> {
    this.assertIdle();
    const rows = await this.prisma.organizerRename.findMany({
      where: { batchId, undoneAt: null },
      orderBy: { id: 'desc' },
    });
    if (rows.length === 0) {
      throw new ConflictException('Those files were already put back.');
    }
    this.runState = {
      ...IDLE_RUN,
      running: true,
      kind: 'undo',
      total: rows.length,
      message: 'Putting files back…',
    };
    this.logger.log(
      `Organizer started (${this.runState.kind}): ${this.runState.message}`,
    );
    void (async () => {
      try {
        const config = await this.stashConfig();
        const putBack: string[] = [];
        const putBackLines: string[] = [];
        for (const row of rows) {
          const original = splitPath(row.fromPath);
          try {
            await this.stash.moveFile(
              config,
              row.fileId,
              original.folder,
              original.basename,
            );
            await this.prisma.organizerRename.update({
              where: { id: row.id },
              data: { undoneAt: new Date() },
            });
            putBack.push(row.toPath);
            putBackLines.push(`${row.toPath} → ${row.fromPath}`);
            this.runState.renamed += 1;
          } catch (error) {
            this.runState.failed += 1;
            this.logger.warn(
              `Undo failed for ${row.toPath}: ${messageOf(error)}`,
            );
          }
          this.runState.processed += 1;
        }
        // The folders the rename made are empty again.
        await this.cleanUpAfterMoves(config, await this.getSettings(), putBack);
        const message =
          `Put ${this.runState.renamed} ${this.runState.renamed === 1 ? 'file' : 'files'} back` +
          (this.runState.failed
            ? `, ${this.runState.failed} couldn’t be moved`
            : '') +
          '.';
        this.finish(message);
        await this.record('undo', 'DONE', message, {
          count: this.runState.renamed,
          detail: listDetail([['Put back', putBackLines]]),
          ...(this.runState.failed
            ? { status: this.runState.renamed ? 'partial' : 'failed' }
            : {}),
        });
        await this.activity?.markUndone('rename-batch', 'batchId', batchId);
        this.scheduleRefresh(0);
      } catch (error) {
        this.finish(messageOf(error));
        await this.record('undo', 'FAILED', messageOf(error), undefined, error);
      }
    })();
    return this.status();
  }

  /** Called by import automation once new scenes are identified. */
  async afterImport(sceneIds: string[]): Promise<number> {
    if (sceneIds.length === 0) {
      return 0;
    }
    const settings = await this.getSettings();
    if (!settings.renameAfterMatch) {
      return 0;
    }
    const result = await this.renameAndNote(sceneIds, ' after import');
    return result.moved.length;
  }

  /**
   * Puts a downloaded scene's file into a folder of its own inside the
   * downloads destination, named by your rename pattern the way Whisparr
   * does it: the pattern's folders go inside the destination (not the
   * library folder), and the scene gets its own folder named like the file,
   * e.g. <destination>/Studio/2024-01-02 - Title/2024-01-02 - Title.mp4.
   * Done through Stash, so it keeps the scene, and recorded for Undo.
   *
   * Never replaces anything: when the target is taken (or the pattern can't
   * name it), the file stays where it is and the reason is returned.
   */
  async placeInSceneFolder(
    sceneId: string,
    filePath: string,
    destination: string,
  ): Promise<{ to: string; reason: string | null }> {
    const stay = (reason: string) => ({
      to: filePath,
      reason: `${reason} It stayed at ${filePath}.`,
    });
    const config = await this.stashConfig();
    const settings = await this.getSettings();
    const pattern = settings.renamePattern || DEFAULT_RENAME_PATTERN;
    const [roots, scene] = await Promise.all([
      this.stash.getLibraryRoots(config),
      this.stash.getOrganizerScene(config, sceneId),
    ]);
    const file = scene?.files.find((entry) => samePath(entry.path, filePath));
    if (!scene || !file) {
      return stay('Stash doesn’t list the file for that scene any more.');
    }
    const base = destination.replace(/[\\/]+$/, '');
    // This file, not another copy the scene may have, and the destination
    // as the folder the pattern starts from. Whisparr's files are left
    // alone by renames, but this one is a download of our own.
    const plan = planRename(
      { ...scene, files: [file, ...scene.files.filter((f) => f !== file)] },
      roots,
      pattern,
      new Set(),
      base,
      [],
      await this.whisparrNamingOptions(),
    );
    if (plan.state === 'missing' || !plan.to) {
      return stay(
        'Your rename pattern needs details the scene doesn’t have (like its studio or title), so it wasn’t put in a folder.',
      );
    }
    if (plan.state === 'copy') {
      return stay(`The scene already has a file at ${plan.to}.`);
    }
    if (plan.state !== 'ready' && plan.state !== 'same') {
      return stay('It couldn’t be put in a folder.');
    }
    const to = inSceneFolder(plan.to, pattern);
    if (looksTheSame(to, filePath)) {
      return { to: filePath, reason: null };
    }
    if (!isUnderFolder(to, base)) {
      return stay(`Your rename pattern would put it outside ${base}.`);
    }
    if (await surelyExists(to)) {
      return stay(`Something is already at ${to}, and nothing is replaced.`);
    }
    const batchId = randomUUID();
    let actual: string;
    try {
      actual = await this.moveAndCheck(
        config,
        { ...plan, to, state: 'ready' },
        splitPath(to),
        batchId,
      );
    } catch (error) {
      return {
        to: filePath,
        reason: `Couldn’t move it into its folder: ${messageOf(error)}`,
      };
    }
    await this.activity?.record({
      kind: 'rename',
      title: `Put “${plan.title}” in its own folder after downloading`,
      detail: `${filePath} → ${actual}`,
      ...movedActivity(1, 0, batchId),
    });
    this.scheduleRefresh();
    return { to: actual, reason: null };
  }

  /** How Whisparr writes names (colons, illegal characters), for its placeholders. */
  protected async whisparrNamingOptions(): Promise<WhisparrNamingOptions> {
    const naming = await this.handoff.namingConfig().catch(() => null);
    return naming
      ? {
          replaceIllegalCharacters: naming.replaceIllegalCharacters,
          colonReplacement: naming.colonReplacement,
        }
      : DEFAULT_WHISPARR_NAMING;
  }

  protected async planAll(
    config: StashAdapterBaseConfig,
    pattern: string,
    skipWhisparr: boolean,
    renameRoot: string | null,
    /** Ask Stash to rescan the folders of files that moved (rate-limited). */
    rescan = true,
  ): Promise<RenamePlanDto[]> {
    const roots = await this.stash.getLibraryRoots(config);
    const target = pickTargetRoot(renameRoot, roots);
    const managed = skipWhisparr
      ? await this.whisparrManaged()
      : { ids: new Set<string>(), folders: [] };
    const naming = await this.whisparrNamingOptions();
    const plans: RenamePlanDto[] = [];
    for (let page = 1; page <= MAX_BACKLOG / 100; page += 1) {
      const result = await this.stash.findOrganizerScenes(config, {
        page,
        perPage: 100,
        sceneFilter: MATCHED_FILTER,
      });
      plans.push(
        ...result.items.map((scene) =>
          planRename(
            scene,
            roots,
            pattern,
            managed.ids,
            target,
            managed.folders,
            naming,
          ),
        ),
      );
      if (page * 100 >= result.total || result.items.length === 0) {
        break;
      }
    }
    await this.markGone(plans, roots, config, rescan);
    return dedupeTargets(plans);
  }

  /**
   * Deletes the extra copies the rename preview found: files of a scene that
   * already has another file with the pattern's name. Each scene keeps that
   * file (made its main one first). Never touches anything else.
   */
  async removeExtraCopies(): Promise<{
    removed: number;
    failed: Array<{ sceneId: string; reason: string }>;
  }> {
    this.assertIdle();
    const settings = await this.getSettings();
    const config = await this.stashConfig();
    const plans = await this.planAll(
      config,
      settings.renamePattern || DEFAULT_RENAME_PATTERN,
      settings.skipWhisparrFiles,
      settings.renameRoot,
    );
    const result = await this.removeCopies(config, copiesFromPlans(plans));
    if (result.removed > 0) {
      this.scheduleRefresh(0);
    }
    return result;
  }

  /** Deletes each extra copy; the scene keeps its other file. */
  protected async removeCopies(
    config: StashAdapterBaseConfig,
    copies: ExtraCopy[],
  ): Promise<{
    removed: number;
    failed: Array<{ sceneId: string; reason: string }>;
  }> {
    let removed = 0;
    const failed: Array<{ sceneId: string; reason: string }> = [];
    const lines = { removed: [] as string[], failed: [] as string[] };
    const seen = new Set<string>();
    for (const copy of copies) {
      if (seen.has(copy.removeFileId)) {
        continue;
      }
      seen.add(copy.removeFileId);
      try {
        await this.stash.removeExtraFile(
          config,
          copy.sceneId,
          copy.keepFileId,
          copy.removeFileId,
        );
        removed += 1;
        lines.removed.push(copy.path);
      } catch (error) {
        failed.push({ sceneId: copy.sceneId, reason: messageOf(error) });
        lines.failed.push(`${copy.path}: ${messageOf(error)}`);
      }
    }
    if (removed > 0 || failed.length > 0) {
      await this.activity?.record({
        kind: 'delete',
        title: `Removed ${removed} extra ${removed === 1 ? 'copy' : 'copies'}`,
        detail: listDetail([
          ['Deleted', lines.removed],
          ['Couldn’t remove', lines.failed],
        ]),
        status: failed.length ? (removed ? 'partial' : 'failed') : 'done',
        count: removed,
      });
    }
    return { removed, failed };
  }

  /**
   * Files Stash still lists but that aren't on disk anymore (moved by
   * Whisparr or by hand, and Stash hasn't scanned since) can't be renamed:
   * they're marked "gone", and Stash is asked to rescan their folders so it
   * finds where they went. Only checked where Stashboard can see the library.
   */
  protected async markGone(
    plans: RenamePlanDto[],
    roots: string[],
    config: StashAdapterBaseConfig,
    rescan = true,
  ): Promise<void> {
    const visible = new Map<string, boolean>();
    const folders: string[] = [];
    for (const plan of plans) {
      if (plan.state !== 'ready' || !plan.from) {
        continue;
      }
      const root = findRoot(plan.from, roots);
      if (!root) {
        continue;
      }
      if (!visible.has(root)) {
        visible.set(root, await canSee(root));
      }
      if (!visible.get(root)) {
        continue;
      }
      if (!(await fileExists(plan.from))) {
        plan.state = 'gone';
        plan.to = null;
        folders.push(splitPath(plan.from).folder);
      } else if (
        plan.to &&
        !looksTheSame(plan.to, plan.from) &&
        (await surelyExists(plan.to))
      ) {
        // Another file already has the new name: usually Whisparr's own
        // copy, which leaves this one behind as a duplicate. Stash won't
        // overwrite it, and neither should we. Stash may not know that file
        // yet; a rescan lets the duplicate finder see both.
        plan.state = 'taken';
        folders.push(splitPath(plan.to).folder);
      }
    }
    if (rescan) {
      this.rescanFolders(config, folders);
    }
  }

  /** Folders just rescanned some other way: no need to ask Stash again soon. */
  protected markRescanned(folders: string[]): void {
    const now = Date.now();
    folders.forEach((folder) => this.rescanAsked.set(folder, now));
  }

  /** Asks Stash to rescan these folders, each at most every ten minutes. Never throws. */
  protected rescanFolders(config: StashAdapterBaseConfig, folders: string[]) {
    const now = Date.now();
    const due = [...new Set(folders)].filter(
      (folder) => now - (this.rescanAsked.get(folder) ?? 0) > RESCAN_EVERY_MS,
    );
    if (due.length === 0) {
      return;
    }
    due.forEach((folder) => this.rescanAsked.set(folder, now));
    void this.stash
      .scanPaths(config, due)
      .catch((error: unknown) =>
        this.logger.warn(
          `Couldn't ask Stash to rescan ${due.length} folder(s): ${messageOf(error)}`,
        ),
      );
  }
}

/**
 * Nothing to name the file by: no stash-box link, and no title or no studio.
 * A scraper-filled scene keeps its folder, as renaming would move it out again.
 */
function isUnmatched(scene: StashOrganizerScene): boolean {
  return scene.stashIds.length === 0 && (!scene.title || !scene.studio);
}

/** The extra copies the rename preview found ("copy" plans). */
export function copiesFromPlans(plans: RenamePlanDto[]): ExtraCopy[] {
  return plans.flatMap((plan) =>
    plan.state === 'copy' && plan.fileId && plan.keepFileId && plan.from
      ? [
          {
            sceneId: plan.sceneId,
            keepFileId: plan.keepFileId,
            removeFileId: plan.fileId,
            path: plan.from,
          },
        ]
      : [],
  );
}

/** True only when the file is surely there. */
async function surelyExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** False only when the file is surely not there; unreadable counts as there. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Enough to check a repair before running it, without a huge reply. */
const REPAIR_LIST_LIMIT = 500;

/**
 * One scene the Whisparr repair would touch: moved with its file, given a
 * new path only (Whisparr has no file), or re-imported from where Stash has it.
 */
export interface WhisparrRepairSceneDto {
  title: string;
  action: 'move' | 'path' | 'reimport';
  from: string | null;
  to: string | null;
}

/** What a run that moved files adds to the log: how many, and its Undo. */
function movedActivity(
  moved: number,
  failed: number,
  batchId: string,
): Partial<NewActivity> {
  return {
    count: moved,
    status: failed ? (moved ? 'partial' : 'failed') : 'done',
    undo: moved > 0 ? { type: 'rename-batch', batchId } : null,
  };
}
