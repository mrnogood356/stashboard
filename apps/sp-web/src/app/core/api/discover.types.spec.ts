import { describe, expect, it } from 'vitest';
import { isSceneStatusRequestable } from './discover.types';

describe('isSceneStatusRequestable', () => {
  it('returns true only for NOT_REQUESTED scenes', () => {
    expect(isSceneStatusRequestable({ state: 'NOT_REQUESTED' })).toBe(true);
    expect(isSceneStatusRequestable({ state: 'FAILED' })).toBe(false);
  });

  it('returns false for non-actionable lifecycle states', () => {
    expect(isSceneStatusRequestable({ state: 'REQUESTED' })).toBe(false);
    expect(isSceneStatusRequestable({ state: 'DOWNLOADING' })).toBe(false);
    expect(isSceneStatusRequestable({ state: 'IMPORT_PENDING' })).toBe(false);
    expect(isSceneStatusRequestable({ state: 'AVAILABLE' })).toBe(false);
  });
});
