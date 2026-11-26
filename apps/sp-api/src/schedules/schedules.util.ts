export const SCHEDULED_JOBS = [
  'organizer-match',
  'send-missing',
  'stash-scan',
  'stash-generate',
  'stash-clean',
  'follow-check',
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
  'follow-check': {
    label: 'Check who you follow',
    detail:
      'Looks for new scenes from the performers and studios you follow. Those set to want new scenes on their own add them to Whisparr.',
    defaults: { enabled: true, hour: 6, minute: 15, days: [] },
  },
};

/**
 * How long after its time a job still runs when it couldn't at that minute:
 * the once-a-minute check slipped past it, another job was still running,
 * or the server was restarting.
 */
export const CATCH_UP_MS = 60 * 60_000;

/**
 * Due when its latest time (today's, or yesterday's just after midnight)
 * has passed within the last hour, on one of its days, and it hasn't run
 * since. A time saved after that moment waits for its next one, so moving a
 * job to a minute ago doesn't start it.
 */
export function isDue(
  schedule: ScheduleTime,
  now: Date,
  lastRunAt: Date | null,
  savedAt: Date | null = null,
): boolean {
  const at = latestTime(schedule, now);
  if (!at || now.getTime() - at.getTime() >= CATCH_UP_MS) {
    return false;
  }
  if (savedAt && savedAt.getTime() > at.getTime()) {
    return false;
  }
  return !lastRunAt || lastRunAt.getTime() < at.getTime();
}

/** Its most recent time at or before now, today or yesterday. */
function latestTime(schedule: ScheduleTime, now: Date): Date | null {
  for (let offset = 0; offset <= 1; offset += 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - offset);
    day.setHours(schedule.hour, schedule.minute, 0, 0);
    if (day.getTime() > now.getTime()) {
      continue;
    }
    if (schedule.days.length === 0 || schedule.days.includes(day.getDay())) {
      return day;
    }
  }
  return null;
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
