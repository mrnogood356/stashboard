import { HandoffStage, MatchedBy } from '../../core/api/download-handoff.service';

const STAGE_LABELS: Record<HandoffStage, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  unpacking: 'Unpacking',
  moving: 'Moving',
  linking: 'Waiting for Stash',
  done: 'In your library',
  failed: 'Failed',
  ignored: 'Not watched',
};

export function stageLabel(stage: HandoffStage): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** "12 s ago", "3 min ago", "in 40 s"; null when there's no time. */
export function relativeTime(iso: string | null, now: number): string | null {
  if (!iso) {
    return null;
  }
  const at = Date.parse(iso);
  if (Number.isNaN(at)) {
    return null;
  }
  const seconds = Math.round((at - now) / 1000);
  const span = Math.abs(seconds);
  if (span < 5) {
    return 'just now';
  }
  const text =
    span < 60
      ? `${span} s`
      : span < 3600
        ? `${Math.round(span / 60)} min`
        : span < 86_400
          ? `${Math.round(span / 3600)} h`
          : `${Math.round(span / 86_400)} d`;
  return seconds > 0 ? `in ${text}` : `${text} ago`;
}

/** Bytes as "512 KB", "1.4 GB". */
export function fileSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes)) {
    return null;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** How a file you brought in was matched, in a few words. */
export interface MatchNote {
  label: string;
  /** Matched, or worth a look from you. */
  tone: 'good' | 'check';
}

const MATCH_NOTES: Record<MatchedBy, MatchNote> = {
  fingerprint: { label: 'Matched by its fingerprint', tone: 'good' },
  name: { label: 'Matched by its name', tone: 'good' },
  whisparr: { label: 'Matched from Whisparr', tone: 'good' },
  stash: { label: 'Matched', tone: 'good' },
  later: { label: 'Matched on a later look', tone: 'good' },
  proposed: { label: 'Check this match', tone: 'check' },
  none: { label: 'Not matched yet', tone: 'check' },
};

export function matchNote(matchedBy: MatchedBy | null | undefined): MatchNote | null {
  return matchedBy ? (MATCH_NOTES[matchedBy] ?? null) : null;
}
