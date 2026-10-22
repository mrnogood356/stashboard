/** What an entry is about; the web page picks an icon and a filter for each. */
export const ACTIVITY_KINDS = [
  'rename',
  'undo',
  'move',
  'cleanup',
  'delete',
  'match',
  'scan',
  'whisparr',
  'request',
  'download',
  'automation',
  'setting',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityStatus = 'done' | 'failed' | 'partial';

/** How to undo an entry, e.g. { type: 'rename-batch', batchId }. */
export interface ActivityUndo {
  type: string;
  [key: string]: unknown;
}

export interface NewActivity {
  kind: ActivityKind;
  /** A short sentence: what happened. */
  title: string;
  /** More about it, shown when the entry is opened. */
  detail?: string | null;
  status?: ActivityStatus;
  count?: number | null;
  /** Only where a real undo exists. */
  undo?: ActivityUndo | null;
}

export interface ActivityEntryDto {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string | null;
  status: ActivityStatus;
  count: number | null;
  canUndo: boolean;
  undoneAt: string | null;
}

export interface ActivityPageDto {
  items: ActivityEntryDto[];
  page: number;
  hasMore: boolean;
}

/** Runs an undo. Throws (with a plain-English message) when it can't. */
export type ActivityUndoHandler = (undo: ActivityUndo) => Promise<unknown>;

/** Keep about this many entries; older ones are removed. */
export const MAX_ACTIVITY_ENTRIES = 2000;
export const ACTIVITY_PAGE_SIZE = 30;
export const MAX_TITLE_LENGTH = 160;
export const MAX_DETAIL_LENGTH = 4000;
