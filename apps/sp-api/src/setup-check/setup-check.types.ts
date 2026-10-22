export type SetupCheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type SetupFixAction =
  | 'whisparr-webhook'
  | 'whisparr-hardlinks'
  | 'whisparr-rename'
  | 'use-whisparr-naming';

export const SETUP_FIX_ACTIONS: readonly SetupFixAction[] = [
  'whisparr-webhook',
  'whisparr-hardlinks',
  'whisparr-rename',
  'use-whisparr-naming',
];

export interface SetupCheck {
  id: string;
  title: string;
  status: SetupCheckStatus;
  /** One sentence. */
  summary: string;
  /** More about it, and how to fix it by hand. */
  detail?: string;
  /** Something Stashboard can change for you. */
  fix?: { label: string; action: SetupFixAction };
  /** Where in Stashboard to change it yourself. */
  link?: { label: string; route: string };
}

export interface SetupCheckResponse {
  checkedAt: string;
  checks: SetupCheck[];
}

export interface SetupFixResult {
  ok: true;
  message: string;
}
