import { describe, expect, it } from 'vitest';
import { timeLeftText } from './stage-track';

describe('timeLeftText', () => {
  it('reads hh:mm:ss, Whisparr’s d.hh:mm:ss and SABnzbd’s d:hh:mm:ss', () => {
    expect(timeLeftText('00:08:20')).toBe('8 min left');
    expect(timeLeftText('01:12:40')).toBe('1 h 12 min left');
    expect(timeLeftText('00:00:40')).toBe('Under a minute left');
    expect(timeLeftText('2.03:00:00')).toBe('2 days left');
    expect(timeLeftText('1:02:30:00')).toBe('1 day left');
  });

  it('gives nothing for a value it can’t read', () => {
    expect(timeLeftText(null)).toBeNull();
    expect(timeLeftText('soon')).toBeNull();
  });
});
