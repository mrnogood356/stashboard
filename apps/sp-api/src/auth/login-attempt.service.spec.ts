import { HttpException, HttpStatus } from '@nestjs/common';
import { LoginAttemptService } from './login-attempt.service';

describe('LoginAttemptService', () => {
  let service: LoginAttemptService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    service = new LoginAttemptService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const fail = (times: number, key = 'k') => {
    for (let i = 0; i < times; i += 1) {
      service.recordFailure(key);
    }
  };
  const blockedMessage = (key = 'k'): string | null => {
    try {
      service.assertAllowed(key);
      return null;
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      return (error as HttpException).message;
    }
  };

  it('allows four wrong tries, then blocks for a minute', () => {
    fail(4);
    expect(blockedMessage()).toBeNull();
    fail(1);
    expect(blockedMessage()).toBe(
      'Too many wrong tries. Wait a minute and try again.',
    );
    jest.advanceTimersByTime(60_000);
    expect(blockedMessage()).toBeNull();
  });

  it('doubles the block each time, up to an hour', () => {
    const blockLengths: number[] = [];
    for (let round = 0; round < 8; round += 1) {
      fail(5);
      let waited = 0;
      while (blockedMessage() !== null) {
        jest.advanceTimersByTime(60_000);
        waited += 1;
      }
      blockLengths.push(waited);
    }
    expect(blockLengths).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('says how long the wait is', () => {
    fail(5);
    jest.advanceTimersByTime(60_000);
    fail(5);
    expect(blockedMessage()).toBe(
      'Too many wrong tries. Wait 2 minutes and try again.',
    );
  });

  it('counts wrong tries since the last success, across blocks', () => {
    fail(5);
    jest.advanceTimersByTime(60_000);
    expect(service.recordFailure('k')).toBe(6);
    service.clear('k');
    expect(service.recordFailure('k')).toBe(1);
  });

  it('reserves a try on every key at once, and none while one is blocked', () => {
    expect(service.reserve(['a', 'b'])).toEqual([1, 1]);
    fail(4, 'b');
    expect(blockedMessage('b')).not.toBeNull();
    expect(() => service.reserve(['a', 'b'])).toThrow(HttpException);
    // 'a' was not counted by the refused reservation.
    expect(service.recordFailure('a')).toBe(2);
  });

  it('gives a reserved try back when the check itself failed', async () => {
    fail(4);
    await expect(
      service.withReserved(['k'], () => Promise.reject(new Error('db down'))),
    ).rejects.toThrow('db down');
    expect(blockedMessage()).toBeNull();
    expect(service.recordFailure('k')).toBe(5);
    expect(blockedMessage()).not.toBeNull();
  });

  it('keeps a reserved try counted for a wrong guess', async () => {
    fail(4);
    await expect(
      service.withReserved(['k'], () =>
        Promise.reject(new HttpException('Wrong.', HttpStatus.FORBIDDEN)),
      ),
    ).rejects.toThrow('Wrong.');
    expect(blockedMessage()).not.toBeNull();
  });

  it('keeps keys apart', () => {
    fail(5, 'a');
    expect(blockedMessage('a')).not.toBeNull();
    expect(blockedMessage('b')).toBeNull();
  });

  it('forgets a key after a quiet day, so old typos never add up', () => {
    fail(5);
    jest.advanceTimersByTime(60_000);
    fail(4);
    jest.advanceTimersByTime(24 * 60 * 60_000 + 1);
    expect(service.recordFailure('k')).toBe(1);
    fail(4);
    // A fresh start: the next block is a minute again, not two.
    expect(blockedMessage()).toBe(
      'Too many wrong tries. Wait a minute and try again.',
    );
  });

  it('drops forgotten keys from memory', () => {
    for (let i = 0; i < 100; i += 1) {
      service.recordFailure(`old-${i}`);
    }
    jest.advanceTimersByTime(24 * 60 * 60_000 + 1);
    service.recordFailure('new');
    const attempts = (service as unknown as { attempts: Map<string, unknown> })
      .attempts;
    expect([...attempts.keys()]).toEqual(['new']);
  });
});
