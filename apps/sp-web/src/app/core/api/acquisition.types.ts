import { DiscoverItem, SceneStatusState } from './discover.types';

export type AcquisitionLifecycleState = Exclude<SceneStatusState, 'NOT_REQUESTED' | 'AVAILABLE'>;
/** AVAILABLE: requests that reached the library in the last two weeks. */
export type AcquisitionLifecycleFilter = 'ANY' | AcquisitionLifecycleState | 'AVAILABLE';

/** 'status' is the pipeline order (failed first); the rest are by date or title. */
export type AcquisitionSort =
  'status' | 'requested-desc' | 'requested-asc' | 'released-desc' | 'released-asc' | 'title';

export interface AcquisitionFeedOptions {
  /** Words in the title or studio. */
  q?: string;
  sort?: AcquisitionSort;
}

export interface AcquisitionCountsByLifecycle {
  REQUESTED: number;
  DOWNLOADING: number;
  IMPORT_PENDING: number;
  FAILED: number;
  /** Recently added (older APIs: missing). */
  AVAILABLE?: number;
}

export interface AcquisitionDownload {
  /** 0–100, or null when the download client doesn't say. */
  progress: number | null;
  /** "hh:mm:ss" (or "d.hh:mm:ss") left, when known. */
  timeLeft: string | null;
}

export interface AcquisitionSceneItem extends DiscoverItem {
  queueStatus: string | null;
  queueState: string | null;
  errorMessage: string | null;
  whisparrViewUrl: string | null;
  /** While downloading: how far along it is (older APIs: missing). */
  download?: AcquisitionDownload | null;
  /** Recently added: when Stash got it, and where to open it. */
  addedAt?: string | null;
  stashViewUrl?: string | null;
}

export interface AcquisitionScenesResponse {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  countsByLifecycle: AcquisitionCountsByLifecycle;
  items: AcquisitionSceneItem[];
}
