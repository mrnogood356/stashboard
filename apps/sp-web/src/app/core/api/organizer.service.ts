import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type MatchConfidence = 'exact' | 'strong' | 'likely' | 'weak';
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

export interface UnmatchedScene {
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

export type UnmatchedSort = 'added-desc' | 'added-asc' | 'title' | 'path' | 'date';
/** Unmatched, not linked to StashDB, or every scene. */
export type UnmatchedScope = 'unmatched' | 'unlinked' | 'all';

export interface UnmatchedListOptions {
  q?: string;
  sort?: UnmatchedSort;
  scope?: UnmatchedScope;
}

export interface UnmatchedPage {
  total: number;
  /** How many files "Move … now" would move (sent with the first page). */
  toMove?: number;
  page: number;
  hasMore: boolean;
  items: UnmatchedScene[];
}

export interface MatchCandidate {
  id: string;
  title: string | null;
  date: string | null;
  studio: string | null;
  performers: string[];
  /** The performers with their photos. */
  cast?: Array<{ name: string; imageUrl: string | null }>;
  studioImageUrl?: string | null;
  tags?: string[];
  imageUrl: string | null;
  duration: number | null;
  code: string | null;
  source: string;
  score: number;
  confidence: MatchConfidence;
  reasons: string[];
}

export interface SceneMatches {
  sceneId: string;
  searchedFor: string | null;
  candidates: MatchCandidate[];
}

/** A match "Match all" found, waiting for you to check it before it's saved. */
export interface MatchProposal {
  scene: UnmatchedScene;
  match: MatchCandidate;
  /** The other possible matches, best first; any of them can be picked instead. */
  alternatives: MatchCandidate[];
  /** How many other possible matches there were. */
  others: number;
  foundAt: string;
}

export interface OrganizerRun {
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

export interface OrganizerSettings {
  renamePattern: string;
  renameRoot: string;
  libraryRoots: string[];
  renameAfterMatch: boolean;
  moveUnmatched: boolean;
  cleanEmptyFolders: boolean;
  /** Folders the clean-up never removes, with everything inside them. */
  keepFolders: string[];
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
  whisparrAvailable: boolean;
  missingInWhisparr: number;
  /** Whisparr's imports leave the original behind (a hardlink or copy); null when not, or unknown. */
  whisparrLeavesCopies?: { by: 'whisparr' | 'stashboard'; hardlinks: boolean | null } | null;
  sources: Array<{ name: string; kind: 'catalog' | 'stash-box' | 'tpdb' }>;
  scrapers: string[];
  tokens: string[];
  run: OrganizerRun;
  lastRun: {
    kind: string | null;
    at: string | null;
    status: string | null;
    message: string | null;
  };
  undo: { batchId: string; count: number; at: string } | null;
}

export interface RenamePlan {
  sceneId: string;
  fileId: string | null;
  title: string;
  from: string | null;
  to: string | null;
  state: RenameState;
  /** For an extra copy: the scene's file that already has the right name. */
  keepFileId?: string;
  /** Stashboard made this same rename before, and the file got its old name back since. */
  renamedBefore?: string;
  /** For a "taken" file: what the file that has the new name is, and the safe fix. */
  taken?: {
    otherSceneId: string | null;
    sameSize: boolean | null;
    fix: 'scan' | 'merge' | 'none';
    note: string;
  };
}

export interface RenamePreview {
  pattern: string;
  scanned: number;
  counts: Record<RenameState, number>;
  changes: RenamePlan[];
  skipped: RenamePlan[];
}

export interface ApplyResult {
  sceneId: string;
  renamedTo: string | null;
  sentToWhisparr: boolean;
  whisparrNote: string | null;
}

/** A scene still "waiting for import", and why. */
export interface WaitingScene {
  stashId: string;
  title: string | null;
  path: string | null;
  /** The other StashDB scene Stash links the file to, when there is one. */
  linkedTo: string | null;
  /** What it's waiting on. */
  kind?:
    | 'importing'
    | 'no-whisparr-file'
    | 'not-in-stash'
    | 'other-scene'
    | 'not-linked'
    | 'catching-up';
  reason: string;
}

export interface WaitingCheck {
  checked: number;
  fixed: number;
  left: WaitingScene[];
}

export interface WhisparrPathCheck {
  ok: boolean;
  stashPath: string | null;
  whisparrPath: string | null;
  message: string;
}

export type OrganizerSettingsUpdate = Partial<
  Pick<
    OrganizerSettings,
    | 'renamePattern'
    | 'renameRoot'
    | 'renameAfterMatch'
    | 'moveUnmatched'
    | 'cleanEmptyFolders'
    | 'keepFolders'
    | 'skipWhisparrFiles'
    | 'autoMatchNightly'
    | 'useStashScrapers'
    | 'sendToWhisparr'
    | 'addToWhisparr'
    | 'whisparrImportMode'
    | 'whisparrPathFrom'
    | 'whisparrPathTo'
  >
> & { tpdbApiKey?: string };

@Injectable({ providedIn: 'root' })
export class OrganizerApiService {
  private readonly http = inject(HttpClient);

