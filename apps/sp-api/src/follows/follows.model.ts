import { type SceneStatusDto } from '../scene-status/dto/scene-status.dto';
import { type CatalogProviderKey } from '../providers/catalog/catalog-provider.util';

export const FOLLOW_KINDS = ['PERFORMER', 'STUDIO'] as const;
export type FollowKindValue = (typeof FOLLOW_KINDS)[number];

export const FOLLOWED_SCENE_STATES = [
  'NEW',
  'REQUESTED',
  'DISMISSED',
  'FAILED',
] as const;
export type FollowedSceneStateValue = (typeof FOLLOWED_SCENE_STATES)[number];

/** How far back a follow can reach: older scenes are a bulk request, not news. */
export const MAX_SINCE_DAYS = 365;

export interface FollowDto {
  id: string;
  kind: FollowKindValue;
  provider: string;
  entityId: string;
  name: string;
  imageUrl: string | null;
  /** Only scenes released on or after this day (YYYY-MM-DD). */
  since: string;
  autoRequest: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Its scenes waiting for review. */
  newCount: number;
  createdAt: string;
}

export interface FollowsDto {
  follows: FollowDto[];
  /** True while a check is running. */
  checking: boolean;
  /** The main catalog: the only one follows are checked on. */
  provider: CatalogProviderKey | null;
}

export interface FollowLookupDto {
  follow: FollowDto | null;
  /** False on a secondary catalog's page: only the main one is followed. */
  followable: boolean;
}

/** A scene found for one or more follows, as a scene card plus why it's here. */
export interface FollowedReleaseDto {
  id: string;
  title: string;
  description: null;
  imageUrl: string | null;
  cardImageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  studioImageUrl: null;
  releaseDate: string | null;
  duration: number | null;
  type: 'SCENE';
  source: CatalogProviderKey;
  status: SceneStatusDto;
  requestable: boolean;
  localSceneId: null;
  followed: {
    state: FollowedSceneStateValue;
    /** Why an automatic request failed. */
    detail: string | null;
    foundAt: string;
    follows: Array<{
      id: string;
      kind: FollowKindValue;
      entityId: string;
      name: string;
    }>;
  };
}

export interface FollowedReleasesDto {
  items: FollowedReleaseDto[];
  /** Scenes waiting for review, across every follow. */
  reviewCount: number;
}

export interface FollowCheckSummary {
  checked: number;
  found: number;
  requested: number;
  failed: number;
  /** Follows that couldn't be checked. */
  errors: number;
}

/** A catalog scene as the performer and studio feeds give it. */
export interface CandidateScene {
  id: string;
  title: string;
  cardImageUrl: string | null;
  imageUrl: string | null;
  studioId: string | null;
  studio: string | null;
  releaseDate: string | null;
  duration: number | null;
  status: SceneStatusDto;
}

/** YYYY-MM-DD for a date, in UTC like the catalog's dates. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The day a follow starts from: as asked when it's a real day within the
 * last year, otherwise clamped to that year, or today when not given.
 */
export function clampSince(
  value: string | null | undefined,
  now: Date,
): string {
  const today = isoDay(now);
  const earliest = isoDay(
    new Date(now.getTime() - MAX_SINCE_DAYS * 86_400_000),
  );
  const day = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
    return today;
  }
  if (day < earliest) {
    return earliest;
  }
  return day > today ? today : day;
}

/**
 * From one page of a feed sorted newest first: the scenes that are new for a
 * follow (released since its day, not seen before, not already requested or
 * in the library), and whether older pages could still hold any.
 */
export function pickNewScenes(
  scenes: readonly CandidateScene[],
  since: string,
  known: ReadonlySet<string>,
): { fresh: CandidateScene[]; reachedSince: boolean } {
  const fresh: CandidateScene[] = [];
  let reachedSince = false;
  for (const scene of scenes) {
    const day = scene.releaseDate?.slice(0, 10) ?? null;
    if (day !== null && day < since) {
      reachedSince = true;
      continue;
    }
    // Undated scenes can't be placed, so they're never "new".
    if (day === null || known.has(scene.id)) {
      continue;
    }
    if (scene.status.state !== 'NOT_REQUESTED') {
      continue;
    }
    fresh.push(scene);
  }
  return { fresh, reachedSince };
}

/** "Found 3 new scenes; requested 2." for Schedules and the log. */
export function describeCheck(summary: FollowCheckSummary): string {
  if (summary.checked === 0) {
    return summary.errors > 0
      ? `Couldn’t check ${plural(summary.errors, 'follow')}.`
      : 'Not following anyone yet.';
  }
  const parts = [
    summary.found === 0
      ? 'No new scenes'
      : `Found ${plural(summary.found, 'new scene')}`,
  ];
  if (summary.requested > 0) {
    parts.push(`requested ${summary.requested}`);
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} couldn’t be requested`);
  }
  if (summary.errors > 0) {
    parts.push(`${plural(summary.errors, 'follow')} couldn’t be checked`);
  }
  return `${parts.join('; ')}.`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
