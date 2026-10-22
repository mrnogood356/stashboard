// A scene's request told as a short story: the steps it went through, the
// one it's on, and the one expected next. "Why is it like this?" has the
// raw facts; this is the simple version.

export type TimelineStepId =
  | 'requested'
  | 'searching'
  | 'grabbed'
  | 'downloading'
  | 'downloaded'
  /** Whisparr moving the download into your library. */
  | 'importing'
  /** Finished downloads (SABnzbd) moving it into your library. */
  | 'moved'
  | 'in-stash'
  | 'matched'
  | 'renamed'
  | 'previews';

/**
 * done and skipped are behind it; current is where it is now; failed is
 * where it's stuck; unknown when the source couldn't be asked; next is the
 * step expected after the last one reached.
 */
export type TimelineStepStatus =
  'done' | 'current' | 'failed' | 'skipped' | 'unknown' | 'next';

/** How it was asked for. library: it was never requested, it's just in Stash. */
export type TimelineRoute = 'whisparr' | 'prowlarr' | 'sabnzbd' | 'library';

/** What the user can do about a step; the page decides where it goes. */
export type TimelineActionKind =
  /** Choose a release in Whisparr's search. */
  | 'pick-release'
  /** Search Prowlarr again (Find downloads). */
  | 'find-downloads'
  /** Match & rename in Library Tools. */
  | 'check-matches'
  /** Have Stash scan (Library Tools → Jobs). */
  | 'scan'
  /** Generate previews (Library Tools → Jobs). */
  | 'generate'
  | 'open-whisparr';

export interface TimelineAction {
  kind: TimelineActionKind;
  label: string;
}

export interface TimelineStep {
  step: TimelineStepId;
  label: string;
  /** ISO time it happened, when known. */
  at: string | null;
  status: TimelineStepStatus;
  /** One short line: the release, the reason, the path. */
  detail: string | null;
  /** 0–100, while downloading. */
  progress: number | null;
  action: TimelineAction | null;
}

export interface SceneTimelineDto {
  /** The catalog scene's id. */
  stashId: string;
  route: TimelineRoute | null;
  /** "Where it is now", in one line. */
  now: string;
  steps: TimelineStep[];
  /** Sources that couldn't be asked, e.g. ["Whisparr"]; their steps say unknown. */
  unknown: string[];
  checkedAt: string;
}

export interface SceneTimelinesDto {
  items: SceneTimelineDto[];
}

/** At most this many scenes per batch (a page of Acquisition cards). */
export const TIMELINE_BATCH_LIMIT = 50;
