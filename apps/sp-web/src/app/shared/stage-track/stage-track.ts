import { SceneStatusState } from '../../core/api/discover.types';

/** One step of a request's way into the library. */
export interface Stage {
  label: string;
  state: 'done' | 'current' | 'failed' | 'todo';
}

export const STAGE_LABELS = [
  'Requested',
  'Downloading',
  'Waiting for Stash',
  'In library',
] as const;

/**
 * The four steps with where it is now. `at` is the step it's on (0–3);
 * `failed` marks that step red; `finished` ticks them all.
 */
export function buildStages(
  at: number,
  options: { failed?: boolean; finished?: boolean } = {},
): Stage[] {
  return STAGE_LABELS.map((label, index) => ({
    label,
    state:
      index < at || (options.finished && index <= at)
        ? 'done'
        : index === at
          ? options.failed
            ? 'failed'
            : 'current'
          : 'todo',
  }));
}

/**
 * Where a request is from its status. A failed import is shown at
 * Waiting for Stash; any other failure at Downloading.
 */
export function stagesForStatus(state: SceneStatusState, queueState?: string | null): Stage[] {
  switch (state) {
    case 'REQUESTED':
      return buildStages(0);
    case 'DOWNLOADING':
      return buildStages(1);
    case 'IMPORT_PENDING':
      return buildStages(2);
    case 'AVAILABLE':
      return buildStages(3, { finished: true });
    case 'FAILED':
      return buildStages(/^import\s*(blocked|failed)$/i.test(queueState?.trim() ?? '') ? 2 : 1, {
        failed: true,
      });
    case 'NOT_REQUESTED':
    default:
      return buildStages(-1);
  }
}

/** "Step 2 of 4 · Downloading", for where the step names don't fit. */
export function stageNowText(stages: Stage[]): string {
  const index = stages.findIndex((stage) => stage.state === 'current' || stage.state === 'failed');
  if (index === -1) {
    return stages.every((stage) => stage.state === 'done') ? 'In library' : 'Not requested';
  }
  const stage = stages[index];
  return `Step ${index + 1} of ${stages.length} · ${stage.label}${stage.state === 'failed' ? ' failed' : ''}`;
}

/** Whisparr's and SABnzbd's "hh:mm:ss" or "d.hh:mm:ss" as "6 min left". */
export function timeLeftText(value: string | null | undefined): string | null {
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(value?.trim() ?? '');
  if (!match) {
    return null;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (days > 0) {
    return `${days} ${days === 1 ? 'day' : 'days'} left`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours} h ${minutes} min left` : `${hours} h left`;
  }
  return minutes > 0 ? `${minutes} min left` : 'Under a minute left';
}
