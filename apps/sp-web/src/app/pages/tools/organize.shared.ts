import { MatchConfidence, RenameState, SceneMatches } from '../../core/api/organizer.service';

export type OrganizeTab = 'overview' | 'review' | 'settings';

/** Rows on the Overview that open to show their details. */
export type OrganizeDetail = 'repair' | 'relocate' | 'rename' | 'skipped' | 'empty';

export const CONFIDENCE: Record<MatchConfidence, string> = {
  exact: 'Same video',
  strong: 'Very likely',
  likely: 'Possible',
  weak: 'Unlikely',
};

export const SKIP_REASON: Record<RenameState, string> = {
  ready: '',
  same: 'Already tidy',
  missing: 'No title yet',
  whisparr: 'Whisparr’s file',
  outside: 'Outside your library folders',
  'no-file': 'No file',
  gone: 'File moved outside Stash',
  taken: 'New name already taken',
  copy: 'Extra copy',
};

export const TOKEN_HELP: Record<string, string> = {
  title: 'Title',
  studio: 'Studio',
  date: 'Date (2024-05-31)',
  year: 'Year',
  performers: 'Performers',
  code: 'Studio code',
  resolution: 'Resolution (1080p)',
  stashdb: 'StashDB id',
  studioslug: 'Studio, no spaces (BrightStudio), like Whisparr',
  quality: 'Source and resolution (WEBDL-1080p), like Whisparr',
  group: 'Release group from the file name (GRP)',
};

/** How long to wait after the last key before working out names for the new pattern. */
export const PREVIEW_DELAY_MS = 600;

export interface MatchState {
  loading: boolean;
  result: SceneMatches | null;
  error: string | null;
  query: string;
  applying: string | null;
}
