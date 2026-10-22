import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { LoginAttemptService } from '../auth/login-attempt.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppLockService } from './app-lock.service';

describe('AppLockService', () => {
  const appLockFindUnique = jest.fn();
  const appLockUpsert = jest.fn();
  const sessionFindUnique = jest.fn();
  const sessionUpdate = jest.fn();
  const sessionUpdateMany = jest.fn();
  const sessionDeleteMany = jest.fn();
  const userFindUnique = jest.fn();
  const passkeyFindMany = jest.fn();
  const prisma = {
    appLock: { findUnique: appLockFindUnique, upsert: appLockUpsert },
    adminSession: {
      findUnique: sessionFindUnique,
      update: sessionUpdate,
      updateMany: sessionUpdateMany,
      deleteMany: sessionDeleteMany,
    },
    adminUser: { findUnique: userFindUnique },
    appLockPasskey: { findMany: passkeyFindMany },
  } as unknown as PrismaService;
  let service: AppLockService;
  let pinHash: string;

  beforeAll(async () => {
    pinHash = await argon2.hash('2468', { type: argon2.argon2id });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    sessionUpdate.mockResolvedValue({});
    sessionUpdateMany.mockResolvedValue({ count: 1 });
    passkeyFindMany.mockResolvedValue([]);
    service = new AppLockService(prisma, new LoginAttemptService());
  });

  const enabled = (overrides: Record<string, unknown> = {}) =>
    appLockFindUnique.mockResolvedValue({
      userId: 'u1',
      enabled: true,
      pinHash,
      timeoutSeconds: 60,
      hideInSwitcher: true,
      ...overrides,
    });

  it('never locks when App Lock is off', async () => {
    appLockFindUnique.mockResolvedValue(null);
    await expect(service.assertUnlocked('u1', 's1')).resolves.toBeUndefined();
    expect(sessionFindUnique).not.toHaveBeenCalled();
  });

  it('refuses requests with 423 while the device is locked', async () => {
    enabled();
    sessionFindUnique.mockResolvedValue({
      lockedAt: new Date(),
      lastActiveAt: new Date(),
      phoneApp: true,
    });

    const error = await service
      .assertUnlocked('u1', 's1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.LOCKED);
    expect((error as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'APP_LOCKED' }),
    );
  });

  it('locks on the server after the idle timeout, even without the app saying so', async () => {
    enabled({ timeoutSeconds: 60 });
    sessionFindUnique.mockResolvedValue({
      lockedAt: null,
      lastActiveAt: new Date(Date.now() - 2 * 60_000),
      phoneApp: true,
    });

    await expect(service.assertUnlocked('u1', 's1')).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lockedAt: expect.any(Date) },
    });
  });

  it('allows for the app’s check-ins arriving a little late before calling it idle', async () => {
    enabled({ timeoutSeconds: 0 });
    sessionFindUnique.mockResolvedValue({
      lockedAt: null,
      lastActiveAt: new Date(Date.now() - 35_000),
      phoneApp: true,
    });

    await expect(service.assertUnlocked('u1', 's1')).resolves.toBeUndefined();
  });

  it('stays unlocked while active and records activity', async () => {
    enabled();
    sessionFindUnique.mockResolvedValue({
      lockedAt: null,
      lastActiveAt: new Date(Date.now() - 20_000),
      phoneApp: true,
    });

    await expect(service.assertUnlocked('u1', 's1')).resolves.toBeUndefined();
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lastActiveAt: expect.any(Date) },
    });
  });

  it('never locks a browser, only the app installed on a phone', async () => {
    enabled({ timeoutSeconds: 60 });
    sessionFindUnique.mockResolvedValue({
      lockedAt: new Date(),
      lastActiveAt: new Date(Date.now() - 2 * 60_000),
      phoneApp: false,
    });

    await expect(service.assertUnlocked('u1', 's1')).resolves.toBeUndefined();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('marks a session as the phone app once', async () => {
    await service.notePhoneApp('s9');
    await service.notePhoneApp('s9');

    expect(sessionUpdateMany).toHaveBeenCalledTimes(1);
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 's9', phoneApp: false },
      data: { phoneApp: true },
    });
  });

  it('unlocks with the right PIN and rate-limits wrong ones', async () => {
    enabled();
    await expect(
      service.unlockWithPin('u1', 's1', '0000', '1.2.3.4'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await service.unlockWithPin('u1', 's1', '2468', '1.2.3.4');
    expect(sessionUpdate).toHaveBeenLastCalledWith({
      where: { id: 's1' },
      data: { lockedAt: null, lastActiveAt: expect.any(Date) },
    });

    for (let i = 0; i < 5; i += 1) {
      await service
        .unlockWithPin('u1', 's2', '1111', '5.6.7.8')
        .catch(() => undefined);
    }
    const blocked = await service
      .unlockWithPin('u1', 's2', '2468', '5.6.7.8')
      .catch((e: unknown) => e);
    expect((blocked as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('counts parallel PIN guesses before checking them, so a burst gets only five', async () => {
    enabled();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.unlockWithPin('u1', 's3', '1111', '9.9.9.9').then(
          () => 200,
          (e: unknown) => (e as HttpException).getStatus(),
        ),
      ),
    );
    expect(results.filter((status) => status === 403)).toHaveLength(5);
    expect(results.filter((status) => status === 429)).toHaveLength(3);
  });

  it('answers a wrong PIN with 403, so the app keeps the session', async () => {
    enabled();
    const error = await service
      .unlockWithPin('u1', 's1', '0000', '1.2.3.4')
      .catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(sessionDeleteMany).not.toHaveBeenCalled();
  });

  it('ends the session after 10 wrong PINs, so the password is needed again', async () => {
    enabled();
    sessionDeleteMany.mockResolvedValue({ count: 1 });
    jest.useFakeTimers({ now: Date.now(), doNotFake: ['setImmediate'] });
    try {
      const tryWrong = () =>
        service.unlockWithPin('u1', 's1', '0000', '1.2.3.4').then(
          () => {
            throw new Error('a wrong PIN unlocked the app');
          },
          (e: unknown) => e as HttpException,
        );

      for (let i = 0; i < 5; i += 1) {
        expect((await tryWrong()).getStatus()).toBe(HttpStatus.FORBIDDEN);
      }
      expect((await tryWrong()).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      jest.advanceTimersByTime(61_000);
      for (let i = 0; i < 4; i += 1) {
        expect((await tryWrong()).getStatus()).toBe(HttpStatus.FORBIDDEN);
      }
      expect(sessionDeleteMany).not.toHaveBeenCalled();

      const last = await tryWrong();
      expect(last).toBeInstanceOf(UnauthorizedException);
      expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { id: 's1' } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('locks immediately when the app goes to the background', async () => {
    enabled({ timeoutSeconds: 0 });
    await service.lock('u1', 's1');
    expect(sessionUpdateMany).toHaveBeenCalledWith({
      where: { id: 's1', lockedAt: null },
      data: { lockedAt: expect.any(Date) },
    });
  });

  it('requires the account password and a PIN to turn App Lock on', async () => {
    const passwordHash = await argon2.hash('account-pass', {
      type: argon2.argon2id,
    });
    userFindUnique.mockResolvedValue({ id: 'u1', passwordHash });
    appLockFindUnique.mockResolvedValue(null);
    const base = { enabled: true, timeoutSeconds: 60, hideInSwitcher: true };

    await expect(
      service.updateSettings('u1', 's1', {
        ...base,
        pin: '1357',
        currentPassword: 'nope',
      }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.updateSettings('u1', 's1', {
        ...base,
        currentPassword: 'account-pass',
      }),
    ).rejects.toThrow('Choose a PIN to turn on App Lock.');

    appLockUpsert.mockResolvedValue({});
    await service.updateSettings('u1', 's1', {
      ...base,
      pin: '1357',
      currentPassword: 'account-pass',
    });
    const saved = appLockUpsert.mock.calls[0][0].create as { pinHash: string };
    expect(await argon2.verify(saved.pinHash, '1357')).toBe(true);
  });

  it('limits guesses at the account password in App Lock settings', async () => {
    const passwordHash = await argon2.hash('account-pass', {
      type: argon2.argon2id,
    });
    userFindUnique.mockResolvedValue({ id: 'u1', passwordHash });
    appLockFindUnique.mockResolvedValue(null);
    const wrong = () =>
      service
        .updateSettings('u1', 's1', {
          enabled: false,
          timeoutSeconds: 60,
          hideInSwitcher: true,
          currentPassword: 'nope',
        })
        .catch((e: unknown) => (e as HttpException).getStatus());

    for (let i = 0; i < 5; i += 1) {
      expect(await wrong()).toBe(HttpStatus.FORBIDDEN);
    }
    expect(await wrong()).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('doesn’t count a PIN try when the server fails to check it', async () => {
    appLockFindUnique.mockRejectedValue(new Error('database down'));
    for (let i = 0; i < 6; i += 1) {
      await expect(
        service.unlockWithPin('u1', 's9', '1111', '7.7.7.7'),
      ).rejects.toThrow('database down');
    }
    enabled();
    await service.unlockWithPin('u1', 's9', '2468', '7.7.7.7');
  });
});
