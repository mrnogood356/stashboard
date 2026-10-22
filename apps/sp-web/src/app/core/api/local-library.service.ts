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
  type: 'SCENE';
  source: 'STASH';
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
  }>;
  studios: Array<{ id: string; name: string; imageUrl: string | null; sceneCount: number }>;
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

  stopJob(jobId: string): Observable<void> {
    return this.http.delete<void>(`/api/local/jobs/${enc(jobId)}`);
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

  deleteScene(sceneId: string, deleteFile: boolean): Observable<void> {
    return this.http.delete<void>(`/api/local/scenes/${enc(sceneId)}`, {
      params: new HttpParams().set('deleteFile', String(deleteFile)),
    });
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
