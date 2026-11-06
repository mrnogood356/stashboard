import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { LocalSceneDetails } from './playback.service';

/** A scene from your Stash library, shaped for scene cards. */
export interface LocalSceneCard {
  id: string;
  title: string;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
  releaseDate: string | null;
  duration: number | null;
  playCount: number;
  progress: number | null;
  /** When it was last played (history only). */
  lastPlayedAt?: string | null;
  type: 'SCENE';
  source: 'STASH';
}

export type MergeKind = 'performers' | 'studios';

export interface MergeCandidate {
  id: string;
  name: string;
  aliases: string[];
  sceneCount: number;
  /** A performer's disambiguation, or a studio's parent. */
  note: string | null;
  deathDate: string | null;
}

export interface MergeCandidates {
  groups: Array<{ keepId: string; items: MergeCandidate[] }>;
  matches: MergeCandidate[];
}

/** A chapter (Stash scene marker) from anywhere in the library. */
export interface Chapter {
  id: string;
  title: string;
  seconds: number;
  endSeconds: number;
  tagName: string | null;
  sceneId: string;
  sceneTitle: string;
  imageUrl: string;
  previewUrl: string;
}

export interface LocalScenePage {
  total: number;
  page: number;
  hasMore: boolean;
  items: LocalSceneCard[];
}

export type LocalSceneSort = 'DATE' | 'ADDED' | 'PLAYS' | 'TITLE' | 'RANDOM';

export interface LocalPerformer {
  id: string;
  name: string;
  disambiguation: string | null;
  gender: string | null;
  birthdate: string | null;
  /** When they died, when Stash has it. */
  deathDate?: string | null;
  country: string | null;
  details: string | null;
  favorite: boolean;
  imageUrl: string | null;
  sceneCount: number;
}

export interface LocalStudio {
  id: string;
  name: string;
  favorite: boolean;
  imageUrl: string | null;
  sceneCount: number;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
  /** Its StashDB/FansDB ids. Older APIs: missing. */
  catalogIds?: string[];
}

export interface LocalSceneUpdate {
  rating100?: number | null;
  organized?: boolean;
  tagIds?: string[];
}

export interface LocalSearchResults {
  performers: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
    favorite: boolean;
    /** Their StashDB/FansDB ids. Older APIs: missing. */
    catalogIds?: string[];
  }>;
  studios: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
    catalogIds?: string[];
  }>;
}

export interface LibraryStatsBucket {
  key: string;
  label: string;
  files: number;
  bytes: number;
}

export interface LibraryStatsFile {
  sceneId: string;
  title: string;
  studioName: string | null;
  bytes: number;
  resolution: string | null;
  codec: string | null;
  duration: number | null;
  saving?: number;
}

export interface LibraryStats {
  computedAt: string;
  scenes: number;
  files: number;
  bytes: number;
  duration: number;
  byResolution: LibraryStatsBucket[];
  byCodec: LibraryStatsBucket[];
  topStudios: Array<LibraryStatsBucket & { studioId: string }>;
  biggest: LibraryStatsFile[];
  reencode: { saving: number; files: number; top: LibraryStatsFile[] };
}

export type FixKind = 'unmatched' | 'untagged' | 'unorganized';
export type FixCounts = Record<FixKind, number>;
export type LibraryTask = 'scan' | 'generate' | 'identify' | 'auto-tag' | 'clean';

export interface StashJob {
  id: string;
  status: string;
  description: string;
  progress: number | null;
  subTasks: string[];
  addTime: string | null;
  startTime: string | null;
}

export interface SampleScene extends DuplicateScene {
  /** Why it looks like a sample: its name says so, or it's very short. */
  reason: 'name' | 'short';
}

export interface DuplicateScene {
  id: string;
  title: string;
  date: string | null;
  studio: string | null;
  playCount: number;
  organized: boolean;
  imageUrl: string | null;
  /** Deleting the scene from disk deletes all of its files. */
  fileCount?: number;
  file: {
    path: string | null;
    basename: string | null;
    size: number | null;
    width: number | null;
    height: number | null;
    duration: number | null;
    videoCodec: string | null;
    bitRate: number | null;
    frameRate: number | null;
  } | null;
}

export interface DuplicateGroup {
  scenes: DuplicateScene[];
  suggestedKeepId: string;
  /** Why that one, in plain words. */
  keepReason?: string;
}

/** Organizing and browsing your own Stash library (saved straight to Stash). */
@Injectable({ providedIn: 'root' })
export class LocalLibraryService {
  private readonly http = inject(HttpClient);

  updateScene(sceneId: string, update: LocalSceneUpdate): Observable<LocalSceneDetails> {
    return this.http.patch<LocalSceneDetails>(`/api/local/scenes/${enc(sceneId)}`, update);
  }

  setWatched(sceneId: string, watched: boolean): Observable<LocalSceneDetails> {
    return this.http.post<LocalSceneDetails>(`/api/local/scenes/${enc(sceneId)}/watched`, {
      watched,
    });
  }

