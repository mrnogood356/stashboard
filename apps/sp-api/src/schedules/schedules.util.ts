export const SCHEDULED_JOBS = [
  'organizer-match',
  'send-missing',
  'stash-scan',
  'stash-generate',
  'stash-clean',
] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export interface ScheduleTime {
  enabled: boolean;
  hour: number;
  minute: number;
  /** 0 is Sunday; empty is every day. */
  days: number[];
}

/**
 * What each job is and its starting schedule. The organizer's two keep the
 * times they always had; their on/off stays in the organizer's settings.
 */
export const JOB_INFO: Record<
  ScheduledJob,
  { label: string; detail: string; defaults: ScheduleTime; switchIn?: string }
> = {
  'organizer-match': {
    label: 'Match the backlog',
    detail: 'The organizer tries to match every unmatched scene to StashDB.',
    defaults: { enabled: false, hour: 4, minute: 0, days: [] },
    switchIn: 'Organizer → Settings → Every night',
  },
  'send-missing': {
    label: 'Send scenes Whisparr is missing',
    detail: 'Scenes you have that Whisparr shows as missing are handed to it.',
    defaults: { enabled: true, hour: 5, minute: 30, days: [] },
    switchIn: 'Organizer → Settings → Send matches to Whisparr',
  },
  'stash-scan': {
    label: 'Scan the library in Stash',
    detail: 'Stash looks for new, changed and moved files.',
    defaults: { enabled: false, hour: 3, minute: 0, days: [] },
  },
  'stash-generate': {
    label: 'Generate in Stash',
    detail:
      'Previews, sprites, covers and fingerprints for scenes that don’t have them.',
    defaults: { enabled: false, hour: 3, minute: 30, days: [] },
  },
  'stash-clean': {
    label: 'Clean in Stash',
    detail:
      'Removes scenes whose files Stash can’t find. If a drive isn’t mounted when it runs, its scenes are removed too, so leave this off unless every library folder is always there.',
    defaults: { enabled: false, hour: 2, minute: 30, days: [0] },
  },
};

/** Due at this minute, and not already run in it. */
export function isDue(
  schedule: ScheduleTime,
  now: Date,
  lastRunAt: Date | null,
): boolean {
  if (
    now.getHours() !== schedule.hour ||
    now.getMinutes() !== schedule.minute
  ) {
    return false;
  }
  if (schedule.days.length > 0 && !schedule.days.includes(now.getDay())) {
    return false;
  }
  return !lastRunAt || now.getTime() - lastRunAt.getTime() > 60_000;
}

/** The next time it runs, from now; null when it never will. */
export function nextRun(schedule: ScheduleTime, now: Date): Date | null {
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(now);
    day.setDate(now.getDate() + offset);
    day.setHours(schedule.hour, schedule.minute, 0, 0);
    if (day.getTime() <= now.getTime()) {
      continue;
    }
    if (schedule.days.length === 0 || schedule.days.includes(day.getDay())) {
      return day;
    }
  }
  return null;
}