  settings(): Observable<OrganizerSettings> {
    return this.http.get<OrganizerSettings>('/api/organizer');
  }

  update(update: OrganizerSettingsUpdate): Observable<OrganizerSettings> {
    return this.http.put<OrganizerSettings>('/api/organizer', update);
  }

  status(): Observable<OrganizerRun> {
    return this.http.get<OrganizerRun>('/api/organizer/status');
  }

  unmatched(page = 1, options: UnmatchedListOptions = {}): Observable<UnmatchedPage> {
    let params = new HttpParams().set('page', page);
    if (options.q?.trim()) {
      params = params.set('q', options.q.trim());
    }
    if (options.sort) {
      params = params.set('sort', options.sort);
    }
    if (options.scope) {
      params = params.set('scope', options.scope);
    }
    return this.http.get<UnmatchedPage>('/api/organizer/unmatched', { params });
  }

  lookup(sceneIds: string[], query?: string): Observable<SceneMatches[]> {
    return this.http.post<SceneMatches[]>(
      '/api/organizer/lookup',
      query ? { sceneIds, query } : { sceneIds },
    );
  }

  apply(sceneId: string, candidateId: string): Observable<ApplyResult> {
    return this.http.post<ApplyResult>('/api/organizer/apply', { sceneId, candidateId });
  }

  sendAllToWhisparr(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/whisparr/send-all', {});
  }

  detectWhisparrPath(): Observable<{
    found: boolean;
    from: string;
    to: string;
    example: string | null;
    message: string;
  }> {
    return this.http.post<{
      found: boolean;
      from: string;
      to: string;
      example: string | null;
      message: string;
    }>('/api/organizer/whisparr/detect', {});
  }

  whisparrRelocation(): Observable<{
    destination: string;
    count: number;
    examples: string[];
  } | null> {
    return this.http.get<{ destination: string; count: number; examples: string[] } | null>(
      '/api/organizer/whisparr/relocate',
    );
  }

  emptyFolders(): Observable<{
    available: boolean;
    count: number;
    folders: string[];
    galleries?: number;
    error?: string | null;
  }> {
    return this.http.get<{
      available: boolean;
      count: number;
      folders: string[];
      galleries?: number;
      error?: string | null;
    }>('/api/organizer/folders/empty');
  }

  cleanEmptyFolders(): Observable<{ removed: number; kept: number }> {
    return this.http.post<{ removed: number; kept: number }>('/api/organizer/folders/clean', {});
  }

  /** Whisparr's folder and file formats as one pattern; null when Whisparr isn't set up. */
  whisparrNaming(): Observable<WhisparrNaming | null> {
    return this.http.get<WhisparrNaming | null>('/api/organizer/whisparr/naming');
  }

  whisparrRepair(): Observable<WhisparrRepairPlan | null> {
    return this.http.get<WhisparrRepairPlan | null>('/api/organizer/whisparr/repair');
  }

  repairWhisparr(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/whisparr/repair', {});
  }

  relocateWhisparr(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/whisparr/relocate', {});
  }

  /** Fixes what it can for scenes waiting for import, and says why the rest wait. */
  checkWaiting(): Observable<WaitingCheck> {
    return this.http.post<WaitingCheck>('/api/organizer/waiting/check', {});
  }

  /** Counts Whisparr's StashDB scene as the one Stash has its file linked to. */
  markSameScene(stashId: string): Observable<WaitingCheck> {
    return this.http.post<WaitingCheck>(
      `/api/organizer/waiting/${encodeURIComponent(stashId)}/same-scene`,
      {},
    );
  }

  checkWhisparrPath(): Observable<WhisparrPathCheck> {
    return this.http.post<WhisparrPathCheck>('/api/organizer/whisparr/check', {});
  }

