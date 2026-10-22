import { DiscoverItem, SceneStatusState } from './discover.types';

export type AcquisitionLifecycleState = Exclude<SceneStatusState, 'NOT_REQUESTED' | 'AVAILABLE'>;
export type AcquisitionLifecycleFilter = 'ANY' | AcquisitionLifecycleState;

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
}

export interface AcquisitionSceneItem extends DiscoverItem {
  queueStatus: string | null;
  queueState: string | null;
  errorMessage: string | null;
  whisparrViewUrl: string | null;
}

export interface AcquisitionScenesResponse {
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  countsByLifecycle: AcquisitionCountsByLifecycle;
  items: AcquisitionSceneItem[];
}
