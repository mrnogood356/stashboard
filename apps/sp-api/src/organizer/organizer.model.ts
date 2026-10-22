import type { StashAdapterBaseConfig } from '../providers/stash/stash.adapter';
import type { StashdbMatchScene } from '../providers/stashdb/stashdb.adapter';
import type { MatchConfidence } from './match-scoring.util';

// Settings, results and constants the organizer and its page share.

export const KEY = 'GLOBAL';
export const PAGE_SIZE = 20;
export const LOOKUP_LIMIT = 20;
export const CANDIDATE_TTL_MS = 60 * 60_000;
export const MAX_CACHED_CANDIDATES = 3000;
export const MAX_BACKLOG = 5000;
export const PREVIEW_LIMIT = 200;
/** No link to any stash-box (a scraper's title and studio alone don't count). */
export const UNMATCHED_FILTER = {
  is_missing: 'stash_id',
};
/** Anything with a title can be renamed, whichever source filled it in. */
export const MATCHED_FILTER = { NOT: { is_missing: 'title' } };
export const TPDB_ENDPOINT = 'https://theporndb.net/graphql';
export const SCRAPE_TIMEOUT_MS = 3 * 60_000;
/** Folder (inside a library folder) where scenes nothing could match are kept. */
export const UNMATCHED_FOLDER = 'Unmatched';

export interface UnmatchedSceneDto {
  id: string;
  title: string | null;
  fileName: string;
  folder: string;
  duration: number | null;
  size: number | null;
  resolution: string | null;
  imageUrl: string | null;
  hasFingerprint: boolean;
}

export interface MatchCandidateDto {
  id: string;
  title: string | null;
  date: string | null;
  studio: string | null;
  performers: string[];
  /** The performers with their photos, as the match would save them. */
  cast: Array<{ name: string; imageUrl: string | null }>;
  studioImageUrl: string | null;
  tags: string[];
  imageUrl: string | null;
  duration: number | null;
  code: string | null;
  /** Where the match came from, e.g. StashDB, FansDB, ThePornDB. */
  source: string;
  score: number;
  confidence: MatchConfidence;
  reasons: string[];
}

export interface SceneMatchesDto {
  sceneId: string;
  /** What was searched for when the fingerprints found nothing. */
  searchedFor: string | null;
  candidates: MatchCandidateDto[];
}

/** A match "Match all" found, waiting for you to check it before it's saved. */
export interface MatchProposalDto {
  scene: UnmatchedSceneDto;
  match: MatchCandidateDto;
  /** The other possible matches, best first; any of them can be picked instead. */
  alternatives: MatchCandidateDto[];
  /** How many other possible matches there were. */
  others: number;
  foundAt: string;
}

export type RenameState =
  | 'ready'
  | 'same'
  | 'missing'
  | 'whisparr'
  | 'outside'
  | 'no-file'
  /** Stash lists the file, but it isn't on disk there anymore. */
  | 'gone'
  /** Another file already has the new name (often Whisparr's copy of it). */
  | 'taken'
  /** The scene already has a file with the new name; this one is an extra copy. */
  | 'copy';

export interface RenamePlanDto {
  sceneId: string;
  fileId: string | null;
  title: string;
  from: string | null;
  to: string | null;
  state: RenameState;
  /** For an extra copy: the scene's file that already has the right name. */
  keepFileId?: string;
  /**
   * When Stashboard already made this exact rename and the file got its old
   * name back since (Whisparr renaming its own files, say).
   */
  renamedBefore?: string;
  /** For a "taken" file: what the file that has the new name is. */
  taken?: TakenInfo;
}

/**
 * The file that already has a "taken" plan's new name, as Stashboard checked
 * it itself, and the fix that's safe for it.
 */
export interface TakenInfo {
  /** The other file's scene in Stash; null when Stash hasn't scanned it. */
  otherSceneId: string | null;
  /** Both files are the same size (almost surely the same video); null when unknown. */
  sameSize: boolean | null;
  /** scan: Stash needs to see the other file; merge: keep it, drop this copy. */
  fix: 'scan' | 'merge' | 'none';
  note: string;
}

export interface RenamePreviewDto {
  pattern: string;
  scanned: number;
  counts: Record<RenameState, number>;
  changes: RenamePlanDto[];
  skipped: RenamePlanDto[];
}

/** A scene still "waiting for import", and why. */
export interface WaitingScene {
  stashId: string;
  title: string | null;
  /** Whisparr's file, as Stash would see it. */
  path: string | null;
  /** The other StashDB scene Stash links the file to, when there is one. */
  linkedTo: string | null;
  /**
   * What it's waiting on: Whisparr still importing, Stash not seeing the
   * file, the file linked to another scene, or nothing (just catching up).
   */
  kind:
    | 'importing'
    | 'no-whisparr-file'
    | 'not-in-stash'
    | 'other-scene'
    | 'not-linked'
    | 'catching-up';
  reason: string;
}

