import type { DownloadHandoffSettings } from '@prisma/client';
import type { SabnzbdHistoryEntry } from '../providers/sabnzbd/sabnzbd.adapter';

/**
 * On the first run after upgrading (the option is on by default), SABnzbd's
 * history is looked at only this far back, so it isn't swept as a whole.
 */
export const MANUAL_FIRST_RUN_WINDOW_MS = 24 * 3600_000;

/**
 * From when downloads added in SABnzbd by hand are brought in: the stored
 * cutoff (when the option was turned on), or, before there is one, 24 hours
 * before now.
 */
export function manualCutoff(
  settings: Pick<DownloadHandoffSettings, 'sabManualSince'>,
  now = Date.now(),
): Date {
  return settings.sabManualSince ?? new Date(now - MANUAL_FIRST_RUN_WINDOW_MS);
}

/** Why a SABnzbd history entry isn't picked up; null when it is. */
export type ManualSkip =
  | 'other-category'
  | 'not-completed'
  | 'no-storage'
  | 'no-completed-time'
  | 'before-cutoff'
  | 'tracked';

/**
 * Whether one SABnzbd history entry, not sent by Stashboard, is brought in:
 *
 * - it's in Stashboard's category (SABnzbd is asked for that category only,
 *   and the entry's own category is checked again);
 * - SABnzbd says "Completed": not failed, not still verifying, repairing or
 *   unpacking;
 * - SABnzbd says where it put it;
 * - SABnzbd finished it at or after the cutoff (see manualCutoff); one
 *   without a finish time is left alone;
 * - Stashboard doesn't already follow it (by SABnzbd's id), so nothing is
 *   ever brought in twice.
 */
export function manualSkipReason(
  entry: SabnzbdHistoryEntry,
  options: { category: string; cutoff: Date; tracked: ReadonlySet<string> },
): ManualSkip | null {
  if (options.tracked.has(entry.nzoId)) {
    return 'tracked';
  }
  if (
    entry.category &&
    entry.category.toLowerCase() !== options.category.toLowerCase()
  ) {
    return 'other-category';
  }
  if (entry.status.toLowerCase() !== 'completed') {
    return 'not-completed';
  }
  if (!entry.storage) {
    return 'no-storage';
  }
  if (!entry.completedAt) {
    return 'no-completed-time';
  }
  if (entry.completedAt.getTime() < options.cutoff.getTime()) {
    return 'before-cutoff';
  }
  return null;
}
