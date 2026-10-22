import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppLockPasskeyService } from './app-lock-passkey.service';
import { AppLockService } from './app-lock.service';

jest.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: jest.fn(),
  generateRegistrationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
}));

const request = (protocol: string, host: string) =>
  ({
    protocol,
    get: (name: string) => (name === 'host' ? host : undefined),
  }) as unknown as Request;

describe('AppLockPasskeyService', () => {
  const service = new AppLockPasskeyService(
    {} as PrismaService,
    {} as AppLockService,
  );

  it('uses the site hostname as the relying party on HTTPS', () => {
    expect(
      service.relyingParty(request('https', 'stashboard.example.com')),
    ).toEqual({
      rpID: 'stashboard.example.com',
      origin: 'https://stashboard.example.com',
    });
    expect(
      service.relyingParty(request('https', 'stashboard.example.com:8443'))
        .origin,
    ).toBe('https://stashboard.example.com:8443');
    expect(service.relyingParty(request('http', 'localhost:4200')).rpID).toBe(
      'localhost',
    );
  });

  it('explains that Face ID needs HTTPS and a domain name', () => {
    expect(() =>
      service.relyingParty(request('http', '192.168.1.50:3005')),
    ).toThrow(BadRequestException);
    expect(() =>
      service.relyingParty(request('http', 'stashboard.lan')),
    ).toThrow(/HTTPS/);
    expect(() =>
      service.relyingParty(request('https', '192.168.1.50')),
    ).toThrow(/domain name/);
    expect(() => service.relyingParty(request('https', '[::1]:443'))).toThrow(
      /domain name/,
    );
    expect(() => service.relyingParty(request('https', ''))).toThrow(
      BadRequestException,
    );
  });
});

describe('AppLockPasskeyService unlock', () => {
  const site = request('https', 'stashboard.example.com');
  const passkey = {
    id: 'pk-1',
    userId: 'user-1',
    credentialId: 'cred-1',
    publicKey: Buffer.from([1, 2, 3]),
    counter: 4,
    transports: ['internal'],
  };
  let prisma: {
    appLockPasskey: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
  };
  let appLock: { markUnlocked: jest.Mock };
  let service: AppLockPasskeyService;

  beforeEach(() => {
    jest.mocked(generateAuthenticationOptions).mockResolvedValue({
      challenge: 'challenge-1',
    });
    jest.mocked(verifyAuthenticationResponse).mockReset();
    prisma = {
      appLockPasskey: {
        findMany: jest.fn().mockResolvedValue([passkey]),
        findFirst: jest.fn().mockResolvedValue(passkey),
        update: jest.fn().mockResolvedValue(passkey),
      },
    };
    appLock = { markUnlocked: jest.fn().mockResolvedValue(undefined) };
    service = new AppLockPasskeyService(
      prisma as unknown as PrismaService,
      appLock as unknown as AppLockService,
    );
  });

  function verifies(result: boolean, newCounter = 5) {
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: result,
      authenticationInfo: { newCounter },
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
  }

  it('unlocks the session, checking the challenge it issued, and stores the new counter', async () => {
    verifies(true, 9);
    await service.unlockOptions(site, 'user-1', 'session-1');
    await service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' });

    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'challenge-1',
        expectedOrigin: 'https://stashboard.example.com',
        expectedRPID: 'stashboard.example.com',
        requireUserVerification: true,
      }),
    );
    expect(prisma.appLockPasskey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pk-1' },
        data: expect.objectContaining({ counter: 9 }),
      }),
    );
    expect(appLock.markUnlocked).toHaveBeenCalledWith('session-1');
  });

  it('only looks up passkeys belonging to the signed-in user', async () => {
    verifies(true);
    await service.unlockOptions(site, 'user-1', 'session-1');
    await service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' });

    expect(prisma.appLockPasskey.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', credentialId: 'cred-1' },
    });
  });

  it('does not unlock when the signature does not verify', async () => {
    verifies(false);
    await service.unlockOptions(site, 'user-1', 'session-1');
    await expect(
      service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' }),
    ).rejects.toThrow(ForbiddenException);
    expect(appLock.markUnlocked).not.toHaveBeenCalled();
    expect(prisma.appLockPasskey.update).not.toHaveBeenCalled();
  });

  it('does not unlock when verification throws', async () => {
    jest
      .mocked(verifyAuthenticationResponse)
      .mockRejectedValue(new Error('bad signature'));
    await service.unlockOptions(site, 'user-1', 'session-1');
    await expect(
      service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' }),
    ).rejects.toThrow(ForbiddenException);
    expect(appLock.markUnlocked).not.toHaveBeenCalled();
  });

  it('refuses a passkey that is not registered', async () => {
    prisma.appLockPasskey.findFirst.mockResolvedValue(null);
    await service.unlockOptions(site, 'user-1', 'session-1');
    await expect(
      service.verifyUnlock(site, 'user-1', 'session-1', { id: 'other' }),
    ).rejects.toThrow(ForbiddenException);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('accepts each challenge once, so a captured response cannot be replayed', async () => {
    verifies(true);
    await service.unlockOptions(site, 'user-1', 'session-1');
    await service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' });

    await expect(
      service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' }),
    ).rejects.toThrow(/expired/);
    expect(appLock.markUnlocked).toHaveBeenCalledTimes(1);
  });

  it('refuses without a challenge, from another session, or after it expires', async () => {
    verifies(true);
    await expect(
      service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' }),
    ).rejects.toThrow(BadRequestException);

    await service.unlockOptions(site, 'user-1', 'session-1');
    await expect(
      service.verifyUnlock(site, 'user-1', 'session-2', { id: 'cred-1' }),
    ).rejects.toThrow(BadRequestException);

    jest.useFakeTimers({ now: Date.now() });
    try {
      await service.unlockOptions(site, 'user-1', 'session-1');
      jest.setSystemTime(Date.now() + 5 * 60_000 + 1);
      await expect(
        service.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' }),
      ).rejects.toThrow(/expired/);
    } finally {
      jest.useRealTimers();
    }
    expect(appLock.markUnlocked).not.toHaveBeenCalled();
  });

  it('does not accept a registration challenge for unlocking', async () => {
    verifies(true);
    const registration = jest.requireMock<{
      generateRegistrationOptions: jest.Mock;
    }>('@simplewebauthn/server');
    registration.generateRegistrationOptions.mockResolvedValue({
      challenge: 'register-challenge',
    });
    const withUser = new AppLockPasskeyService(
      {
        ...prisma,
        adminUser: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ id: 'user-1', username: 'admin' }),
        },
      } as unknown as PrismaService,
      appLock as unknown as AppLockService,
    );
    await withUser.registrationOptions(site, 'user-1', 'session-1');
    await expect(
      withUser.verifyUnlock(site, 'user-1', 'session-1', { id: 'cred-1' }),
    ).rejects.toThrow(/expired/);
    expect(appLock.markUnlocked).not.toHaveBeenCalled();
  });

  it('refuses to start an unlock when no passkey is set up', async () => {
    prisma.appLockPasskey.findMany.mockResolvedValue([]);
    await expect(
      service.unlockOptions(site, 'user-1', 'session-1'),
    ).rejects.toThrow(/not set up/);
  });
});