/** Why Whisparr's imports leave a copy behind. */
export interface WhisparrLeavesCopies {
  /** Whisparr's own download imports, or Stashboard handing files over with "Hardlink / copy". */
  by: 'whisparr' | 'stashboard';
  /** Whisparr hardlinks rather than copies; null when it isn't known. */
  hardlinks: boolean | null;
}

/** What "Sync with Whisparr" did. */
export interface WhisparrSyncResult {
  rescanned: number;
  removed: number;
  linked: number;
  /** Extra copies that couldn't be removed. */
  failed: number;
  /** Short lowercase steps, e.g. "removed 4 extra copies", for other summaries. */
  steps: string[];
  message: string;
}

export interface WaitingCheckResult {
  checked: number;
  /** No longer waiting after the check. */
  fixed: number;
  left: WaitingScene[];
}

export interface OrganizerRunDto {
  running: boolean;
  kind: 'match' | 'rename' | 'undo' | 'whisparr' | 'unmatched' | 'sync' | null;
  processed: number;
  total: number;
  matched: number;
  renamed: number;
  skipped: number;
  failed: number;
  message: string | null;
}

export interface OrganizerSettingsDto {
  renamePattern: string;
  /** Library folder renamed files go to; empty keeps each file in its current one. */
  renameRoot: string;
  /** Stash's library folders, to choose from. */
  libraryRoots: string[];
  renameAfterMatch: boolean;
  /** After "Match all", move what's still unmatched into the Unmatched folder. */
  moveUnmatched: boolean;
  /** Remove folders left empty after files are moved. */
  cleanEmptyFolders: boolean;
  /** Stashboard can see the library folders itself (needed to remove empty folders). */
  folderAccess: boolean;
  skipWhisparrFiles: boolean;
  autoMatchNightly: boolean;
  useStashScrapers: boolean;
  hasTpdbKey: boolean;
  sendToWhisparr: boolean;
  addToWhisparr: boolean;
  whisparrImportMode: 'move' | 'copy';
  whisparrPathFrom: string;
  whisparrPathTo: string;
  /** Whisparr is set up in Stashboard. */
  whisparrAvailable: boolean;
  /** Scenes Stash has that Whisparr still shows as missing. */
  missingInWhisparr: number;
  /**
   * Whisparr's imports leave the original file behind (a hardlink or copy),
   * so Stash can end up with two copies. Null when they don't, or it isn't known.
   */
  whisparrLeavesCopies: WhisparrLeavesCopies | null;
  /** Where matches are looked up, in order. */
  sources: Array<{ name: string; kind: 'catalog' | 'stash-box' | 'tpdb' }>;
  /** Stash scrapers that can look up a file, used after the sources above. */
  scrapers: string[];
  tokens: string[];
  run: OrganizerRunDto;
  lastRun: {
    kind: string | null;
    at: string | null;
    status: string | null;
    message: string | null;
  };
  undo: { batchId: string; count: number; at: string } | null;
}

export interface OrganizerSettingsUpdate {
  renamePattern?: string;
  renameRoot?: string;
  renameAfterMatch?: boolean;
  moveUnmatched?: boolean;
  cleanEmptyFolders?: boolean;
  skipWhisparrFiles?: boolean;
  autoMatchNightly?: boolean;
  useStashScrapers?: boolean;
  /** Empty string removes the key. */
  tpdbApiKey?: string;
  sendToWhisparr?: boolean;
  addToWhisparr?: boolean;
  whisparrImportMode?: 'move' | 'copy';
  whisparrPathFrom?: string;
  whisparrPathTo?: string;
}

export interface MatchSource {
  /** Short id used in candidate ids. */
  key: string;
  name: string;
  kind: 'catalog' | 'stash-box' | 'tpdb';
  /** How Stashboard reaches it. */
  api: { baseUrl: string; apiKey: string | null };
  /** The endpoint as Stash knows it, so stash ids line up. */
  endpoint: string;
  /** Only the main catalog counts toward Stashboard's health status. */
  primary: boolean;
}

export interface CachedCandidate {
  scene: StashdbMatchScene;
  source: MatchSource;
  expires: number;
}

export interface Context {
  config: StashAdapterBaseConfig;
  sources: MatchSource[];
  /** Stash's own Identify defaults, which matching follows too. */
  identify?: {
    includeMalePerformers: boolean | null;
    createMissing: Record<'performers' | 'studio' | 'tags', boolean | null>;
  };
}

export const IDLE_RUN: OrganizerRunDto = {
  running: false,
  kind: null,
  processed: 0,
  total: 0,
  matched: 0,
  renamed: 0,
  skipped: 0,
  failed: 0,
  message: null,
};

/**
 * Library organizer: matches scenes Stash couldn't identify to StashDB (by
 * video fingerprint first, then by file name), and renames files into tidy
 * folders through Stash, with undo.
 */
