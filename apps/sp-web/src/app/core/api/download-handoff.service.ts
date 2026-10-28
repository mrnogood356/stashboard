import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { CatalogProviderType } from './integrations.types';

export type HandoffStatus =
  'sent' | 'downloading' | 'completed' | 'imported' | 'failed' | 'ignored';

export interface DownloadHandoffSettings {
  enabled: boolean;
  category: string;
  destination: string | null;
  sabPathFrom: string | null;
  sabPathTo: string | null;
  importMode: 'move' | 'copy';
  /** Also bring in videos put straight into the category's folder. */
  dropIns: boolean;
  /** Also bring in downloads added to the category in SABnzbd by hand. */
  sabManualJobs: boolean;
  /** Only those SABnzbd finished since then are brought in; null until it first runs. */
  sabManualSince: string | null;
  /** That folder as Stashboard sees it; null when SABnzbd doesn't say. */
  dropInFolder: string | null;
  /** SABnzbd is added and passed its test. */
  sabnzbdReady: boolean;
  /** Stash's library folders; the destination has to be inside one. */
  libraryRoots: string[];
}

export interface DownloadHandoffSettingsUpdate {
  enabled?: boolean;
  category?: string;
  destination?: string;
  sabPathFrom?: string;
  sabPathTo?: string;
  importMode?: 'move' | 'copy';
  dropIns?: boolean;
  sabManualJobs?: boolean;
}

export type DropInStatus = 'placed' | 'imported' | 'failed';

/** A video put straight into SABnzbd's category folder and brought in. */
export interface DownloadDropIn {
  id: string;
  sourcePath: string;
  status: DropInStatus;
  /** Why it failed, or what it's waiting for. */
  error: string | null;
  finalPath: string | null;
  stashSceneId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Sent by Find downloads, or added in SABnzbd by hand and picked up. */
export type HandoffSource = 'stashboard' | 'sabnzbd-manual';

export interface DownloadHandoff {
  id: string;
  source: HandoffSource;
  /** The catalog scene it was sent for; null when added in SABnzbd. */
  sceneId: string | null;
  provider: CatalogProviderType | null;
  releaseTitle: string;
  status: HandoffStatus;
  /** Why it failed, or what it's waiting for. */
  error: string | null;
  finalPath: string | null;
  stashSceneId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DropInWatchState = 'off' | 'watching' | 'problem';

export type DropInWatchReason =
  | 'starting'
  | 'handoff-off'
  | 'drop-ins-off'
  | 'no-destination'
  | 'sab-not-set-up'
  | 'sab-unreachable'
  | 'category-missing'
  | 'shared-folder'
  | 'no-job-folders'
  | 'relative-folder'
  | 'folder-unknown'
  | 'folder-unreadable'
  | 'sab-lists-unreadable';

/** A file seen in the drop-in folder, waiting until it stops changing. */
export interface DropInSettling {
  path: string;
  name: string;
  size: number | null;
  firstSeenAt: string;
  unchangedSince: string | null;
}

/** Something in the drop-in folder that was left alone, and why. */
export interface DropInSkipped {
  path: string;
  name: string;
  reason: string;
  detail: string;
}

/** What the drop-in watcher is doing, as of its last check. */
export interface DropInWatchStatus {
  state: DropInWatchState;
  reason: DropInWatchReason | null;
  message: string | null;
  hint: string | null;
  category: string;
  folder: string | null;
  sabFolder: string | null;
  checking: boolean;
  lastCheckAt: string | null;
  lastResult: string | null;
  nextCheckAt: string | null;
  settleSeconds: number;
  settling: DropInSettling[];
  skipped: DropInSkipped[];
  lastError: { message: string; at: string } | null;
}

export type HandoffStage =
  'queued' | 'downloading' | 'unpacking' | 'moving' | 'linking' | 'done' | 'failed' | 'ignored';

/** The catalog scene a download was sent for, when Stashboard knows it. */
export interface HandoffScene {
  title: string;
  imageUrl: string | null;
  studio: string | null;
}

export interface ProcessingHandoff extends DownloadHandoff {
  stage: HandoffStage;
  /** Older APIs: missing. */
  scene?: HandoffScene | null;
  progress: number | null;
  timeLeft: string | null;
  detail: string | null;
  canRetry: boolean;
  canIgnore: boolean;
}

export interface ProcessingDropIn extends DownloadDropIn {
  name: string;
  canRetry: boolean;
}

/** Everything moving through the download pipeline, in one place. */
export interface Processing {
  handoff: {
    enabled: boolean;
    sabnzbdReady: boolean;
    category: string;
    sabnzbdUnreachable: boolean;
  };
  handoffs: ProcessingHandoff[];
  recentHandoffs: ProcessingHandoff[];
  dropIns: {
    watch: DropInWatchStatus;
    active: ProcessingDropIn[];
    recent: ProcessingDropIn[];
  };
  activeCount: number;
  problemCount: number;
}

/** Finished downloads: SABnzbd's downloads moved into your library. */
@Injectable({ providedIn: 'root' })
export class DownloadHandoffApiService {
  /** Downloads and drop-ins on their way into the library. */
  processing(): Observable<Processing> {
    return this.http.get<Processing>('/api/downloads/processing');
  }

  /** Looks at the drop-in folder now. */
  checkDropIns(): Observable<Processing> {
    return this.http.post<Processing>('/api/downloads/processing/drop-ins/check', {});
  }

  retryHandoff(id: string): Observable<Processing> {
    return this.http.post<Processing>(
      `/api/downloads/processing/handoffs/${encodeURIComponent(id)}/retry`,
      {},
    );
  }

  retryDropIn(id: string): Observable<Processing> {
    return this.http.post<Processing>(
      `/api/downloads/processing/drop-ins/${encodeURIComponent(id)}/retry`,
      {},
    );
  }

  private readonly http = inject(HttpClient);

  settings(): Observable<DownloadHandoffSettings> {
    return this.http.get<DownloadHandoffSettings>('/api/downloads/handoff');
  }

  update(update: DownloadHandoffSettingsUpdate): Observable<DownloadHandoffSettings> {
    return this.http.put<DownloadHandoffSettings>('/api/downloads/handoff', update);
  }

  recent(): Observable<DownloadHandoff[]> {
    return this.http.get<DownloadHandoff[]>('/api/downloads/handoff/recent');
  }

  dropIns(): Observable<DownloadDropIn[]> {
    return this.http.get<DownloadDropIn[]>('/api/downloads/handoff/drop-ins');
  }

  ignore(id: string): Observable<DownloadHandoff> {
    return this.http.post<DownloadHandoff>(
      `/api/downloads/handoff/${encodeURIComponent(id)}/ignore`,
      {},
    );
  }
}
