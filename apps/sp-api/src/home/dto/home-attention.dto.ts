/**
 * Counts for the "Needs you" card on Home. Each is null when its source
 * could not be reached, so Home hides that row instead of failing.
 */
export interface HomeAttentionDto {
  /** Found matches waiting for the user to accept or skip. */
  matchesToCheck: number | null;
  /** Downloads that failed. */
  failed: number | null;
  /** Downloads finished but not yet imported. */
  waitingForImport: number | null;
  /** Library scenes with no StashDB/FansDB link. */
  unmatched: number | null;
}
