import { describe, expect, it } from 'vitest';
import { failureReason } from './failure-reason';

describe('failureReason', () => {
  it.each([
    ['The download is stalled with no connections', 'stalled'],
    [
      'Aborted, cannot be completed - https://sabnzbd.org/not-complete (missing articles)',
      'broken',
    ],
    ['Unpacking failed, CRC error', 'broken'],
    ['Unpacking failed, archive requires a password', 'password'],
    ['Not enough free disk space at /downloads', 'space'],
    ['Access to the path /data/x.mp4 is denied.', 'permissions'],
    ['Not an upgrade for existing movie file(s)', 'already has'],
    ['No files found are eligible for import in /downloads/x', 'tell that the download'],
    ['Release was rejected: blocklisted', 'turned this release down'],
    ['Download client is unavailable: connection refused', 'download client'],
  ])('reads “%s”', (message, expected) => {
    expect(failureReason(message)?.reason.toLowerCase()).toContain(expected);
  });

  it('leaves messages it doesn’t know, and empty ones, alone', () => {
    expect(failureReason('Something new happened')).toBeNull();
    // A failed release reported by the client isn't an unreachable client.
    expect(failureReason('Download Client reported release download failure')).toBeNull();
    expect(failureReason('  ')).toBeNull();
    expect(failureReason(null)).toBeNull();
  });
});