  /** Chapters across the library, by tag, performer or words. */
  chapters(filter: { tag?: string; performer?: string; q?: string }): Observable<Chapter[]> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (value) {
        params[key] = value;
      }
    }
    return this.http.get<Chapter[]>('/api/local/chapters', { params });
  }

  chapterTags(): Observable<Array<{ id: string; name: string; count: number }>> {
    return this.http.get<Array<{ id: string; name: string; count: number }>>(
      '/api/local/chapters/tags',
    );
  }

  /** What you've played, latest first. */
  history(page = 1): Observable<LocalScenePage> {
    return this.http.get<LocalScenePage>('/api/local/history', { params: { page } });
  }

  related(sceneId: string): Observable<LocalSceneCard[]> {
    return this.http.get<LocalSceneCard[]>(`/api/local/scenes/${enc(sceneId)}/related`);
  }

  performer(id: string): Observable<LocalPerformer> {
    return this.http.get<LocalPerformer>(`/api/local/performers/${enc(id)}`);
  }

  performerScenes(
    id: string,
    page: number,
    sort: LocalSceneSort,
    seed = 0,
  ): Observable<LocalScenePage> {
    return this.http.get<LocalScenePage>(`/api/local/performers/${enc(id)}/scenes`, {
      params: pageParams(page, sort, seed),
    });
  }

  setPerformerFavorite(id: string, favorite: boolean): Observable<LocalPerformer> {
    return this.http.put<LocalPerformer>(`/api/local/performers/${enc(id)}/favorite`, { favorite });
  }

  studio(id: string): Observable<LocalStudio> {
    return this.http.get<LocalStudio>(`/api/local/studios/${enc(id)}`);
  }

  studioScenes(
    id: string,
    page: number,
    sort: LocalSceneSort,
    seed = 0,
  ): Observable<LocalScenePage> {
    return this.http.get<LocalScenePage>(`/api/local/studios/${enc(id)}/scenes`, {
      params: pageParams(page, sort, seed),
    });
  }

  setStudioFavorite(id: string, favorite: boolean): Observable<LocalStudio> {
    return this.http.put<LocalStudio>(`/api/local/studios/${enc(id)}/favorite`, { favorite });
  }

  search(query: string): Observable<LocalSearchResults> {
    return this.http.get<LocalSearchResults>('/api/local/search', {
      params: new HttpParams().set('query', clampQuery(query)),
    });
  }

  addMarker(
    sceneId: string,
    marker: { title: string; seconds: number; primaryTagId: string },
  ): Observable<LocalSceneDetails> {
    return this.http.post<LocalSceneDetails>(`/api/local/scenes/${enc(sceneId)}/markers`, marker);
  }

  deleteMarker(sceneId: string, markerId: string): Observable<LocalSceneDetails> {
    return this.http.delete<LocalSceneDetails>(
      `/api/local/scenes/${enc(sceneId)}/markers/${enc(markerId)}`,
    );
  }

  clearResume(sceneId: string): Observable<void> {
    return this.http.post<void>(`/api/local/scenes/${enc(sceneId)}/clear-resume`, {});
  }

  feed(page: number, seed: number): Observable<LocalScenePage> {
    return this.http.get<LocalScenePage>('/api/local/feed', {
      params: new HttpParams().set('page', page).set('seed', seed),
    });
  }

  fixCounts(): Observable<FixCounts> {
    return this.http.get<FixCounts>('/api/local/fix/counts');
  }

  /** With offset, the list carries on right after the scenes already shown. */
  fixScenes(kind: FixKind, page: number, offset?: number): Observable<LocalScenePage> {
    let params = new HttpParams().set('page', page);
    if (offset !== undefined) {
      params = params.set('offset', offset);
    }
    return this.http.get<LocalScenePage>(`/api/local/fix/${kind}`, { params });
  }

  /** organize: mark organized; remove: off Stash, files stay; delete: files too. */
  bulkScenes(
    action: 'organize' | 'remove' | 'delete',
    sceneIds: string[],
  ): Observable<{ action: string; done: string[]; failed: Array<{ id: string; reason: string }> }> {
    return this.http.post<{
      action: string;
      done: string[];
      failed: Array<{ id: string; reason: string }>;
    }>('/api/local/scenes/bulk', { action, sceneIds });
  }

  identify(sceneIds: string[]): Observable<{ jobId: string | null }> {
    return this.http.post<{ jobId: string | null }>('/api/local/identify', { sceneIds });
  }

  jobs(): Observable<StashJob[]> {
    return this.http.get<StashJob[]>('/api/local/jobs');
  }

  startJob(task: LibraryTask): Observable<{ jobId: string | null }> {
    return this.http.post<{ jobId: string | null }>(`/api/local/jobs/${task}`, {});
  }

  /** Generate (previews, sprites, covers, fingerprints) for just these scenes. */
  generateFor(sceneIds: string[]): Observable<{ jobId: string | null }> {
    return this.http.post<{ jobId: string | null }>('/api/local/generate', { sceneIds });
  }

  similarTags(): Observable<SimilarTagGroup[]> {
    return this.http.get<SimilarTagGroup[]>('/api/local/tags/similar');
  }

  mergeTags(destinationId: string, sourceIds: string[]): Observable<void> {
    return this.http.post<void>('/api/local/tags/merge', { destinationId, sourceIds });
  }

  /** `refresh`: check every marker's preview again instead of the last check. */
  problems(refresh = false): Observable<ProblemList[]> {
    return this.http.get<ProblemList[]>('/api/local/problems', {
      params: refresh ? new HttpParams().set('refresh', '1') : new HttpParams(),
    });
  }

  stopJob(jobId: string): Observable<void> {
    return this.http.delete<void>(`/api/local/jobs/${enc(jobId)}`);
  }

  /** What the library is made of; refresh asks Stash again instead of the last 30 minutes' answer. */
  stats(refresh = false): Observable<LibraryStats> {
    return this.http.get<LibraryStats>('/api/local/stats', {
      params: refresh ? { refresh: '1' } : {},
    });
  }

  duplicates(accuracy: 'exact' | 'high' | 'medium'): Observable<DuplicateGroup[]> {
    return this.http.get<DuplicateGroup[]>('/api/local/duplicates', {
      params: new HttpParams().set('accuracy', accuracy),
    });
  }

  /** Sample clips: "sample" in the name, and when given, anything shorter than that many minutes. */
  samples(shorterThanMinutes: 0 | 1 | 2 | 5): Observable<SampleScene[]> {
    return this.http.get<SampleScene[]>('/api/local/samples', {
      params: new HttpParams().set('shorterThan', String(shorterThanMinutes)),
    });
  }

  /** `onlyFile`: refuse a scene with more than one file, whose others would go too. */
  deleteScene(
    sceneId: string,
    deleteFile: boolean,
    onlyFile = false,
    /** Duplicates: first carry plays, tags, chapters and more to this scene. */
    carryTo?: string,
  ): Observable<void> {
    let params = new HttpParams().set('deleteFile', String(deleteFile));
    if (onlyFile) {
      params = params.set('onlyFile', 'true');
    }
    if (carryTo) {
      params = params.set('carryTo', carryTo);
    }
    return this.http.delete<void>(`/api/local/scenes/${enc(sceneId)}`, { params });
  }

  /** A duplicate set you checked: hidden until its scenes change. */
  ignoreDuplicates(sceneIds: string[]): Observable<void> {
    return this.http.post<void>('/api/local/duplicates/ignore', { sceneIds });
  }

  ignoredDuplicates(): Observable<{ count: number }> {
    return this.http.get<{ count: number }>('/api/local/duplicates/ignored');
  }

  clearIgnoredDuplicates(): Observable<void> {
    return this.http.delete<void>('/api/local/duplicates/ignored');
  }

  /** Performers or studios entered more than once, and names matching `q`. */
  mergeCandidates(kind: MergeKind, q = ''): Observable<MergeCandidates> {
    return this.http.get<MergeCandidates>(`/api/local/merge/${kind}`, {
      params: q.trim() ? { q: q.trim() } : {},
    });
  }

  merge(kind: MergeKind, keepId: string, mergeIds: string[]): Observable<void> {
    return this.http.post<void>(`/api/local/merge/${kind}`, { keepId, mergeIds });
  }

  searchTags(query: string): Observable<Array<{ id: string; name: string }>> {
    return this.http.get<Array<{ id: string; name: string }>>('/api/local/tags', {
      params: new HttpParams().set('query', clampQuery(query)),
    });
  }
}

/** The API refuses longer searches (400), which would read as "no results". */
const MAX_QUERY_LENGTH = 100;

function clampQuery(query: string): string {
  return query.trim().slice(0, MAX_QUERY_LENGTH);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function pageParams(page: number, sort: LocalSceneSort, seed: number): HttpParams {
  let params = new HttpParams().set('page', page).set('sort', sort);
  if (sort === 'RANDOM') {
    params = params.set('seed', seed);
  }
  return params;
}

export interface TagSummary {
  id: string;
  name: string;
  aliases: string[];
  sceneCount: number;
}

/** The same tag written more than one way; keepId is the one most scenes use. */
export interface SimilarTagGroup {
  keepId: string;
  tags: TagSummary[];
}

export type ProblemKind =
  'no-file' | 'no-length' | 'no-cover' | 'no-fingerprint' | 'no-marker-preview';

export interface ProblemList {
  kind: ProblemKind;
  /** Null when Stash couldn't say. */
  count: number | null;
  scenes: ProblemScene[];
}

export interface ProblemScene {
  id: string;
  title: string;
  path: string | null;
  /** Deleting the scene from disk deletes all of its files. */
  fileCount?: number;
  /** Markers of this scene without a preview clip. */
  markers?: number;
}
