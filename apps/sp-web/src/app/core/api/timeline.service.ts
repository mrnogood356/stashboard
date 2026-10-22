import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

export type TimelineStepId =
  | 'requested'
  | 'searching'
  | 'grabbed'
  | 'downloading'
  | 'downloaded'
  | 'importing'
  | 'moved'
  | 'in-stash'
  | 'matched'
  | 'renamed'
  | 'previews';

/** done/skipped are behind it, current is now, failed is stuck, next is expected. */
export type TimelineStepStatus = 'done' | 'current' | 'failed' | 'skipped' | 'unknown' | 'next';

export type TimelineActionKind =
  'pick-release' | 'find-downloads' | 'check-matches' | 'scan' | 'generate' | 'open-whisparr';

export interface TimelineAction {
  kind: TimelineActionKind;
  label: string;
}

export interface TimelineStep {
  step: TimelineStepId;
  label: string;
  at: string | null;
  status: TimelineStepStatus;
  detail: string | null;
  /** 0–100, while downloading. */
  progress: number | null;
  action: TimelineAction | null;
}

/** A scene's request as a short story: where it's been and where it is now. */
export interface SceneTimeline {
  stashId: string;
  route: 'whisparr' | 'prowlarr' | 'sabnzbd' | 'library' | null;
  /** "Where it is now", in one line. */
  now: string;
  steps: TimelineStep[];
  /** Sources that couldn't be asked; their steps say unknown. */
  unknown: string[];
  checkedAt: string;
}

/** Ids per batch request; the API takes at most this many. */
export const TIMELINE_BATCH_LIMIT = 50;

@Injectable({ providedIn: 'root' })
export class TimelineApiService {
  private readonly http = inject(HttpClient);

  /** The whole story for one catalog scene. */
  scene(stashId: string): Observable<SceneTimeline> {
    return this.http.get<SceneTimeline>(`/api/scenes/${encodeURIComponent(stashId)}/timeline`);
  }

  /** The short version for many scenes (Stashboard's records and the queues only). */
  scenes(ids: string[]): Observable<SceneTimeline[]> {
    return this.http
      .post<{ items: SceneTimeline[] }>('/api/scenes/timelines', {
        ids: ids.slice(0, TIMELINE_BATCH_LIMIT),
      })
      .pipe(map((response) => response.items));
  }
}

/** Stuck somewhere, on its way, or done (for colouring the one-line summary). */
export function timelineTone(timeline: SceneTimeline): 'failed' | 'current' | 'done' {
  if (timeline.steps.some((step) => step.status === 'failed')) {
    return 'failed';
  }
  return timeline.steps.some((step) => step.status === 'current') ? 'current' : 'done';
}
