import type { CatalogProviderKey } from '../providers/catalog/catalog-provider.util';

export const HANDOFF_SETTINGS_KEY = 'GLOBAL';
export const DEFAULT_HANDOFF_CATEGORY = 'stashboard';

export const HANDOFF_STATUSES = [
  /** SABnzbd took it. */
  'sent',
  /** SABnzbd is downloading or unpacking it. */
  'downloading',
  /** Moved into the library; Stash still has to pick it up and link it. */
  'completed',
  /** In the library and linked to its scene. */
  'imported',
  'failed',
  /** Stopped watching it (you said so, or SABnzbd forgot it). */
  'ignored',
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** Still being watched. */
export const OPEN_HANDOFF_STATUSES: HandoffStatus[] = [
  'sent',
  'downloading',
  'completed',
];

export type HandoffImportMode = 'move' | 'copy';

/**
 * Where a followed download came from: sent by Find downloads, or added in
 * SABnzbd by hand under Stashboard's category and picked up once finished.
 */
export const HANDOFF_SOURCES = ['stashboard', 'sabnzbd-manual'] as const;
export type HandoffSource = (typeof HANDOFF_SOURCES)[number];
export const MANUAL_HANDOFF_SOURCE: HandoffSource = 'sabnzbd-manual';

export interface DownloadHandoffSettingsDto {
  enabled: boolean;
  category: string;
  destination: string | null;
  sabPathFrom: string | null;
  sabPathTo: string | null;
  importMode: HandoffImportMode;
  /** Also bring in videos put straight into the category's folder. */
  dropIns: boolean;
  /**
   * Also bring in downloads added to the category in SABnzbd by hand, once
   * SABnzbd has finished them.
   */
  sabManualJobs: boolean;
  /**
   * Only those SABnzbd finished at or after this are brought in; null until
   * the option first runs.
   */
  sabManualSince: string | null;
  /**
   * The category's folder as Stashboard sees it (SABnzbd's setting, through
   * the folder mapping); null when SABnzbd can't be asked or doesn't say.
   */
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
  importMode?: HandoffImportMode;
  dropIns?: boolean;
  sabManualJobs?: boolean;
}

export const DROP_IN_STATUSES = [
  /** Moved (or copied) into the destination; Stash still has to pick it up. */
  'placed',
  /** In the library, identified as far as it could be. */
  'imported',
  'failed',
] as const;
export type DropInStatus = (typeof DROP_IN_STATUSES)[number];

/** A video put straight into SABnzbd's category folder and brought in. */
export interface DownloadDropInDto {
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

/** Whether the drop-in folder is being watched. */
export type DropInWatchState = 'off' | 'watching' | 'problem';

/** Why the drop-in folder isn't being watched, or can't be. */
export type DropInWatchReason =
  /** Not looked at yet since Stashboard started. */
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

/** Why a file in the drop-in folder was left alone. */
export type DropInSkippedReason =
  | 'sab-job'
  | 'sab-working'
  | 'sample'
  | 'not-video'
  | 'hidden'
  | 'link'
  | 'too-deep'
  | 'brought-in'
  | 'failed-before';

/** A file seen in the drop-in folder, waiting until it stops changing. */
export interface DropInSettlingDto {
  path: string;
  name: string;
  /** Bytes when last looked at; null before the first look. */
  size: number | null;
  firstSeenAt: string;
  /** Since when it hasn't changed; null before the first look. */
  unchangedSince: string | null;
}

/** Something in the drop-in folder that was left alone, and why. */
export interface DropInSkippedDto {
  path: string;
  name: string;
  reason: DropInSkippedReason;
  /** The reason in plain words. */
  detail: string;
}

/** What the drop-in watcher is doing, as of its last check. */
export interface DropInWatchStatusDto {
  state: DropInWatchState;
  /** Null while watching. */
  reason: DropInWatchReason | null;
  /** What's wrong (or off) in plain words; null while watching. */
  message: string | null;
  /** What to check to fix it. */
  hint: string | null;
  category: string;
  /** The folder being watched, as Stashboard sees it. */
  folder: string | null;
  /** The same folder as SABnzbd calls it. */
  sabFolder: string | null;
  /** A check is running right now. */
  checking: boolean;
  lastCheckAt: string | null;
  /** What the last check found, in plain words. */
  lastResult: string | null;
  nextCheckAt: string | null;
  /** How long a file has to stay unchanged before it's brought in. */
  settleSeconds: number;
  settling: DropInSettlingDto[];
  skipped: DropInSkippedDto[];
  lastError: { message: string; at: string } | null;
}

/** Where a download sent to SABnzbd is, from queued to in the library. */
export type HandoffStage =
  | 'queued'
  | 'downloading'
  | 'unpacking'
  | 'moving'
  | 'linking'
  | 'done'
  | 'failed'
  | 'ignored';

/** The catalog scene a download was sent for, when Stashboard knows it. */
export interface HandoffSceneDto {
  title: string;
  imageUrl: string | null;
  studio: string | null;
}

export interface ProcessingHandoffDto extends DownloadHandoffDto {
  stage: HandoffStage;
  /** Title, picture and studio of the scene it's for; null when unknown. */
  scene: HandoffSceneDto | null;
  /** How much SABnzbd has downloaded, 0–100; null when it doesn't say. */
  progress: number | null;
  /** Time left as SABnzbd shows it, e.g. "0:12:30". */
  timeLeft: string | null;
  /** What's happening (or went wrong) in plain words. */
  detail: string | null;
  canRetry: boolean;
  canIgnore: boolean;
}

export interface ProcessingDropInDto extends DownloadDropInDto {
  name: string;
  canRetry: boolean;
}

/** Everything moving through Stashboard's download pipeline, in one place. */
export interface ProcessingDto {
  handoff: {
    enabled: boolean;
    sabnzbdReady: boolean;
    category: string;
    /** SABnzbd's queue couldn't be read just now, so progress is missing. */
    sabnzbdUnreachable: boolean;
  };
  /** Sent to SABnzbd and not in the library yet. */
  handoffs: ProcessingHandoffDto[];
  /** Finished, failed or no longer watched, newest first. */
  recentHandoffs: ProcessingHandoffDto[];
  dropIns: {
    watch: DropInWatchStatusDto;
    /** Moved in; Stash still has to pick them up. */
    active: ProcessingDropInDto[];
    /** Brought in or failed, newest first. */
    recent: ProcessingDropInDto[];
  };
  /** Downloads in flight, files settling and drop-ins waiting for Stash. */
  activeCount: number;
  /** Failures in the last day, plus a drop-in watcher that can't watch. */
  problemCount: number;
}

export interface DownloadHandoffDto {
  id: string;
  source: HandoffSource;
  /** The catalog scene it was sent for; null when added in SABnzbd. */
  sceneId: string | null;
  provider: CatalogProviderKey | null;
  releaseTitle: string;
  status: HandoffStatus;
  /** Why it failed, or what it's waiting for. */
  error: string | null;
  finalPath: string | null;
  stashSceneId: string | null;
  createdAt: string;
  updatedAt: string;
}
