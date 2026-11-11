import { describe, expect, it } from 'vitest';
import { lengthLabel, qualityLabel } from './scene-specs';

describe('scene specs', () => {
  it('labels quality the way Stash does, by the short side', () => {
    expect(qualityLabel(3840, 2160)).toBe('4K');
    expect(qualityLabel(2560, 1440)).toBe('1440p');
    expect(qualityLabel(1920, 1080)).toBe('1080p');
    expect(qualityLabel(1080, 1920)).toBe('1080p');
    expect(qualityLabel(1280, 720)).toBe('720p');
    expect(qualityLabel(854, 480)).toBe('480p');
    expect(qualityLabel(7680, 4320)).toBe('8K');
    expect(qualityLabel(null, 1080)).toBeNull();
    expect(qualityLabel(100, 80)).toBeNull();
  });

  it('shows length as minutes and seconds, with hours past an hour', () => {
    expect(lengthLabel(2451)).toBe('40:51');
    expect(lengthLabel(3723)).toBe('1:02:03');
    expect(lengthLabel(59.6)).toBe('0:59');
    expect(lengthLabel(0)).toBeNull();
    expect(lengthLabel(null)).toBeNull();
  });
});
