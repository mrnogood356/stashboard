import { Injectable, Logger } from '@nestjs/common';
import { OrganizerSettings } from '@prisma/client';
import { IndexingService } from '../indexing/indexing.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import {
  StashAdapter,
  StashAdapterBaseConfig,
  StashOrganizerScene,
} from '../providers/stash/stash.adapter';
import {
  WhisparrAdapter,
  WhisparrAdapterBaseConfig,
  WhisparrManualImportItem,
  WhisparrMovieSummary,
  WhisparrRootFolderOption,
} from '../providers/whisparr/whisparr.adapter';
import { trimTrailingSeparators } from '../path-separators';

export type HandoffSkip =
  | 'not-catalog'
  | 'not-in-whisparr'
  | 'already-has-file'
  | 'no-file'
  | 'missing-info';

export interface HandoffResult {
  sent: Array<{ sceneId: string; title: string }>;
  skipped: Partial<Record<HandoffSkip, number>>;
  failed: Array<{ sceneId: string; title: string; reason: string }>;
}

export interface RepairPlan {
  whisparrDestination: string;
  /**
   * The root folder in Whisparr: the library folder without the pattern's
   * fixed start (/data/stash content), since Whisparr's Scene Folder Format
   * has to start with that folder itself ("scenes/…").
   */
  whisparrRoot: string;
  /** Downloaded scenes in the wrong folder: Whisparr moves them with their files. */
  withFiles: Array<{
    id: number;
    title: string;
    path: string;
    target: string;
  }>;
  /** Missing scenes in the wrong folder: only the path changes. */
  missing: Array<{
    id: number;
    title: string;
    path: string;
    target: string;
  }>;
  /** Scenes to re-import from where Stash has the file. */
  lost: Array<{
    movieId: number;
    stashId: string;
    title: string;
    path: string | null;
  }>;
  /** Scenes the repair will touch. */
  total: number;
}

export interface PathCheckResult {
  ok: boolean;
  stashPath: string | null;
  whisparrPath: string | null;
  message: string;
}

const COMMAND_TIMEOUT_MS = 15 * 60_000;
/** One file is quick; a folder makes Whisparr read every video in it. */
const FILE_LOOKUP_TIMEOUT_MS = 60_000;
const FOLDER_LOOKUP_TIMEOUT_MS = 10 * 60_000;
/** Reuse a folder's list for a while, so a second run doesn't rescan it. */
const FOLDER_CACHE_MS = 30 * 60_000;
const STANDARD_RESOLUTIONS = [2160, 1080, 720, 576, 480, 360];

type QualityList = Array<{
  id: number;
  name: string;
  source: string | null;
  resolution: number | null;
  raw: unknown;
}>;

/**
 * Hands matched files to Whisparr through its Manual Import, so scenes
 * Whisparr shows as missing become downloaded. Whisparr then owns the file:
 * it moves (or copies) it into its own folder and names it.
 */
