import { describe, expect, it } from 'vitest';
import { redactForSharing, reportUrl } from './support-report';

describe('redactForSharing', () => {
  it('takes out addresses, IPs, local names and secrets, and keeps the rest', () => {
    const text = [
      'Stash: FAIL – Not reachable. Error: connect ECONNREFUSED 192.168.1.20:9999',
      'Whisparr: request to http://whisparr:6969/api/v3/system/status?apikey=abc123 failed',
      'Webhook https://discord.com/api/webhooks/123/very-secret-token replied 404',
      'SABnzbd at nas.local:8080 timed out; token=tk_live_123 password: hunter2',
      'Authorization: Bearer eyJhbGciOi.secret',
      'IPv6 [fd00::1]:9999 refused',
      'connect ECONNREFUSED fd00::1 and 2001:db8:0:0:0:0:0:1 after sabnzbd:8080 timed out',
      'Authorization: Basic QWxhZGRpbjpPcGVuU2VzYW1l; authToken: "abc-token-9"',
      'X-Api-Key=keyvalue123 at 13:20:47',
      'Commit: 0123456789abcdef0123456789abcdef01234567',
    ].join('\n');

    const redacted = redactForSharing(text);

    for (const secret of [
      '192.168.1.20',
      'whisparr:6969',
      'abc123',
      'very-secret-token',
      'discord.com',
      'nas.local',
      'tk_live_123',
      'hunter2',
      'eyJhbGciOi',
      'fd00::1',
      '2001:db8',
      'sabnzbd:8080',
      'QWxhZGRpbjpPcGVuU2VzYW1l',
      'abc-token-9',
      'keyvalue123',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('connect ECONNREFUSED [ip]');
    expect(redacted).toContain('request to http://[address] failed');
    expect(redacted).toContain('Commit: 0123456789abcdef0123456789abcdef01234567');
    // Times aren't addresses.
    expect(redacted).toContain('at 13:20:47');
  });
});

describe('reportUrl', () => {
  it('opens the bug form with the version and details filled in', () => {
    const url = new URL(reportUrl('someone/stashboard', '1.3.0', 'Health\n- Stash: OK'));
    expect(url.origin + url.pathname).toBe('https://github.com/someone/stashboard/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe('1.3.0');
    expect(url.searchParams.get('details')).toBe('Health\n- Stash: OK');
  });

  it('uses the project’s repository for a local build, and keeps the link short', () => {
    const url = reportUrl(null, null, 'x'.repeat(20_000));
    expect(url).toContain('https://github.com/mrnogood356/stashboard/issues/new');
    expect(url.length).toBeLessThan(8_000);
    expect(new URL(url).searchParams.get('details')).toContain('cut short');

    // Characters outside ASCII grow when encoded; the link still fits.
    const wide = reportUrl(null, '1.4.0', 'é✓'.repeat(3_000));
    expect(wide.length).toBeLessThan(8_000);
    expect(new URL(wide).searchParams.get('details')).toContain('cut short');
  });
});
