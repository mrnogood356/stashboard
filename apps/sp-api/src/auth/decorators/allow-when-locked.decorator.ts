import { SetMetadata } from '@nestjs/common';

/** Routes that keep working while App Lock is engaged (status, unlock, lock). */
export const ALLOW_WHEN_LOCKED = 'allowWhenLocked';
export const AllowWhenLocked = () => SetMetadata(ALLOW_WHEN_LOCKED, true);
