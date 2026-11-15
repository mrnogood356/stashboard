import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsavedChangesGuard } from './unsaved-changes.guard';

const leave = (dirty: boolean) =>
  unsavedChangesGuard(
    { hasUnsavedChanges: () => dirty },
    null as never,
    null as never,
    null as never,
  );

describe('unsavedChangesGuard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets you leave a page with nothing unsaved, without asking', () => {
    const confirm = vi.spyOn(window, 'confirm');
    expect(leave(false)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before leaving unsaved edits, and stays when you say no', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(leave(true)).toBe(false);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(leave(true)).toBe(true);
  });
});
