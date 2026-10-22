import type { SabnzbdHistoryEntry } from '../providers/sabnzbd/sabnzbd.adapter';
import {
  MANUAL_FIRST_RUN_WINDOW_MS,
  manualCutoff,
  manualSkipReason,
} from './download-handoff.adopt';

describe('downloads added in SABnzbd by hand: which are picked up', () => {
  const cutoff = new Date('2026-10-22T10:00:00Z');
  const entry = (
    overrides: Partial<SabnzbdHistoryEntry> = {},
  ): SabnzbdHistoryEntry => ({
    nzoId: 'SABnzbd_nzo_manual',
    name: 'Manual.Release',
    category: 'stashboard',
    status: 'Completed',
    storage: '/downloads/complete/stashboard-downloads/Manual.Release',
    failMessage: null,
    completedAt: new Date('2026-10-22T11:00:00Z'),
    ...overrides,
  });
  const reason = (
    overrides: Partial<SabnzbdHistoryEntry> = {},
    tracked: string[] = [],
  ) =>
    manualSkipReason(entry(overrides), {
      category: 'stashboard',
      cutoff,
      tracked: new Set(tracked),
    });

  it('picks up a completed job in the category, finished after the cutoff', () => {
    expect(reason()).toBeNull();
    // SABnzbd's category names aren't case-sensitive; no category at all is
    // fine too, since SABnzbd was asked for this category only.
    expect(reason({ category: 'StashBoard' })).toBeNull();
    expect(reason({ category: null })).toBeNull();
    // Finished exactly at the cutoff counts.
    expect(reason({ completedAt: cutoff })).toBeNull();
  });

  it('leaves failed jobs and ones SABnzbd is still working on', () => {
    expect(reason({ status: 'Failed' })).toBe('not-completed');
    for (const status of [
      'Extracting',
      'Verifying',
      'Repairing',
      'Moving',
      'Running',
      'Queued',
    ]) {
      expect(reason({ status })).toBe('not-completed');
    }
  });

  it('leaves jobs in other categories', () => {
    expect(reason({ category: 'xxx' })).toBe('other-category');
  });

  it('leaves jobs finished before the cutoff, or without a finish time', () => {
    expect(reason({ completedAt: new Date(cutoff.getTime() - 1) })).toBe(
      'before-cutoff',
    );
    expect(reason({ completedAt: null })).toBe('no-completed-time');
    expect(reason({ completedAt: undefined })).toBe('no-completed-time');
  });

  it('leaves jobs SABnzbd doesn’t say the folder of', () => {
    expect(reason({ storage: null })).toBe('no-storage');
  });

  it('never picks up a job already followed (sent by Stashboard or picked up before)', () => {
    expect(reason({}, ['SABnzbd_nzo_manual'])).toBe('tracked');
  });

  it('starts from the stored cutoff, or the last day before there is one', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(manualCutoff({ sabManualSince: cutoff }, now)).toEqual(cutoff);
    expect(manualCutoff({ sabManualSince: null }, now)).toEqual(
      new Date(now - MANUAL_FIRST_RUN_WINDOW_MS),
    );
  });
});
