/** Where reports go when the build doesn't say which repository it came from. */
export const DEFAULT_REPOSITORY = 'mrnogood356/stashboard';
/** GitHub refuses very long links; the details are cut to keep the link under this. */
const MAX_LINK = 7_000;

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
      // Bare IPv6: hex groups around a "::", or all eight groups.
      .replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, (match) =>
        /::|(?:[0-9a-f]{1,4}:){7}/i.test(match) ? '[ip]' : match,
      )
      // Names only a home network knows.
      .replace(
        /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|home|internal|localdomain)\b(?::\d+)?/gi,
        '[host]',
      )
      // A container or host name with a port, like sabnzbd:8080.
      .replace(/\b[a-z][a-z0-9-]*:\d{2,5}\b/gi, '[host]')
      .replace(/\b(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9+/=._~-]+/g, '$1 [hidden]')
      // Any key, token, secret, password or auth field, quoted or not.
      .replace(
        /\b([\w-]*(?:api[_-]?key|apikey|token|password|passwd|secret|auth)[\w-]*)(["']?\s*[:=]\s*)(["']?)(?!Bearer\b|Basic\b|Digest\b|Token\b)[^\s"'&,;]+\3/gi,
        '$1$2$3[hidden]$3',
      )
  );
}

/** A new GitHub issue on the bug report form, with what Stashboard knows filled in. */
export function reportUrl(
  repository: string | null,
  version: string | null,
  details: string,
): string {
  const link = (text: string): string => {
    const params = new URLSearchParams({ template: 'bug_report.yml' });
    if (version) {
      params.set('version', version);
    }
    params.set('details', text);
    return `https://github.com/${repository ?? DEFAULT_REPOSITORY}/issues/new?${params.toString()}`;
  };
  // Measured once encoded: a character outside ASCII takes up to 9 in the link.
  let full = link(details);
  let keep = details.length;
  while (full.length > MAX_LINK && keep > 0) {
    keep = Math.floor(keep * 0.8);
    full = link(`${details.slice(0, keep)}\n… (cut short; Copy for support has the rest)`);
  }
  return full;
}