@Injectable()
export class WhisparrHandoffService {
  private readonly logger = new Logger(WhisparrHandoffService.name);
  /** Folder → its Manual Import list (null when Whisparr gave up), shared across scenes and runs. */
  private readonly folderLists = new Map<
    string,
    { at: number; list: Promise<WhisparrManualImportItem[] | null> }
  >();
  /** Used by tests to skip waiting. */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly stash: StashAdapter,
    private readonly whisparr: WhisparrAdapter,
    private readonly catalogProvider: CatalogProviderService,
    private readonly indexing: IndexingService,
  ) {}

  /** Whisparr is set up and ready. */
  async isAvailable(): Promise<boolean> {
    return (await this.whisparrConfig()) !== null;
  }

  /** Sends these Stash scenes to Whisparr. Only scenes linked to your main catalog (StashDB) can go. */
  async send(
    config: StashAdapterBaseConfig,
    scenes: StashOrganizerScene[],
    settings: OrganizerSettings,
    onProgress?: (done: number) => void,
  ): Promise<HandoffResult> {
    const result: HandoffResult = { sent: [], skipped: {}, failed: [] };
    const skip = (reason: HandoffSkip) => {
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    };
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig || scenes.length === 0) {
      if (!whisparrConfig && scenes.length > 0) {
        this.logger.warn(
          `Can't send ${scenes.length} scene(s) to Whisparr: Whisparr is not set up.`,
        );
      }
      return result;
    }
    const catalogHost = await this.catalogHost();
    const files: Array<{
      item: WhisparrManualImportItem;
      movieId: number;
      scene: StashOrganizerScene;
      stashId: string;
    }> = [];
    let qualities: Promise<QualityList> | null = null;
    const getQualities = () =>
      (qualities ??= this.whisparr
        .getQualityDefinitions(whisparrConfig)
        .catch((error: unknown) => {
          this.logger.debug(
            `Couldn't read Whisparr's quality definitions: ${messageOf(error)}`,
          );
          return [];
        }));

    for (const [index, scene] of scenes.entries()) {
      onProgress?.(index);
      const title = scene.title ?? `Scene #${scene.id}`;
      const stashId = scene.stashIds.find(
        (entry) => hostOf(entry.endpoint) === catalogHost,
      )?.stashId;
      const file = scene.files[0];
      if (!stashId) {
        skip('not-catalog');
        continue;
      }
      if (!file) {
        skip('no-file');
        continue;
      }
      try {
        let movie = await this.whisparr.findMovieByStashId(
          stashId,
          whisparrConfig,
        );
        if (!movie) {
          if (!settings.addToWhisparr) {
            skip('not-in-whisparr');
            continue;
          }
          if (!scene.title || !scene.studio) {
            skip('missing-info');
            continue;
          }
          const created = await this.addMovie(
            whisparrConfig,
            stashId,
            scene.title,
            scene.studio.name,
          );
          if (created === null) {
            result.failed.push({
              sceneId: scene.id,
              title,
              reason: 'Whisparr didn’t add the scene.',
            });
            continue;
          }
          movie = { movieId: created, stashId, hasFile: false };
        }
        if (movie.hasFile) {
          skip('already-has-file');
          continue;
        }
        const whisparrPath = mapPath(
          file.path,
          settings.whisparrPathFrom,
          settings.whisparrPathTo,
        );
        const item = await this.findImportItem(
          whisparrConfig,
          whisparrPath,
          movie.movieId,
          file,
          getQualities,
        );
        if (!item) {
          result.failed.push({
            sceneId: scene.id,
            title,
            reason: await this.explainMissing(
              whisparrConfig,
              whisparrPath,
              file.path,
            ),
          });
          continue;
        }
        files.push({ item, movieId: movie.movieId, scene, stashId });
      } catch (error) {
        result.failed.push({
          sceneId: scene.id,
          title,
          reason: messageOf(error),
        });
      }
    }
    onProgress?.(scenes.length);

    if (files.length === 0) {
      this.logSendResult(scenes.length, result);
      return result;
    }
    const mode = settings.whisparrImportMode === 'copy' ? 'copy' : 'move';
    this.logger.log(
      `Asking Whisparr to import ${files.length} file(s) (${mode}).`,
    );
    try {
      const commandId = await this.whisparr.startManualImport(
        whisparrConfig,
        files,
        mode,
      );
      const outcome =
        commandId === null
          ? 'completed'
          : await this.waitForCommand(whisparrConfig, commandId);
      if (outcome !== 'completed') {
        this.logger.warn(
          `Whisparr's import of ${files.length} file(s) ${outcome}.`,
        );
        for (const entry of files) {
          result.failed.push({
            sceneId: entry.scene.id,
            title: entry.scene.title ?? entry.scene.id,
            reason: `Whisparr import ${outcome}.`,
          });
        }
        return result;
      }
    } catch (error) {
      this.logger.error(
        `Whisparr import of ${files.length} file(s) failed: ${messageOf(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      for (const entry of files) {
        result.failed.push({
          sceneId: entry.scene.id,
          title: entry.scene.title ?? entry.scene.id,
          reason: messageOf(error),
        });
      }
      return result;
    }
    // Make sure Whisparr really took each file before calling it sent.
    for (const entry of files) {
      const title = entry.scene.title ?? entry.scene.id;
      let has = await this.hasFile(whisparrConfig, entry.stashId);
      if (!has) {
        await this.sleep(3000);
        has = await this.hasFile(whisparrConfig, entry.stashId);
      }
      if (has) {
        result.sent.push({ sceneId: entry.scene.id, title });
      } else {
        result.failed.push({
          sceneId: entry.scene.id,
          title,
          reason: `Whisparr ran the import but didn’t take ${entry.item.path}. Whisparr → System → Logs says why.`,
        });
      }
    }
    this.logSendResult(scenes.length, result);
    if (result.sent.length === 0) {
      return result;
    }
    const sentIds = new Set(result.sent.map((entry) => entry.sceneId));
    const sentFiles = files.filter((entry) => sentIds.has(entry.scene.id));

    // Stash notices the moved file on its next scan (same fingerprint, same scene);
    // Stashboard re-checks those scenes so they show as downloaded.
    if (mode === 'move') {
      await this.scanWhereWhisparrPut(
        config,
        settings,
        sentFiles.map((entry) => entry.movieId),
      );
    }
    await this.indexing
      .requestImmediateRefresh(
        sentFiles.map((entry) => entry.stashId),
        'whisparr-handoff',
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `Refresh after Whisparr import failed: ${messageOf(error)}`,
        ),
      );
    return result;
  }

  /** One line saying how sending scenes to Whisparr went. */
  private logSendResult(total: number, result: HandoffResult): void {
    const skipped = Object.entries(result.skipped)
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    const line = `Sent ${result.sent.length} of ${total} scene(s) to Whisparr${skipped ? `; skipped ${skipped}` : ''}${result.failed.length ? `; ${result.failed.length} failed` : ''}.`;
    if (result.failed.length > 0) {
      this.logger.warn(`${line} First problem: ${result.failed[0].reason}`);
    } else {
      this.logger.log(line);
    }
  }

  /**
   * The file as Manual Import should get it. In order: ask about the file
   * itself; if Whisparr can see the file, import it directly with a quality
   * worked out from its resolution; otherwise ask about its whole folder
   * (slow for big folders, so the list is shared and kept for a while).
   */
  private async findImportItem(
    config: WhisparrAdapterBaseConfig,
    path: string,
    movieId: number,
    file: { width: number | null; height: number | null },
    getQualities: () => Promise<QualityList>,
  ): Promise<WhisparrManualImportItem | null> {
    const direct = await this.whisparr
      .getManualImportItems(config, path, movieId, FILE_LOOKUP_TIMEOUT_MS)
      .catch(() => [] as WhisparrManualImportItem[]);
    const exact = direct.find((entry) => samePath(entry.path, path));
    if (exact) {
      return exact;
    }
    if (direct.length === 1) {
      return direct[0];
    }
    const type = await this.whisparr.pathType(config, path).catch(() => null);
    if (type === 'file') {
      return directItem(path, await getQualities(), file);
    }
    const folder = parentOf(path);
    if (folder) {
      const inFolder = await this.folderList(config, folder);
      const found = inFolder?.find((entry) => samePath(entry.path, path));
      if (found) {
        return found;
      }
    }
    // Older Whisparr without a file browser: try anyway; the result is checked afterwards.
    return type === null ? directItem(path, await getQualities(), file) : null;
  }

  private folderList(
    config: WhisparrAdapterBaseConfig,
    folder: string,
  ): Promise<WhisparrManualImportItem[] | null> {
    const cached = this.folderLists.get(folder);
    if (cached && Date.now() - cached.at < FOLDER_CACHE_MS) {
      return cached.list;
    }
    const list = this.whisparr
      .getManualImportItems(config, folder, 0, FOLDER_LOOKUP_TIMEOUT_MS)
      .catch((error: unknown) => {
        this.logger.warn(
          `Whisparr couldn’t list ${folder}: ${messageOf(error)}`,
        );
        return null;
      });
    // Drop lists that have expired, so the cache doesn't grow for good.
    for (const [key, entry] of this.folderLists) {
      if (Date.now() - entry.at >= FOLDER_CACHE_MS) {
        this.folderLists.delete(key);
      }
    }
    this.folderLists.set(folder, { at: Date.now(), list });
    return list;
  }

  private async hasFile(
    config: WhisparrAdapterBaseConfig,
    stashId: string,
  ): Promise<boolean> {
    const movie = await this.whisparr
      .findMovieByStashId(stashId, config)
      .catch(() => null);
    return movie?.hasFile === true;
  }

  /** Why Whisparr didn't offer a file for import, in plain words. */
  private async explainMissing(
    config: WhisparrAdapterBaseConfig,
    whisparrPath: string,
    stashPath: string,
  ): Promise<string> {
    const type = await this.whisparr
      .pathType(config, whisparrPath)
      .catch(() => null);
    const mapped =
      whisparrPath !== stashPath ? ` (Stash has it at ${stashPath})` : '';
    if (type === 'file') {
      return `Whisparr can see ${whisparrPath}${mapped} but its Manual Import won’t take it. In Whisparr, open Wanted → Manual Import on that folder to see why.`;
    }
    const folderType = await this.whisparr
      .pathType(config, parentOf(whisparrPath) ?? '/')
      .catch(() => null);
    if (folderType === 'folder') {
      return `Whisparr can open the folder but not ${whisparrPath}${mapped}. It may not have permission to read the file (Unraid: Tools → New Permissions on that share).`;
    }
    return whisparrPath === stashPath
      ? `Whisparr can’t see ${whisparrPath}. Tap “Find it for me” on the Match tab, or check Whisparr’s container paths.`
      : `Whisparr can’t see ${whisparrPath}${mapped}. Your media folder setting on the Match tab may be wrong — clear it or tap “Find it for me”.`;
  }

  /** Tries the folder mapping on one real file, without importing anything. */
  async checkPath(
    config: StashAdapterBaseConfig,
    scene: StashOrganizerScene | null,
    settings: OrganizerSettings,
  ): Promise<PathCheckResult> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return {
        ok: false,
        stashPath: null,
        whisparrPath: null,
        message: 'Whisparr isn’t set up in Stashboard.',
      };
    }
    const file = scene?.files[0];
    if (!scene || !file) {
      return {
        ok: false,
        stashPath: null,
        whisparrPath: null,
        message: 'No matched scene with a file to test with yet.',
      };
    }
    const whisparrPath = mapPath(
      file.path,
      settings.whisparrPathFrom,
      settings.whisparrPathTo,
    );
    try {
      // movieId 0: just ask whether Whisparr can read the file.
      const items = await this.whisparr.getManualImportItems(
        whisparrConfig,
        whisparrPath,
        0,
      );
      const ok =
        items.some((entry) => samePath(entry.path, whisparrPath)) ||
        items.length > 0;
      return {
        ok,
        stashPath: file.path,
        whisparrPath,
        message: ok
          ? 'Whisparr can see this file.'
          : 'Whisparr can’t see this file. Set where Stash and Whisparr each see your media folder.',
      };
    } catch (error) {
      return {
        ok: false,
        stashPath: file.path,
        whisparrPath,
        message: messageOf(error),
      };
    }
  }

  /**
   * Works out where Whisparr sees your media by trying real files: it keeps
   * the end of a Stash path and looks for it under Whisparr's own folders.
   */
  async detectMapping(
    samples: StashOrganizerScene[],
  ): Promise<{ from: string; to: string; example: string } | null> {
    const whisparrConfig = await this.whisparrConfig();
    const paths = samples
      .flatMap((scene) => (scene.files[0] ? [scene.files[0].path] : []))
      .slice(0, 3);
    if (!whisparrConfig || paths.length === 0) {
      return null;
    }
    const roots = await this.whisparr
      .getRootFolders(whisparrConfig)
      .catch((): WhisparrRootFolderOption[] => []);
    const bases = candidateBases(roots.map((root) => root.path));
    let checks = 0;
    const exists = async (path: string): Promise<boolean> => {
      checks += 1;
      const type = await this.whisparr.pathType(whisparrConfig, path);
      if (type === null) {
        // Older Whisparr: ask Manual Import instead.
        const items = await this.whisparr
          .getManualImportItems(whisparrConfig, path, 0)
          .catch(() => []);
        return items.length > 0;
      }
      return type === 'file';
    };
    const [first, ...rest] = paths;
    const segments = first.split('/').filter(Boolean);
    // Same path in both apps?
    if (await exists(first)) {
      return { from: '', to: '', example: first };
    }
    for (let drop = 1; drop < segments.length && checks < 120; drop += 1) {
      const suffix = segments.slice(drop).join('/');
      const from = `/${segments.slice(0, drop).join('/')}`;
      for (const base of bases) {
        if (checks >= 120) {
          break;
        }
        const candidate = `${base === '/' ? '' : base}/${suffix}`;
        if (candidate === first || !(await exists(candidate))) {
          continue;
        }
        const to = base === '/' ? '' : base;
        // Make sure another file agrees before saving it.
        const others = rest.filter((path) => path.startsWith(`${from}/`));
        const agree = await Promise.all(
          others.map((path) => exists(mapPath(path, from, to || '/'))),
        );
        if (agree.every(Boolean)) {
          return { from, to: to || '/', example: candidate };
        }
      }
    }
    return null;
  }

  /**
   * Whisparr's scenes with a file inside your Stash library but not in the
   * destination yet — the ones "Move Whisparr's files" would move.
   */
  async relocationPlan(
    settings: OrganizerSettings,
    libraryRoots: string[],
    destination: string,
  ): Promise<{
    destination: string;
    whisparrDestination: string;
    movieIds: number[];
    examples: string[];
  } | null> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return null;
    }
    const toWhisparr = (path: string) =>
      mapPath(path, settings.whisparrPathFrom, settings.whisparrPathTo);
    const whisparrDestination = trimTrailingSeparators(toWhisparr(destination));
    const roots = libraryRoots.map((root) =>
      toWhisparr(trimTrailingSeparators(root)),
    );
    const movies = await this.whisparr.listMovies(whisparrConfig);
    const moving = movies.filter((movie) => {
      const where = movie.filePath ?? movie.path;
      if (!movie.hasFile || !where) {
        return false;
      }
      const inLibrary = roots.some((root) => isInside(where, root));
      // Also re-home scenes that ended up nested inside the destination
      // (".../scenes/scenes/…") so Whisparr puts them back one level down.
      const nested = movie.path
        ? isInside(
            movie.path,
            `${whisparrDestination}/${lastSegment(whisparrDestination)}`,
          )
        : false;
      return inLibrary && (!isInside(where, whisparrDestination) || nested);
    });
    return {
      destination,
      whisparrDestination,
      movieIds: moving.map((movie) => movie.id),
      examples: moving
        .slice(0, 5)
        .map((movie) => movie.path ?? movie.filePath ?? movie.title),
    };
  }

  /** Whisparr's root folders, as Stash sees them, so cleanup never removes them. */
  async rootFoldersAsStashSees(settings: OrganizerSettings): Promise<string[]> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return [];
    }
    // No catch: a folder Whisparr owns must not lose its protection just
    // because Whisparr didn't answer.
    const roots = await this.whisparr.getRootFolders(whisparrConfig);
    return roots.map((root) =>
      mapPath(root.path, settings.whisparrPathTo, settings.whisparrPathFrom),
    );
  }

  /**
   * Every file Whisparr has, with the StashDB scene it belongs to, as Stash
   * sees the paths (through the path mapping). Empty when Whisparr isn't set up.
   */
  async filesAsStashSees(settings: OrganizerSettings): Promise<
    Array<{
      stashId: string;
      filePath: string;
      folder: string | null;
      movieId: number;
    }>
  > {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return [];
    }
    const toStash = (path: string) =>
      mapPath(path, settings.whisparrPathTo, settings.whisparrPathFrom);
    const movies = await this.whisparr.listMovies(whisparrConfig);
    return movies.flatMap((movie) =>
      movie.stashId && movie.hasFile && movie.filePath
        ? [
            {
              stashId: movie.stashId,
              filePath: toStash(movie.filePath),
              folder: movie.path ? toStash(movie.path) : null,
              movieId: movie.id,
            },
          ]
        : [],
    );
  }

  /** Has Whisparr look at these scenes' folders again, so it sees files that are gone. */
  async refreshMovies(movieIds: number[]): Promise<void> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig || movieIds.length === 0) {
      return;
    }
    const ids = [...new Set(movieIds)];
    for (let index = 0; index < ids.length; index += 100) {
      await this.whisparr.refreshMovies(
        whisparrConfig,
        ids.slice(index, index + 100),
      );
    }
  }

  /**
   * Whisparr's scene folders, as Stash sees them: a file inside one is
   * Whisparr's, whichever StashDB scene Stash has it linked to.
   */
  async trackedFolders(settings: OrganizerSettings): Promise<string[]> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return [];
    }
    const movies = await this.whisparr.listMovies(whisparrConfig);
    return movies.flatMap((movie) =>
      movie.path
        ? [
            mapPath(
              movie.path,
              settings.whisparrPathTo,
              settings.whisparrPathFrom,
            ),
          ]
        : [],
    );
  }

  /** StashDB ids of every scene Whisparr tracks (with or without a file). */
  async trackedStashIds(): Promise<Set<string>> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return new Set();
    }
    // No catch: an empty answer would let the renamer move Whisparr's files.
    const movies = await this.whisparr.listMovies(whisparrConfig);
    return new Set(
      movies.flatMap((movie) => (movie.stashId ? [movie.stashId] : [])),
    );
  }

  /**
   * Scenes Whisparr has in the wrong place: every scene in your library or the
   * destination whose folder isn't the one your pattern gives it
   * (destination/{studio}/{date} - {title}), plus missing scenes Stash
   * actually has a file for (to re-import).
   */
  async repairPlan(
    settings: OrganizerSettings,
    libraryRoots: string[],
    destination: string,
    /** StashDB ids Stash has a file for; only these can be re-imported. */
    stashHas: Set<string> = new Set(),
    /** The folder a scene belongs in, as Stash sees it (from your pattern). */
    folderFor?: (movie: WhisparrMovieSummary) => string | null,
    /** The library folder the destination is in (Whisparr's root folder); defaults to the destination. */
    libraryBase?: string,
  ): Promise<RepairPlan | null> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return null;
    }
    const toWhisparr = (path: string) =>
      mapPath(path, settings.whisparrPathFrom, settings.whisparrPathTo);
    const whisparrDestination = trimTrailingSeparators(toWhisparr(destination));
    const nestedRoot = `${whisparrDestination}/${lastSegment(whisparrDestination)}`;
    const roots = libraryRoots.map((root) =>
      toWhisparr(trimTrailingSeparators(root)),
    );
    const movies = await this.whisparr.listMovies(whisparrConfig);
    const whisparrRoot = libraryBase
      ? trimTrailingSeparators(toWhisparr(libraryBase))
      : whisparrDestination;
    const plan: RepairPlan = {
      whisparrDestination,
      whisparrRoot,
      withFiles: [],
      missing: [],
      lost: [],
      total: 0,
    };
    const touched = new Set<number>();
    // Folders already right stay taken, so two scenes never share one.
    const taken = new Set<string>();
    const targets = new Map<number, string>();
    for (const movie of movies) {
      if (
        !movie.path ||
        !(
          isInside(movie.path, whisparrDestination) ||
          roots.some((root) => isInside(movie.path!, root))
        )
      ) {
        continue;
      }
      const wanted = folderFor?.(movie);
      const target = wanted
        ? toWhisparr(wanted)
        : isInside(movie.path, nestedRoot)
          ? `${whisparrDestination}/${lastSegment(movie.path)}`
          : !movie.hasFile && !isInside(movie.path, whisparrDestination)
            ? `${whisparrDestination}/${lastSegment(movie.path)}`
            : movie.path;
      targets.set(movie.id, target);
      if (samePath(target, movie.path)) {
        taken.add(target.toLowerCase());
      }
    }
    for (const movie of movies) {
      const target = targets.get(movie.id);
      const missingButInStash =
        !movie.hasFile && !!movie.stashId && stashHas.has(movie.stashId);
      if (target && movie.path && !samePath(target, movie.path)) {
        let unique = target;
        for (let copy = 2; taken.has(unique.toLowerCase()); copy += 1) {
          unique = `${target} (${copy})`;
        }
        taken.add(unique.toLowerCase());
        (movie.hasFile ? plan.withFiles : plan.missing).push({
          id: movie.id,
          title: movie.title,
          path: movie.path,
          target: unique,
        });
        touched.add(movie.id);
      }
      if (missingButInStash && movie.stashId) {
        plan.lost.push({
          movieId: movie.id,
          stashId: movie.stashId,
          title: movie.title,
          path: movie.path,
        });
        touched.add(movie.id);
      }
    }
    plan.total = touched.size;
    return plan;
  }

  /**
   * Puts scenes in their folders. Downloaded scenes get their exact folder and
   * Whisparr moves the files (the same as editing the path in Whisparr with
   * "move files"); missing scenes only get the new path. Whisparr then
   * rescans, and the result is checked against Whisparr afterwards.
   */
  async resetPaths(
    plan: Pick<RepairPlan, 'whisparrDestination' | 'lost'> &
      Partial<Pick<RepairPlan, 'withFiles' | 'missing' | 'whisparrRoot'>>,
    onProgress?: (message: string) => void,
  ): Promise<{ stillWrong: number; errors: string[] }> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return { stillWrong: 0, errors: [] };
    }
    const withFiles = plan.withFiles ?? [];
    const pathOnly = plan.missing ?? [];
    const rootFolder = plan.whisparrRoot ?? plan.whisparrDestination;
    const errors: string[] = [];
    const roots = await this.whisparr.getRootFolders(whisparrConfig);
    if (
      (withFiles.length || pathOnly.length) &&
      !roots.some((root) =>
        samePath(trimTrailingSeparators(root.path), rootFolder),
      )
    ) {
      await this.whisparr.addRootFolder(whisparrConfig, rootFolder);
    }
    const waitForWhisparr = async () => {
      const deadline = Date.now() + COMMAND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const commands = await this.whisparr
          .listCommands(whisparrConfig)
          .catch(() => [] as Array<{ name: string; status: string }>);
        if (
          !commands.some(
            (command) =>
              /refresh|move/i.test(command.name) &&
              ['queued', 'started'].includes(command.status),
          )
        ) {
          return;
        }
        await this.sleep(5000);
      }
    };
    for (const [index, movie] of withFiles.entries()) {
      await this.whisparr
        .setMoviePath(whisparrConfig, movie.id, movie.target, rootFolder, true)
        .catch((error: unknown) => {
          errors.push(messageOf(error));
          this.logger.debug(
            `Couldn’t move Whisparr scene ${movie.id}: ${messageOf(error)}`,
          );
        });
      if ((index + 1) % 20 === 0) {
        onProgress?.(
          `Whisparr moved ${index + 1} of ${withFiles.length} into their studio folders…`,
        );
        await waitForWhisparr();
      }
    }
    await waitForWhisparr();
    // Missing scenes have no files: set their exact new path without moving anything.
    for (const [index, movie] of pathOnly.entries()) {
      await this.whisparr
        .setMoviePath(whisparrConfig, movie.id, movie.target, rootFolder, false)
        .catch((error: unknown) => {
          errors.push(messageOf(error));
          this.logger.debug(
            `Couldn’t set the path of Whisparr scene ${movie.id}: ${messageOf(error)}`,
          );
        });
      if ((index + 1) % 100 === 0) {
        onProgress?.(
          `Pointed ${index + 1} of ${pathOnly.length} missing scenes at their folders…`,
        );
      }
    }
    const ids = [...new Set(plan.lost.map((entry) => entry.movieId))];
    for (let index = 0; index < ids.length; index += 100) {
      await this.whisparr
        .refreshMovies(whisparrConfig, ids.slice(index, index + 100))
        .catch((error: unknown) =>
          this.logger.warn(
            `Couldn't ask Whisparr to rescan ${Math.min(100, ids.length - index)} scene(s): ${messageOf(error)}`,
          ),
        );
    }
    await waitForWhisparr();
    // Check with Whisparr what's still in the wrong place.
    const wanted = new Map(
      [...withFiles, ...pathOnly].map((movie) => [movie.id, movie.target]),
    );
    const after = await this.whisparr
      .listMovies(whisparrConfig)
      .catch((): WhisparrMovieSummary[] => []);
    const stillWrong = after.filter(
      (movie) =>
        wanted.has(movie.id) &&
        (!movie.path || !samePath(movie.path, wanted.get(movie.id)!)),
    ).length;
    const line = `Whisparr paths reset: ${withFiles.length} moved with files, ${pathOnly.length} missing scene(s) repointed, ${stillWrong} still in the wrong place, ${errors.length} error(s).`;
    if (errors.length > 0 || stillWrong > 0) {
      this.logger.warn(
        `${line}${errors.length ? ` First error: ${errors[0]}` : ''}`,
      );
    } else {
      this.logger.log(line);
    }
    return { stillWrong, errors };
  }

  /**
   * Has Whisparr move its scenes into the destination as a root folder (it
   * moves the files and keeps tracking them), then asks Stash to scan so it
   * follows the moved files. Returns how many were handed to Whisparr.
   */
  async relocate(
    config: StashAdapterBaseConfig,
    plan: { whisparrDestination: string; movieIds: number[] },
    onProgress?: (done: number, message: string) => void,
    settings?: Pick<OrganizerSettings, 'whisparrPathFrom' | 'whisparrPathTo'>,
  ): Promise<number> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig || plan.movieIds.length === 0) {
      return 0;
    }
    const roots = await this.whisparr.getRootFolders(whisparrConfig);
    if (
      !roots.some((root) =>
        samePath(trimTrailingSeparators(root.path), plan.whisparrDestination),
      )
    ) {
      await this.whisparr.addRootFolder(
        whisparrConfig,
        plan.whisparrDestination,
      );
    }
    let done = 0;
    for (let index = 0; index < plan.movieIds.length; index += 100) {
      const chunk = plan.movieIds.slice(index, index + 100);
      await this.whisparr.moveMoviesToRootFolder(
        whisparrConfig,
        chunk,
        plan.whisparrDestination,
      );
      done += chunk.length;
      onProgress?.(
        done,
        `Whisparr is moving ${done} of ${plan.movieIds.length}…`,
      );
    }
    // Wait for Whisparr's move jobs to finish before Stash looks.
    const deadline = Date.now() + COMMAND_TIMEOUT_MS * 4;
    while (Date.now() < deadline) {
      const commands = await this.whisparr
        .listCommands(whisparrConfig)
        .catch(() => [] as Array<{ name: string; status: string }>);
      const busy = commands.some(
        (command) =>
          /move/i.test(command.name) &&
          ['queued', 'started'].includes(command.status),
      );
      if (!busy) {
        break;
      }
      onProgress?.(done, 'Whisparr is still moving files…');
      await this.sleep(5000);
    }
    this.logger.log(
      `Whisparr moved ${done} scene(s) to ${plan.whisparrDestination}.`,
    );
    await this.scanWhereWhisparrPut(config, settings ?? null, plan.movieIds);
    return done;
  }

  /**
   * Has Stash scan only the folders Whisparr put these scenes in (quick, no
   * previews), so it follows the moved files without rescanning everything.
   */
  async scanWhereWhisparrPut(
    config: StashAdapterBaseConfig,
    settings: Pick<
      OrganizerSettings,
      'whisparrPathFrom' | 'whisparrPathTo'
    > | null,
    movieIds: number[],
  ): Promise<void> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig || movieIds.length === 0) {
      return;
    }
    try {
      const wanted = new Set(movieIds);
      const movies = await this.whisparr.listMovies(whisparrConfig);
      const folders = movies
        .filter((movie) => wanted.has(movie.id) && movie.path)
        .map((movie) =>
          mapPath(
            movie.path!,
            settings?.whisparrPathTo,
            settings?.whisparrPathFrom,
          ),
        );
      await this.stash.scanPaths(config, folders);
      this.logger.log(
        `Started a Stash scan of ${folders.length} folder(s) Whisparr put scenes in.`,
      );
    } catch (error) {
      this.logger.warn(`Couldn’t start a Stash scan: ${messageOf(error)}`);
    }
  }

  /** StashDB ids Whisparr is tracking without a file, that Stash already has. */
  async missingInWhisparr(): Promise<string[]> {
    const rows = await this.prisma.sceneIndex.findMany({
      where: {
        whisparrMovieId: { not: null },
        NOT: { whisparrHasFile: true },
        stashAvailable: true,
      },
      select: { stashId: true },
      take: 5000,
    });
    return rows.map((row) => row.stashId);
  }

  /** The stash-box endpoint, as Stash knows it, for your main catalog. */
  async catalogEndpoint(
    config: StashAdapterBaseConfig,
  ): Promise<string | null> {
    const host = await this.catalogHost();
    if (!host) {
      return null;
    }
    const boxes = await this.stash
      .listStashBoxes(config)
      .catch(() => [] as Array<{ endpoint: string }>);
    return boxes.find((box) => hostOf(box.endpoint) === host)?.endpoint ?? null;
  }

  private async addMovie(
    config: WhisparrAdapterBaseConfig,
    stashId: string,
    title: string,
    studio: string,
  ): Promise<number | null> {
    const [roots, profiles] = await Promise.all([
      this.whisparr.getRootFolders(config),
      this.whisparr.getQualityProfiles(config),
    ]);
    const root = roots.find((folder) => folder.accessible);
    const profile = profiles[0];
    if (!root || !profile) {
      throw new Error(
        'Whisparr has no root folder or quality profile to add the scene to.',
      );
    }
    const created = await this.whisparr.createMovie(
      {
        title,
        studio,
        foreignId: stashId,
        monitored: true,
        rootFolderPath: root.path,
        addOptions: { searchForMovie: false },
        qualityProfileId: profile.id,
        tags: [],
      },
      config,
    );
    return created.movieId;
  }

  private async waitForCommand(
    config: WhisparrAdapterBaseConfig,
    commandId: number,
  ): Promise<string> {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { status } = await this.whisparr
        .getCommandStatus(config, commandId)
        .catch(() => ({ status: 'unknown' }));
      if (
        ['completed', 'failed', 'aborted', 'cancelled', 'orphaned'].includes(
          status,
        )
      ) {
        return status;
      }
      await this.sleep(3000);
    }
    return 'timed out';
  }

  private async catalogHost(): Promise<string | null> {
    const provider = await this.catalogProvider
      .getInstanceCatalogProvider()
      .catch(() => null);
    return provider?.baseUrl ? hostOf(provider.baseUrl) : null;
  }

  /** Whisparr's Scene Folder Format and Standard Scene Format; null when it can't be asked. */
  async namingConfig(): Promise<Awaited<
    ReturnType<WhisparrAdapter['getNamingConfig']>
  > | null> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return null;
    }
    return this.whisparr.getNamingConfig(whisparrConfig).catch(() => null);
  }

  /**
   * Whether imports leave the original file behind, so Stash can see two
   * copies: Whisparr copies or hardlinks torrent downloads, and Stashboard's
   * own hand-over does too when set to "Hardlink / copy". Null when they
   * don't, or Whisparr doesn't say.
   */
  async leavesCopies(
    settings: Pick<OrganizerSettings, 'whisparrImportMode'>,
  ): Promise<{
    by: 'whisparr' | 'stashboard';
    hardlinks: boolean | null;
  } | null> {
    const whisparrConfig = await this.whisparrConfig();
    if (!whisparrConfig) {
      return null;
    }
    const found = await this.whisparr
      .getImportSettings(whisparrConfig)
      .catch(() => null);
    const hardlinks = found?.copyUsingHardlinks ?? null;
    if ((found?.torrentClients ?? 0) > 0) {
      return { by: 'whisparr', hardlinks };
    }
    if (settings.whisparrImportMode === 'copy') {
      return { by: 'stashboard', hardlinks };
    }
    return null;
  }

  private async whisparrConfig(): Promise<WhisparrAdapterBaseConfig | null> {
    const integration = await this.prisma.integrationConfig
      .findUnique({ where: { type: 'WHISPARR' } })
      .catch(() => null);
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== 'CONFIGURED' ||
      !baseUrl
    ) {
      return null;
    }
    return { baseUrl, apiKey: integration.apiKey };
  }
}

