import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

interface AttemptState {
  /** Failures since the last block (or since the start). */
  failures: number;
  /** Failures since the last success; never reset by a block running out. */
  total: number;
  /** Blocks so far; each one lasts twice as long as the one before. */
  blocks: number;
  blockedUntil: number | null;
  lastFailureAt: number;
}

/**
 * Throttles guessing (passwords, App Lock PINs) per key, e.g. per address or
 * per session. Every MAX_FAILURES wrong tries block the key, first for a
 * minute, then 2, 4, 8… up to an hour, so a typo costs little but guessing a
 * 4-digit PIN would take months. A success clears the key; a key with no
 * failures for a day is forgotten.
 */
@Injectable()
export class LoginAttemptService {
  private static readonly MAX_FAILURES = 5;
  private static readonly FIRST_BLOCK_MS = 60_000;
  private static readonly MAX_BLOCK_MS = 60 * 60_000;
  private static readonly FORGET_AFTER_MS = 24 * 60 * 60_000;
  private static readonly SWEEP_EVERY_MS = 10 * 60_000;

  private readonly attempts = new Map<string, AttemptState>();
  private lastSweepAt = 0;

  assertAllowed(key: string): void {
    const state = this.current(key);
    if (!state?.blockedUntil || state.blockedUntil <= Date.now()) {
      return;
    }

    const minutes = Math.ceil((state.blockedUntil - Date.now()) / 60_000);
    throw new HttpException(
      `Too many wrong tries. Wait ${minutes === 1 ? 'a minute' : `${minutes} minutes`} and try again.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Records a wrong try and returns how many there have been since the last success. */
  recordFailure(key: string): number {
    const now = Date.now();
    this.sweep(now);
    const state = this.current(key) ?? {
      failures: 0,
      total: 0,
      blocks: 0,
      blockedUntil: null,
      lastFailureAt: now,
    };
    if (state.blockedUntil !== null && state.blockedUntil <= now) {
      // The block ran out: a fresh round of tries, but the next block is longer.
      state.failures = 0;
      state.blockedUntil = null;
    }

    state.failures += 1;
    state.total += 1;
    state.lastFailureAt = now;
    if (state.failures >= LoginAttemptService.MAX_FAILURES) {
      const duration = Math.min(
        LoginAttemptService.FIRST_BLOCK_MS * 2 ** state.blocks,
        LoginAttemptService.MAX_BLOCK_MS,
      );
      state.blocks += 1;
      state.blockedUntil = now + duration;
    }
    this.attempts.set(key, state);
    return state.total;
  }

  /**
   * Checks every key and counts a try against each in one synchronous step,
   * before any async work starts, so parallel requests can't all slip past
   * the check while the first is still being verified. No key is counted
   * when any of them is blocked. Call clear() on success to drop the count.
   * Returns each key's tries since the last success, in order.
   */
  reserve(keys: readonly string[]): number[] {
    keys.forEach((key) => this.assertAllowed(key));
    return keys.map((key) => this.recordFailure(key));
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Gives back a try reserve() counted, for when the check itself failed (a
   * database or hashing error) rather than the guess: a server problem
   * shouldn't lock out the right password. A block that try just set is
   * lifted again.
   */
  release(keys: readonly string[]): void {
    for (const key of keys) {
      const state = this.current(key);
      if (!state || state.failures === 0) {
        continue;
      }
      if (
        state.blockedUntil !== null &&
        state.failures === LoginAttemptService.MAX_FAILURES
      ) {
        state.blockedUntil = null;
        state.blocks = Math.max(0, state.blocks - 1);
      }
      state.failures -= 1;
      state.total = Math.max(0, state.total - 1);
    }
  }

  /**
   * reserve(), then the check: a wrong guess (the check throws an
   * HttpException, as for a 401 or 403) stays counted; any other error is a
   * server problem and gives the try back. Clearing on success is up to the
   * check, since some answers (a session ended for too many PINs) clear too.
   */
  async withReserved<T>(
    keys: readonly string[],
    check: (tries: number[]) => Promise<T>,
  ): Promise<T> {
    const tries = this.reserve(keys);
    try {
      return await check(tries);
    } catch (error) {
      if (!(error instanceof HttpException)) {
        this.release(keys);
      }
      throw error;
    }
  }

  /** The key's state, or undefined once it has been quiet long enough to forget. */
  private current(key: string): AttemptState | undefined {
    const state = this.attempts.get(key);
    if (state && this.isStale(state, Date.now())) {
      this.attempts.delete(key);
      return undefined;
    }
    return state;
  }

  private isStale(state: AttemptState, now: number): boolean {
    const blocked = state.blockedUntil !== null && state.blockedUntil > now;
    return (
      !blocked &&
      now - state.lastFailureAt > LoginAttemptService.FORGET_AFTER_MS
    );
  }

  /** Drops forgotten keys now and then, so the map doesn't grow forever. */
  private sweep(now: number): void {
    if (now - this.lastSweepAt < LoginAttemptService.SWEEP_EVERY_MS) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, state] of this.attempts) {
      if (this.isStale(state, now)) {
        this.attempts.delete(key);
      }
    }
  }
}