describe('AppLockPasskeyService registration', () => {
  const site = {
    protocol: 'https',
    get: (name: string) =>
      name === 'host'
        ? 'stashboard.example.com'
        : name === 'user-agent'
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
          : undefined,
  } as unknown as Request;
  const server = jest.requireMock<{
    generateRegistrationOptions: jest.Mock;
    verifyRegistrationResponse: jest.Mock;
  }>('@simplewebauthn/server');
  let create: jest.Mock;
  let service: AppLockPasskeyService;

  beforeEach(() => {
    server.generateRegistrationOptions.mockResolvedValue({
      challenge: 'register-challenge',
    });
    server.verifyRegistrationResponse.mockReset();
    create = jest.fn().mockResolvedValue({});
    service = new AppLockPasskeyService(
      {
        adminUser: {
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ id: 'user-1', username: 'admin' }),
        },
        appLockPasskey: { findMany: jest.fn().mockResolvedValue([]), create },
      } as unknown as PrismaService,
      {} as AppLockService,
    );
  });

  it('stores a verified passkey, naming it after the device when no label is given', async () => {
    server.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: new Uint8Array([1, 2]),
          counter: 0,
          transports: ['internal'],
        },
      },
    });
    await service.registrationOptions(site, 'user-1', 'session-1');
    await service.verifyRegistration(site, 'user-1', 'session-1', {});

    expect(server.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'register-challenge',
        requireUserVerification: true,
      }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        credentialId: 'cred-1',
        label: 'iPhone',
      }) as unknown,
    });
  });

  it('stores nothing when the registration does not verify', async () => {
    server.verifyRegistrationResponse.mockResolvedValue({ verified: false });
    await service.registrationOptions(site, 'user-1', 'session-1', 'Laptop');
    await expect(
      service.verifyRegistration(site, 'user-1', 'session-1', {}),
    ).rejects.toThrow(BadRequestException);

    server.verifyRegistrationResponse.mockRejectedValue(new Error('bad'));
    await service.registrationOptions(site, 'user-1', 'session-1');
    await expect(
      service.verifyRegistration(site, 'user-1', 'session-1', {}),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('AppLockPasskeyService sign-in', () => {
  const site = request('https', 'stashboard.example.com');
  const passkey = {
    id: 'pk-1',
    userId: 'user-1',
    credentialId: 'cred-1',
    publicKey: Buffer.from([1, 2, 3]),
    counter: 4,
    transports: ['internal'],
  };
  let prisma: {
    appLockPasskey: {
      count: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: AppLockPasskeyService;
  let challenges: number;

  /** An assertion as the browser sends it, signed over `challenge`. */
  const assertion = (challenge: string, id = 'cred-1') => ({
    id,
    response: {
      clientDataJSON: Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge }),
      ).toString('base64url'),
    },
  });

  beforeEach(() => {
    challenges = 0;
    jest
      .mocked(generateAuthenticationOptions)
      .mockImplementation(() =>
        Promise.resolve({ challenge: `login-${(challenges += 1)}` } as Awaited<
          ReturnType<typeof generateAuthenticationOptions>
        >),
      );
    jest.mocked(verifyAuthenticationResponse).mockReset();
    prisma = {
      appLockPasskey: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([passkey]),
        findUnique: jest.fn().mockResolvedValue(passkey),
        update: jest.fn().mockResolvedValue(passkey),
      },
    };
    service = new AppLockPasskeyService(
      prisma as unknown as PrismaService,
      {} as AppLockService,
    );
  });

  function verifies(result: boolean, newCounter = 5) {
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: result,
      authenticationInfo: { newCounter },
    } as Awaited<ReturnType<typeof verifyAuthenticationResponse>>);
  }

  it('is available only with a passkey, over HTTPS, on a domain name', async () => {
    await expect(service.loginAvailable(site)).resolves.toBe(true);
    await expect(
      service.loginAvailable(request('http', 'stashboard.lan')),
    ).resolves.toBe(false);
    await expect(
      service.loginAvailable(request('https', '192.168.1.50')),
    ).resolves.toBe(false);
    prisma.appLockPasskey.count.mockResolvedValue(0);
    await expect(service.loginAvailable(site)).resolves.toBe(false);
  });

  it('signs in the owner of a verified passkey, checking the challenge it issued', async () => {
    verifies(true, 9);
    const options = await service.loginOptions(site);
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'stashboard.example.com',
        userVerification: 'required',
        allowCredentials: [{ id: 'cred-1', transports: ['internal'] }],
      }),
    );

    await expect(
      service.verifyLogin(site, assertion(options.challenge)),
    ).resolves.toBe('user-1');
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: options.challenge,
        expectedOrigin: 'https://stashboard.example.com',
        expectedRPID: 'stashboard.example.com',
        requireUserVerification: true,
      }),
    );
    expect(prisma.appLockPasskey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pk-1' },
        data: expect.objectContaining({ counter: 9 }) as unknown,
      }),
    );
  });

  it('accepts each challenge once, and only ones it issued', async () => {
    verifies(true);
    const { challenge } = await service.loginOptions(site);
    await service.verifyLogin(site, assertion(challenge));

    await expect(
      service.verifyLogin(site, assertion(challenge)),
    ).rejects.toThrow(/expired/);
    await expect(
      service.verifyLogin(site, assertion('made-up')),
    ).rejects.toThrow(BadRequestException);
    await expect(service.verifyLogin(site, { id: 'cred-1' })).rejects.toThrow(
      BadRequestException,
    );
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown passkey or a signature that does not verify', async () => {
    prisma.appLockPasskey.findUnique.mockResolvedValueOnce(null);
    const first = await service.loginOptions(site);
    await expect(
      service.verifyLogin(site, assertion(first.challenge, 'other')),
    ).rejects.toThrow(UnauthorizedException);

    verifies(false);
    const second = await service.loginOptions(site);
    await expect(
      service.verifyLogin(site, assertion(second.challenge)),
    ).rejects.toThrow(UnauthorizedException);

    jest
      .mocked(verifyAuthenticationResponse)
      .mockRejectedValue(new Error('bad signature'));
    const third = await service.loginOptions(site);
    await expect(
      service.verifyLogin(site, assertion(third.challenge)),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.appLockPasskey.update).not.toHaveBeenCalled();
  });

  it('refuses on plain HTTP or an IP address, and when no passkey exists', async () => {
    await expect(
      service.loginOptions(request('http', 'stashboard.lan')),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      service.loginOptions(request('https', '10.0.0.2')),
    ).rejects.toThrow(/domain name/);
    prisma.appLockPasskey.findMany.mockResolvedValue([]);
    await expect(service.loginOptions(site)).rejects.toThrow(/not set up/);
  });

  it('keeps only so many unanswered challenges', async () => {
    verifies(true);
    const first = await service.loginOptions(site);
    for (let i = 0; i < 60; i += 1) {
      await service.loginOptions(site);
    }
    await expect(
      service.verifyLogin(site, assertion(first.challenge)),
    ).rejects.toThrow(/expired/);
  });
});
