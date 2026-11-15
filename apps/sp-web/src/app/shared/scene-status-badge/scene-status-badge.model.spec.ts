import { describe, expect, it } from 'vitest';
import {
  sceneStatusBadgeLabel,
  sceneStatusBadgeModifier,
  sceneStatusIconClass,
  sceneStatusIconVisible,
} from './scene-status-badge.model';

describe('scene-status-badge.model', () => {
  it('maps FAILED to an actionable badge treatment', () => {
    const failedStatus = { state: 'FAILED' as const };

    expect(sceneStatusBadgeLabel(failedStatus)).toBe('Failed');
    expect(sceneStatusBadgeModifier(failedStatus)).toBe('failed');
    expect(sceneStatusIconClass(failedStatus)).toBe('pi pi-exclamation-circle');
    expect(sceneStatusIconVisible(failedStatus)).toBe(true);
  });
});

describe('sceneStatusShortLabel', () => {
  it('shortens only what doesn’t fit beside a card’s date', async () => {
    const { sceneStatusShortLabel } = await import('./scene-status-badge.model');
    expect(sceneStatusShortLabel({ state: 'IMPORT_PENDING' })).toBe('Importing');
    expect(sceneStatusShortLabel({ state: 'AVAILABLE' })).toBe('In library');
  });
});
