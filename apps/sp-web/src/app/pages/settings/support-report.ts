/** Where reports go when the build doesn't say which repository it came from. */
export const DEFAULT_REPOSITORY = 'mrnogood356/stashboard';
/** GitHub refuses very long links; the details are cut to fit well under that. */
const MAX_DETAILS = 5_000;

/**
 * Takes out what shouldn't go into a public bug report: web addresses
 * (their paths can hold webhook secrets), IP addresses, local host names,
 * and anything written as key=value or "Bearer …". What's left still says
 * what went wrong.
 */
export function redactForSharing(text: string): string {
  return (
    text
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, (url) => {
        const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)?.[0] ?? '';
        return `${scheme}[address]`;
      })
      // IPv4, with or without a port.
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[ip]')
      // IPv6 in brackets, as it appears with a port.
      .replace(/\[[0-9a-f:]*:[0-9a-f:]+\](?::\d+)?/gi, '[ip]')
      // Names only a home network knows.
      .replace(
        /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|home|internal|localdomain)\b(?::\d+)?/gi,
        '[host]',
      )
      .replace(
        /\b(api[_-]?key|apikey|token|password|passwd|secret|auth)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
        '$1$2[hidden]',
      )
      .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [hidden]')
  );
}

/** A new GitHub issue on the bug report form, with what Stashboard knows filled in. */
export function reportUrl(
  repository: string | null,
  version: string | null,
  details: string,
): string {
  const trimmed =
    details.length > MAX_DETAILS
      ? `${details.slice(0, MAX_DETAILS)}\n… (cut short; Copy for support has the rest)`
      : details;
  const params = new URLSearchParams({ template: 'bug_report.yml' });
  if (version) {
    params.set('version', version);
  }
  params.set('details', trimmed);
  return `https://github.com/${repository ?? DEFAULT_REPOSITORY}/issues/new?${params.toString()}`;
}
