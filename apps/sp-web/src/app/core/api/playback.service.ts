import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type PlaybackSourceKind = 'direct' | 'mp4' | 'webm' | 'hls';

export interface PlaybackSource {
  kind: PlaybackSourceKind;
  label: string;
  mimeType: string;
  /** Stash resolution key (e.g. FULL_HD); null for the original file. */
  resolution: string | null;
  url: string;
}

/** A chapter, from a Stash scene marker. */
export interface SceneMarker {
  id: string;
  title: string;
  seconds: number;
  imageUrl: string;
}

export interface PlaybackInfo {
  sceneId: string;
  title: string;
  studio: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  resumeTime: number;
  playCount: number;
  posterUrl: string | null;
  thumbnailsVttUrl: string | null;
  sources: PlaybackSource[];
  markers?: SceneMarker[];
  viewUrl: string;
  /** Unix seconds when the signed stream links stop working. */
  expiresAt: number;
}

export interface LocalSceneFile {
  basename: string | null;
  size: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  frameRate: number | null;
  bitRate: number | null;
}

/** A scene in the user's own Stash library, for the local scene page. */
export interface LocalSceneDetails {
  id: string;
  title: string;
  code: string | null;
  details: string | null;
  date: string | null;
  rating100: number | null;
  oCounter: number;
  playCount: number;
  resumeTime: number;
  duration: number | null;
  organized: boolean;
  imageUrl: string | null;
  studio: { id: string; name: string; imageUrl: string | null } | null;
  performers: Array<{
    id: string;
    name: string;
    gender: string | null;
    favorite: boolean;
    imageUrl: string | null;
  }>;
  tags: Array<{ id: string; name: string }>;
  markers?: SceneMarker[];
  files: LocalSceneFile[];
  catalogSceneId: string | null;
  viewUrl: string;
}

@Injectable({ providedIn: 'root' })
export class PlaybackService {
  private readonly http = inject(HttpClient);

  getInfo(sceneId: string): Observable<PlaybackInfo> {
    return this.http.get<PlaybackInfo>(`/api/playback/scenes/${encodeURIComponent(sceneId)}`);
  }

  getSceneDetails(sceneId: string): Observable<LocalSceneDetails> {
    return this.http.get<LocalSceneDetails>(
      `/api/playback/scenes/${encodeURIComponent(sceneId)}/details`,
    );
  }

  saveActivity(sceneId: string, resumeTime: number, playDuration: number): Observable<void> {
    return this.http.post<void>(`/api/playback/scenes/${encodeURIComponent(sceneId)}/activity`, {
      resumeTime,
      playDuration,
    });
  }

  addPlay(sceneId: string): Observable<void> {
    return this.http.post<void>(`/api/playback/scenes/${encodeURIComponent(sceneId)}/play`, {});
  }

  /**
   * Saves progress in a way that survives the page or app closing. Installed
   * apps are often closed without warning, so this is used on hide/close.
   */
  saveActivityOnExit(sceneId: string, resumeTime: number, playDuration: number): void {
    const url = `/api/playback/scenes/${encodeURIComponent(sceneId)}/activity`;
    const body = JSON.stringify({ resumeTime, playDuration });
    try {
      const sent =
        typeof navigator.sendBeacon === 'function' &&
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      if (sent) {
        return;
      }
    } catch {
      // fall through to fetch
    }
    void fetch(url, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined);
  }
}