  scrape(sceneId: string): Observable<{
    sceneId: string;
    filled: boolean;
    title: string | null;
    renamedTo: string | null;
  }> {
    return this.http.post<{
      sceneId: string;
      filled: boolean;
      title: string | null;
      renamedTo: string | null;
    }>('/api/organizer/scrape', { sceneId });
  }

  /** Rescan, remove extra copies and link scenes waiting for import, in the background. */
  syncWithWhisparr(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/whisparr/sync', {});
  }

  /** Finds matches for these scenes to check, in the background. */
  matchSelected(sceneIds: string[]): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/match-selected', { sceneIds });
  }

  moveUnmatched(sceneIds?: string[]): Observable<OrganizerRun> {
    if (sceneIds?.length) {
      return this.http.post<OrganizerRun>('/api/organizer/unmatched/move', { sceneIds });
    }
    return this.http.post<OrganizerRun>('/api/organizer/unmatched/move', {});
  }

  /** Matches found by Match all, waiting for you to check them. */
  proposals(): Observable<MatchProposal[]> {
    return this.http.get<MatchProposal[]>('/api/organizer/proposals');
  }

  /** Saves these found matches, in the background. */
  saveProposals(sceneIds: string[]): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/proposals/save', { sceneIds });
  }

  /** Picks one of a found match's alternatives instead (still saved only on Save). */
  chooseProposal(sceneId: string, candidateId: string): Observable<MatchProposal> {
    return this.http.post<MatchProposal>('/api/organizer/proposals/choose', {
      sceneId,
      candidateId,
    });
  }

  dismissProposals(sceneIds: string[]): Observable<{ left: number }> {
    return this.http.post<{ left: number }>('/api/organizer/proposals/dismiss', { sceneIds });
  }

  matchAll(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/match-all', {});
  }

  /** Scans what Stash doesn't know, or merges and drops the extra copy, for these "taken" files. */
  fixTaken(sceneIds: string[]): Observable<{
    scanned: number;
    merged: number;
    skipped: Array<{ sceneId: string; reason: string }>;
  }> {
    return this.http.post<{
      scanned: number;
      merged: number;
      skipped: Array<{ sceneId: string; reason: string }>;
    }>('/api/organizer/rename/taken/fix', { sceneIds });
  }

  preview(pattern?: string): Observable<RenamePreview> {
    return this.http.post<RenamePreview>(
      '/api/organizer/rename/preview',
      pattern ? { pattern } : {},
    );
  }

  rename(sceneIds: string[]): Observable<{
    moved: Array<{ sceneId: string; to: string }>;
    failed: Array<{ sceneId: string; reason: string }>;
  }> {
    return this.http.post<{
      moved: Array<{ sceneId: string; to: string }>;
      failed: Array<{ sceneId: string; reason: string }>;
    }>('/api/organizer/rename', { sceneIds });
  }

  /** Deletes the extra copies the rename preview found; each scene keeps its correctly named file. */
  removeExtraCopies(): Observable<{
    removed: number;
    failed: Array<{ sceneId: string; reason: string }>;
  }> {
    return this.http.post<{
      removed: number;
      failed: Array<{ sceneId: string; reason: string }>;
    }>('/api/organizer/rename/remove-copies', {});
  }

  renameAll(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/rename-all', {});
  }

  undo(): Observable<OrganizerRun> {
    return this.http.post<OrganizerRun>('/api/organizer/undo', {});
  }
}

/** One scene a Whisparr repair would touch (folders as Stash sees them). */
export interface WhisparrRepairScene {
  title: string;
  /** move: Whisparr moves it with its file; path: only the path changes; reimport: imported again from Stash. */
  action: 'move' | 'path' | 'reimport';
  from: string | null;
  to: string | null;
}

export interface WhisparrNaming {
  folderFormat: string | null;
  fileFormat: string | null;
  /** Both as one Stashboard pattern; null when it can't be used (see problem). */
  pattern: string | null;
  problem: string | null;
}

export interface WhisparrRepairPlan {
  count: number;
  destination: string;
  rootFolder?: string;
  folderFormat?: string;
  /** The folders come from Whisparr's own Scene Folder Format. */
  usesWhisparrNaming?: boolean;
  /** Up to 500 of the scenes the repair would touch. */
  scenes?: WhisparrRepairScene[];
}
