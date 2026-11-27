import { SetMetadata } from '@nestjs/common';

/** Routes that keep working while App Lock is engaged (status, unlock, lock). */
export const ALLOW_WHEN_LOCKED = 'allowWhenLocked';
export const AllowWhenLocked = () => SetMetadata(ALLOW_WHEN_LOCKED, true);

/**
 * Routes a phone sends as it leaves the app (saving where a video got to),
 * allowed for a few seconds after it locks: with "Lock immediately" the lock
 * goes out first, and would otherwise refuse the save.
 */
export const ALLOW_JUST_AFTER_LOCK = 'allowJustAfterLock';
export const AllowJustAfterLock = () =>
  SetMetadata(ALLOW_JUST_AFTER_LOCK, true);
