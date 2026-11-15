import type { MergeMatch } from './tag-cleanup.util';
import type {
  StashBackgroundProblemKind,
  StashProblemKind,
  StashProblemScene,
  StashQuickProblemKind,
} from '../providers/stash/stash.types';
import {
  type StashDuplicateScene,
  type StashMergeCandidate,
} from '../providers/stash/stash.adapter';
import type { FixKind, LocalBulkAction } from './dto/local-library.dto';

/** A library scene as a card (matches the web app's scene cards). */
export interface LocalSceneCardDto {
  id: string;
  title: string;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: string | null;
  releaseDate: string | null;
  duration: number | null;
  /** The main file's picture size, for its quality (4K, 1080p…). */
  width: number | null;
  height: number | null;
  playCount: number;
  /** How far through the scene playback got, 0 to 1. */
  progress: number | null;
  /** When it was last played. */
  lastPlayedAt?: string | null;
  type: 'SCENE';
  source: 'STASH';
}

export interface ChapterDto {
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

export interface MergeCandidatesDto {
  /** Entered more than once; keepId is the one with the most scenes. */
  groups: Array<{
    keepId: string;
    items: Array<StashMergeCandidate & { match: MergeMatch }>;
  }>;
  /** Names matching the search. */
  matches: StashMergeCandidate[];
}

export interface LocalScenePageDto {
  total: number;
  page: number;
  hasMore: boolean;
  items: LocalSceneCardDto[];
}

export interface LocalPerformerDto {
  id: string;
  name: string;
  disambiguation: string | null;
  gender: string | null;
  birthdate: string | null;
  deathDate?: string | null;
  country: string | null;
  details: string | null;
  favorite: boolean;
  imageUrl: string | null;
  sceneCount: number;
  /** Their StashDB/FansDB ids, for their catalog page. */
  catalogIds: string[];
}

export interface DuplicateSceneDto extends Omit<
  StashDuplicateScene,
  'screenshotVersion'
> {
  imageUrl: string | null;
}

export interface SampleSceneDto extends DuplicateSceneDto {
  /** Why it looks like a sample: its name says so, or it's very short. */
  reason: 'name' | 'short';
}

export const PROBLEM_KINDS: StashQuickProblemKind[] = [
  'no-file',
  'no-length',
  'unreadable',
];

/** Kinds checked file by file, in the background, in this order on the page. */
export const BACKGROUND_KINDS: StashBackgroundProblemKind[] = [
  'file-check',
  'generate',
];

/** What each background check counts, for the log and the page. */
export const BACKGROUND_LABEL: Record<
  StashBackgroundProblemKind,
  { what: string; unit: string; lacking: string }
> = {
  generate: {
    what: 'what Generate makes (covers, fingerprints, previews, thumbnails, chapter clips)',
    unit: 'scene(s)',
    lacking: 'are missing something Generate makes',
  },
  'file-check': {
    what: 'the files on disk against what Stash scanned',
    unit: 'scene(s)',
    lacking: 'have a file that is missing, damaged or changed',
  },
};

/** Checking every file takes a while: a result is kept this long. */
export const MARKER_CHECK_TTL_MS = 30 * 60_000;

export interface ProblemListDto {
  kind: StashProblemKind;
  count: number | null;
  scenes: StashProblemScene[];
  /** Still being checked (the chapter-clip check runs in the background). */
  checking?: boolean;
  /** Files Stash (or the disk) didn't answer for, so they're not counted either way. */
  unanswered?: number;
  /** The most common reason they weren't answered (timed out, an HTTP status, an error). */
  unansweredWhy?: string;
  /** Why the count is unknown, in plain words (the check failed, or Stash didn't answer). */
  note?: string;
}

export interface DuplicateGroupDto {
  scenes: DuplicateSceneDto[];
  /** The copy to keep: highest resolution, then picture for the codec, then length. */
  suggestedKeepId: string;
  /** Why that one, in plain words. */
  keepReason: string;
}

export interface FixCountsDto {
  unmatched: number;
  untagged: number;
  unorganized: number;
}

export const FIX_FILTERS: Record<FixKind, Record<string, unknown>> = {
  unmatched: { is_missing: 'stash_id' },
  untagged: { is_missing: 'tags' },
  unorganized: { organized: false },
};

export const DUPLICATE_DISTANCE = { exact: 0, high: 4, medium: 8 } as const;
/** Longer than this, "sample" in the path is a folder's name, not a sample clip. */
export const NAMED_SAMPLE_MAX_SECONDS = 10 * 60;

export interface LocalSearchDto {
  performers: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
    favorite: boolean;
    /** Their ids on StashDB/FansDB, to show them once next to catalog results. */
    catalogIds: string[];
  }>;
  studios: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
    sceneCount: number;
    catalogIds: string[];
  }>;
}

export interface LocalStudioDto {
  id: string;
  name: string;
  favorite: boolean;
  imageUrl: string | null;
  sceneCount: number;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
  /** Its StashDB/FansDB ids, for its catalog page. */
  catalogIds: string[];
}

export interface LocalBulkResultDto {
  action: LocalBulkAction;
  /** Scenes the action worked on. */
  done: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Your own Stash library, beyond playback: organizing a scene, related scenes,
 * and performer and studio pages. Everything is read from and saved to Stash.
 */
/** How long Library stats are kept before Stash is asked again. */
export const STATS_TTL_MS = 30 * 60_000;