/** Stash's path for a file, as Whisparr sees it (e.g. /data → /mnt/user/media). */
export function mapPath(
  path: string,
  from: string | null | undefined,
  to: string | null | undefined,
): string {
  const source = trimTrailingSeparators((from ?? '').trim());
  const target = trimTrailingSeparators((to ?? '').trim());
  if (
    !source ||
    !(
      path === source ||
      path.startsWith(`${source}/`) ||
      path.startsWith(`${source}\\`)
    )
  ) {
    return path;
  }
  const rest = path.slice(source.length);
  const separator = target.includes('\\') && !target.includes('/') ? '\\' : '/';
  return `${target}${rest.replace(/[\\/]/g, separator)}`;
}

/** A Manual Import entry built by hand, for when Whisparr can see the file but won't list it. */
export function directItem(
  path: string,
  qualities: QualityList,
  file: { width: number | null; height: number | null },
): WhisparrManualImportItem {
  const short =
    file.width && file.height
      ? Math.min(file.width, file.height)
      : (file.height ?? 0);
  const resolution =
    STANDARD_RESOLUTIONS.find((size) => short >= size * 0.9) ?? null;
  const matching = qualities.filter(
    (quality) => resolution !== null && quality.resolution === resolution,
  );
  const quality = matching.find((entry) => entry.source === 'webdl') ??
    matching[0] ??
    qualities.find((entry) => entry.id === 0) ?? {
      id: 0,
      name: 'Unknown',
      raw: { id: 0, name: 'Unknown' },
    };
  return {
    path,
    quality: {
      quality: quality.raw,
      revision: { version: 1, real: 0, isRepack: false },
    },
    languages: [{ id: 1, name: 'English' }],
    releaseGroup: null,
    rejections: [],
  };
}

function parentOf(path: string): string | null {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : null;
}

function lastSegment(path: string): string {
  return trimTrailingSeparators(path).split(/[\\/]/).pop() ?? '';
}

function isInside(path: string, folder: string): boolean {
  const a = path.replace(/\\/g, '/').toLowerCase();
  const b = folder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

function samePath(left: string, right: string): boolean {
  return (
    left.replace(/\\/g, '/').toLowerCase() ===
    right.replace(/\\/g, '/').toLowerCase()
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'unknown error';
}

/**
 * Folders under which Whisparr might see your media: each Whisparr root
 * folder and its parents, plus the usual Docker mount points.
 */
export function candidateBases(rootFolders: string[]): string[] {
  const bases = new Set<string>();
  for (const root of rootFolders) {
    const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let length = parts.length; length >= 1; length -= 1) {
      bases.add(`/${parts.slice(0, length).join('/')}`);
    }
  }
  for (const common of [
    '/data',
    '/media',
    '/mnt/user',
    '/mnt/user/data',
    '/mnt/user/media',
    '/downloads',
    '/movies',
    '/stash',
    '/library',
    '/storage',
  ]) {
    bases.add(common);
  }
  bases.add('/');
  // Deeper folders first: they're the more specific guesses.
  return [...bases].sort(
    (left, right) => right.split('/').length - left.split('/').length,
  );
}
