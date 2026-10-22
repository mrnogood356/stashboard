import * as argon2 from 'argon2';
import {
  ConflictException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AppLockPasskeyService } from '../app-lock/app-lock-passkey.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { LoginAttemptService } from './login-attempt.service';
import { SessionCookieService } from './session-cookie.service';

interface AdminUserRecord {
  id: string;
  singletonKey: number;
  username: string;
  normalizedUsername: string;
  passwordHash: string;
  sessionVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AdminSessionRecord {
  id: string;
  userId: string;
  sessionVersion: number;
  expiresAt: Date;
  lastSeenAt: Date;
  persistent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('AuthService', () => {
  let adminUsers: AdminUserRecord[];
  let adminSessions: AdminSessionRecord[];
  let prisma: PrismaService;
  let sessionCookieService: jest.Mocked<SessionCookieService>;
  let loginAttemptService: jest.Mocked<LoginAttemptService>;
  let passkeys: {
    loginAvailable: jest.Mock;
    loginOptions: jest.Mock;
    relyingParty: jest.Mock;
    verifyLogin: jest.Mock;
  };
  let service: AuthService;

  beforeEach(() => {
    adminUsers = [];
    adminSessions = [];

    prisma = createPrismaMock();
    sessionCookieService = {
      cookieName: 'stashboard_session',
      sessionTtlMs: 30 * DAY_MS,
      sessionTtlFor: jest.fn((persistent: boolean) =>
        persistent ? 30 * DAY_MS : DAY_MS / 2,
      ),
      readSessionId: jest.fn().mockReturnValue(null),
      setSessionCookie: jest.fn(),
      clearSessionCookie: jest.fn(),
    } as unknown as jest.Mocked<SessionCookieService>;
    loginAttemptService = {
      assertAllowed: jest.fn(),
      recordFailure: jest.fn(),
      reserve: jest.fn(),
      release: jest.fn(),
      clear: jest.fn(),
      withReserved: jest.fn((_keys: string[], check: () => Promise<unknown>) =>
        check(),
      ),
    } as unknown as jest.Mocked<LoginAttemptService>;

    passkeys = {
      loginAvailable: jest.fn().mockResolvedValue(false),
      loginOptions: jest.fn(),
      relyingParty: jest.fn(),
      verifyLogin: jest.fn(),
    };
    service = new AuthService(
      prisma,
      sessionCookieService,
      loginAttemptService,
      passkeys as unknown as AppLockPasskeyService,
    );
  });

  it('allows bootstrap only when no admin exists and stores a password hash', async () => {
    const request = createRequest();
    const response = createResponse();

    const status = await service.bootstrapAdmin(
      {
        username: 'LocalAdmin',
        password: 'this-is-a-strong-password',
      },
      request,
      response,
    );

    expect(status).toEqual({
      bootstrapRequired: false,
      authenticated: true,
      username: 'LocalAdmin',
      passkeySignIn: false,
    });
    expect(adminUsers).toHaveLength(1);
    expect(adminUsers[0]?.passwordHash).not.toBe('this-is-a-strong-password');
    await expect(
      argon2.verify(adminUsers[0].passwordHash, 'this-is-a-strong-password'),
    ).resolves.toBe(true);
    expect(sessionCookieService.setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('blocks bootstrap once an admin account already exists', async () => {
    adminUsers.push(
      await createAdminUser('existing-admin', 'already-present-password'),
    );

    await expect(
      service.bootstrapAdmin(
        {
          username: 'AnotherAdmin',
          password: 'another-strong-password',
        },
        createRequest(),
        createResponse(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('treats create-time bootstrap conflicts as setup already completed', async () => {
    (prisma.adminUser.create as jest.Mock).mockRejectedValueOnce(
      createUniqueConstraintError(),
    );

    await expect(
      service.bootstrapAdmin(
        {
          username: 'LocalAdmin',
          password: 'this-is-a-strong-password',
        },
        createRequest(),
        createResponse(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('logs in successfully with the correct password and creates a session', async () => {
    adminUsers.push(
      await createAdminUser('local-admin', 'correct-password-123'),
    );

    const status = await service.login(
      {
        username: 'Local-Admin',
        password: 'correct-password-123',
      },
      createRequest(),
      createResponse(),
    );

    expect(status).toEqual({
      bootstrapRequired: false,
      authenticated: true,
      username: 'local-admin',
      passkeySignIn: false,
    });
    expect(loginAttemptService.clear).toHaveBeenCalledTimes(2);
    expect(adminSessions).toHaveLength(1);
    expect(sessionCookieService.setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it('uses the observed client ip for login throttling instead of forwarded headers', async () => {
    adminUsers.push(
      await createAdminUser('local-admin', 'correct-password-123'),
    );

    await service.login(
      {
        username: 'Local-Admin',
        password: 'correct-password-123',
      },
      createRequest({
        forwardedFor: '203.0.113.55',
        ip: '10.0.0.42',
        remoteAddress: '10.0.0.42',
      }),
      createResponse(),
    );

    expect(loginAttemptService.reserve).toHaveBeenCalledWith([
      'ip:10.0.0.42',
      'login:10.0.0.42:local-admin',
    ]);
  });

  it('fails login with a generic error when the password is incorrect', async () => {
    adminUsers.push(
      await createAdminUser('local-admin', 'correct-password-123'),
    );

    await expect(
      service.login(
        {
          username: 'local-admin',
          password: 'wrong-password',
        },
        createRequest(),
        createResponse(),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(loginAttemptService.reserve).toHaveBeenCalledTimes(1);
    expect(loginAttemptService.clear).not.toHaveBeenCalled();
    expect(adminSessions).toHaveLength(0);
  });

  it('counts parallel wrong logins before checking them, so a burst gets only five guesses', async () => {
    adminUsers.push(
      await createAdminUser('local-admin', 'correct-password-123'),
    );
    service = new AuthService(
      prisma,
      sessionCookieService,
      new LoginAttemptService(),
      passkeys as unknown as AppLockPasskeyService,
    );

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service
          .login(
            { username: 'local-admin', password: 'wrong-password' },
            createRequest(),
            createResponse(),
          )
          .then(
            () => 200,
            (error: unknown) => (error as HttpException).getStatus(),
          ),
      ),
    );

    expect(results.filter((status) => status === 401)).toHaveLength(5);
    expect(results.filter((status) => status === 429)).toHaveLength(3);
  });

  it('takes as long for an unknown username as for a wrong password', async () => {
    adminUsers.push(
      await createAdminUser('local-admin', 'correct-password-123'),
    );
    const timeLogin = async (username: string): Promise<number> => {
      const started = performance.now();
      await service
        .login(
          { username, password: 'wrong-password' },
          createRequest(),
          createResponse(),
        )
        .catch(() => undefined);
      return performance.now() - started;
    };
    await timeLogin('nobody'); // the first one also makes the stand-in hash

    const wrongPassword = await timeLogin('local-admin');
    const unknownUser = await timeLogin('nobody');

    // Before, an unknown username was answered without any hashing at all.
    expect(unknownUser).toBeGreaterThan(wrongPassword / 3);
  });

  it('clears out expired sessions when someone signs in', async () => {
    const admin = await createAdminUser('local-admin', 'correct-password-123');
    adminUsers.push(admin);
    const stale = createAdminSession(admin.id, admin.sessionVersion, 'old');
    stale.expiresAt = new Date(Date.now() - 1_000);
    adminSessions.push(stale);

    await service.login(
      { username: 'local-admin', password: 'correct-password-123' },
      createRequest(),
      createResponse(),
    );

    expect(adminSessions.map((session) => session.id)).not.toContain('old');
    expect(adminSessions).toHaveLength(1);
  });

  it('changes the password, removes other sessions, and invalidates the old password', async () => {
    const adminUser = await createAdminUser('local-admin', 'old-password-123');
    adminUsers.push(adminUser);

    const currentSession = createAdminSession(
      adminUser.id,
      adminUser.sessionVersion,
      'session-1',
    );
    const oldSession = createAdminSession(
      adminUser.id,
      adminUser.sessionVersion,
      'session-2',
    );
    adminSessions.push(currentSession, oldSession);

    sessionCookieService.readSessionId.mockReturnValue(currentSession.id);

    await service.changePassword(
      createRequest({ cookie: 'stashboard_session=signed' }),
      createResponse(),
      {
        currentPassword: 'old-password-123',
        newPassword: 'new-password-456',
      },
    );

    expect(adminUsers[0]?.sessionVersion).toBe(2);
    await expect(
      argon2.verify(adminUsers[0].passwordHash, 'new-password-456'),
    ).resolves.toBe(true);
    await expect(
      argon2.verify(adminUsers[0].passwordHash, 'old-password-123'),
    ).resolves.toBe(false);
    expect(adminSessions).toHaveLength(1);
    expect(adminSessions[0]?.id).toBe(currentSession.id);
    expect(adminSessions[0]?.sessionVersion).toBe(2);

    sessionCookieService.readSessionId.mockReturnValue(oldSession.id);
    await expect(
      service.getStatus(
        createRequest({ cookie: 'stashboard_session=signed' }),
        createResponse(),
      ),
    ).resolves.toEqual({
      bootstrapRequired: false,
      authenticated: false,
      username: null,
      passkeySignIn: false,
    });
  });

  it('throttles current-password guesses when changing the password', async () => {
    const adminUser = await createAdminUser('local-admin', 'old-password-123');
    adminUsers.push(adminUser);
    adminSessions.push(
      createAdminSession(adminUser.id, adminUser.sessionVersion, 'session-1'),
    );
    sessionCookieService.readSessionId.mockReturnValue('session-1');
    service = new AuthService(
      prisma,
      sessionCookieService,
      new LoginAttemptService(),
      passkeys as unknown as AppLockPasskeyService,
    );
    const change = (currentPassword: string) =>
      service
        .changePassword(
          createRequest({ cookie: 'stashboard_session=signed' }),
          createResponse(),
          { currentPassword, newPassword: 'new-password-456' },
        )
        .then(
          () => 200,
          (error: unknown) => (error as HttpException).getStatus(),
        );

    for (let i = 0; i < 5; i += 1) {
      expect(await change('wrong-password')).toBe(401);
    }
    // Blocked now, even with the right password.
    expect(await change('old-password-123')).toBe(429);
    expect(adminUsers[0]?.sessionVersion).toBe(1);
  });

  describe('keep me signed in', () => {
    const signIn = async (rememberMe?: boolean) => {
      adminUsers.push(
        await createAdminUser('local-admin', 'correct-password-123'),
      );
      const response = createResponse();
      await service.login(
        {
          username: 'local-admin',
          password: 'correct-password-123',
          ...(rememberMe === undefined ? {} : { rememberMe }),
        },
        createRequest(),
        response,
      );
      return { session: adminSessions[0], response };
    };

    it('keeps a month-long session and cookie when left out, as older apps send', async () => {
      const { session, response } = await signIn();

      expect(session.persistent).toBe(true);
      expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(
        29 * DAY_MS,
      );
      expect(sessionCookieService.setSessionCookie).toHaveBeenCalledWith(
        response,
        session.id,
        session.expiresAt,
        true,
      );
    });

    it('keeps a month-long session when ticked', async () => {
      const { session } = await signIn(true);
      expect(session.persistent).toBe(true);
    });

    it('when unticked, gives a browser-session cookie and a 12-hour session', async () => {
      const { session, response } = await signIn(false);

      expect(session.persistent).toBe(false);
      const left = session.expiresAt.getTime() - Date.now();
      expect(left).toBeGreaterThan(DAY_MS / 2 - 60_000);
      expect(left).toBeLessThanOrEqual(DAY_MS / 2);
      expect(sessionCookieService.setSessionCookie).toHaveBeenCalledWith(
        response,
        session.id,
        session.expiresAt,
        false,
      );
    });

    it('extends an unticked session by 12 hours on a visit, never by a month', async () => {
      const admin = await createAdminUser('local-admin', 'pw-123456789012');
      adminUsers.push(admin);
      const session = createAdminSession(admin.id, 1, 'short');
      session.persistent = false;
      session.expiresAt = new Date(Date.now() + 60_000);
      session.lastSeenAt = new Date(Date.now() - 60 * 60_000);
      adminSessions.push(session);
      sessionCookieService.readSessionId.mockReturnValue('short');
      const response = createResponse();

      await service.getStatus(
        createRequest({ cookie: 'stashboard_session=signed' }),
        response,
      );

      const left = session.expiresAt.getTime() - Date.now();
      expect(left).toBeGreaterThan(DAY_MS / 2 - 60_000);
      expect(left).toBeLessThanOrEqual(DAY_MS / 2);
      expect(sessionCookieService.setSessionCookie).toHaveBeenCalledWith(
        response,
        'short',
        session.expiresAt,
        false,
      );
    });

    it('signs an unticked session out after 12 hours away', async () => {
      const admin = await createAdminUser('local-admin', 'pw-123456789012');
      adminUsers.push(admin);
      const session = createAdminSession(admin.id, 1, 'short');
      session.persistent = false;
      session.expiresAt = new Date(Date.now() - 1);
      adminSessions.push(session);
      sessionCookieService.readSessionId.mockReturnValue('short');

      const status = await service.getStatus(
        createRequest({ cookie: 'stashboard_session=signed' }),
        createResponse(),
      );
      expect(status.authenticated).toBe(false);
      expect(adminSessions).toHaveLength(0);
    });
  });

  describe('Face ID sign-in', () => {
    it('offers Face ID on the status only to someone signed out where it can work', async () => {
      const admin = await createAdminUser('local-admin', 'pw-123456789012');
      adminUsers.push(admin);
      passkeys.loginAvailable.mockResolvedValue(true);

      await expect(
        service.getStatus(createRequest(), createResponse()),
      ).resolves.toEqual({
        bootstrapRequired: false,
        authenticated: false,
        username: null,
        passkeySignIn: true,
      });

      passkeys.loginAvailable.mockResolvedValue(false);
      const status = await service.getStatus(createRequest(), createResponse());
      expect(status.passkeySignIn).toBe(false);

      // Signed in: nothing to offer, and no need to look.
      passkeys.loginAvailable.mockClear();
      passkeys.loginAvailable.mockResolvedValue(true);
      adminSessions.push(createAdminSession(admin.id, 1, 'session-1'));
      sessionCookieService.readSessionId.mockReturnValue('session-1');
      const signedIn = await service.getStatus(
        createRequest({ cookie: 'stashboard_session=signed' }),
        createResponse(),
      );
      expect(signedIn).toMatchObject({
        authenticated: true,
        passkeySignIn: false,
      });
      expect(passkeys.loginAvailable).not.toHaveBeenCalled();
    });

    it('never offers Face ID before the admin account exists', async () => {
      passkeys.loginAvailable.mockResolvedValue(true);
      const status = await service.getStatus(createRequest(), createResponse());
      expect(status).toMatchObject({
        bootstrapRequired: true,
        passkeySignIn: false,
      });
    });

    it('starts a normal session for the passkey owner', async () => {
      const admin = await createAdminUser('local-admin', 'pw-123456789012');
      adminUsers.push(admin);
      passkeys.verifyLogin.mockResolvedValue(admin.id);
      const request = createRequest({ ip: '10.0.0.7' });
      const response = createResponse();

      const status = await service.loginWithPasskey(
        { response: { id: 'cred-1' }, rememberMe: false },
        request,
        response,
      );

      expect(status).toEqual({
        bootstrapRequired: false,
        authenticated: true,
        username: 'local-admin',
        passkeySignIn: false,
      });
      expect(passkeys.verifyLogin).toHaveBeenCalledWith(request, {
        id: 'cred-1',
      });
      expect(adminSessions).toHaveLength(1);
      expect(adminSessions[0]).toMatchObject({
        userId: admin.id,
        sessionVersion: 1,
        persistent: false,
      });
      expect(sessionCookieService.setSessionCookie).toHaveBeenCalledWith(
        response,
        adminSessions[0].id,
        adminSessions[0].expiresAt,
        false,
      );
      expect(loginAttemptService.withReserved).toHaveBeenCalledWith(
        ['ip:10.0.0.7', 'passkey-login:10.0.0.7'],
        expect.any(Function),
      );
      expect(loginAttemptService.clear).toHaveBeenCalledWith('ip:10.0.0.7');
    });

    it('refuses a passkey that does not check out, without a session', async () => {
      adminUsers.push(await createAdminUser('local-admin', 'pw-123456789012'));
      passkeys.verifyLogin.mockRejectedValue(
        new UnauthorizedException('Face ID sign-in failed.'),
      );

      await expect(
        service.loginWithPasskey(
          { response: { id: 'cred-x' } },
          createRequest(),
          createResponse(),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(adminSessions).toHaveLength(0);
      expect(sessionCookieService.setSessionCookie).not.toHaveBeenCalled();
      expect(loginAttemptService.clear).not.toHaveBeenCalled();
    });

    it('throttles failed passkey sign-ins together with password guesses from the address', async () => {
      adminUsers.push(
        await createAdminUser('local-admin', 'correct-password-123'),
      );
      const attempts = new LoginAttemptService();
      service = new AuthService(
        prisma,
        sessionCookieService,
        attempts,
        passkeys as unknown as AppLockPasskeyService,
      );
      passkeys.verifyLogin.mockRejectedValue(
        new UnauthorizedException('Face ID sign-in failed.'),
      );
      const tryPasskey = () =>
        service
          .loginWithPasskey(
            { response: {} },
            createRequest({ ip: '10.0.0.9' }),
            createResponse(),
          )
          .then(
            () => 200,
            (error: unknown) => (error as HttpException).getStatus(),
          );

      const results = await Promise.all(
        Array.from({ length: 7 }, () => tryPasskey()),
      );
      expect(results.filter((status) => status === 401)).toHaveLength(5);
      expect(results.filter((status) => status === 429)).toHaveLength(2);
      expect(passkeys.verifyLogin).toHaveBeenCalledTimes(5);

      // The address is blocked for passwords, and for asking for options, too.
      await expect(
        service.login(
          { username: 'local-admin', password: 'correct-password-123' },
          createRequest({ ip: '10.0.0.9' }),
          createResponse(),
        ),
      ).rejects.toMatchObject({ status: 429 });
      await expect(
        service.passkeyLoginOptions(createRequest({ ip: '10.0.0.9' })),
      ).rejects.toMatchObject({ status: 429 });
      expect(passkeys.loginOptions).not.toHaveBeenCalled();
    });

    it('gives the try back when the check fails for a server reason', async () => {
      const attempts = new LoginAttemptService();
      service = new AuthService(
        prisma,
        sessionCookieService,
        attempts,
        passkeys as unknown as AppLockPasskeyService,
      );
      passkeys.verifyLogin.mockRejectedValue(new Error('database down'));

      for (let i = 0; i < 8; i += 1) {
        await expect(
          service.loginWithPasskey(
            { response: {} },
            createRequest({ ip: '10.0.0.10' }),
            createResponse(),
          ),
        ).rejects.toThrow('database down');
      }
      expect(passkeys.verifyLogin).toHaveBeenCalledTimes(8);
    });
  });

  function createPrismaMock(): PrismaService {
    return {
      adminUser: {
        count: jest.fn(async () => adminUsers.length),
        create: jest.fn(async ({ data }) => {
          if (
            adminUsers.some(
              (candidate) =>
                candidate.singletonKey === (data.singletonKey ?? 1),
            )
          ) {
            throw createUniqueConstraintError();
          }

          if (
            adminUsers.some(
              (candidate) =>
                candidate.normalizedUsername === data.normalizedUsername,
            )
          ) {
            throw createUniqueConstraintError();
          }

          const record: AdminUserRecord = {
            id: `user-${adminUsers.length + 1}`,
            singletonKey: data.singletonKey ?? 1,
            username: data.username,
            normalizedUsername: data.normalizedUsername,
            passwordHash: data.passwordHash,
            sessionVersion: data.sessionVersion ?? 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          adminUsers.push(record);
          return record;
        }),
        findUnique: jest.fn(async ({ where }) => {
          if (where.id) {
            return adminUsers.find((user) => user.id === where.id) ?? null;
          }

          if (where.normalizedUsername) {
            return (
              adminUsers.find(
                (user) => user.normalizedUsername === where.normalizedUsername,
              ) ?? null
            );
          }

          return null;
        }),
        update: jest.fn(async ({ where, data }) => {
          const user = adminUsers.find(
            (candidate) => candidate.id === where.id,
          );
          if (!user) {
            throw new Error(`Unknown admin user ${where.id}`);
          }

          user.passwordHash = data.passwordHash ?? user.passwordHash;
          user.sessionVersion = data.sessionVersion ?? user.sessionVersion;
          user.updatedAt = new Date();
          return user;
        }),
      },
      adminSession: {
        create: jest.fn(async ({ data }) => {
          const record: AdminSessionRecord = createAdminSession(
            data.userId,
            data.sessionVersion,
            `session-${adminSessions.length + 1}`,
          );
          record.expiresAt = data.expiresAt;
          record.persistent = data.persistent ?? true;
          adminSessions.push(record);
          return record;
        }),
        findUnique: jest.fn(async ({ where }) => {
          const session = adminSessions.find(
            (candidate) => candidate.id === where.id,
          );
          if (!session) {
            return null;
          }

          const user = adminUsers.find(
            (candidate) => candidate.id === session.userId,
          );
          return {
            ...session,
            user: user && {
              id: user.id,
              username: user.username,
              normalizedUsername: user.normalizedUsername,
              sessionVersion: user.sessionVersion,
            },
          };
        }),
        deleteMany: jest.fn(async ({ where }) => {
          adminSessions = adminSessions.filter(
            (session) => !matchesSessionDelete(session, where),
          );

          return { count: 1 };
        }),
        update: jest.fn(async ({ where, data }) => {
          const session = adminSessions.find(
            (candidate) => candidate.id === where.id,
          );
          if (!session) {
            throw new Error(`Unknown admin session ${where.id}`);
          }

          session.sessionVersion =
            data.sessionVersion ?? session.sessionVersion;
          session.expiresAt = data.expiresAt ?? session.expiresAt;
          session.lastSeenAt = data.lastSeenAt ?? session.lastSeenAt;
          session.updatedAt = new Date();
          return session;
        }),
      },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    } as unknown as PrismaService;
  }
});

function createRequest(
  options: {
    cookie?: string;
    forwardedFor?: string;
    ip?: string;
    remoteAddress?: string;
  } = {},
): Request {
  const headers: Record<string, string> = {};
  if (options.cookie) {
    headers.cookie = options.cookie;
  }
  if (options.forwardedFor) {
    headers['x-forwarded-for'] = options.forwardedFor;
  }

  return {
    headers,
    ip: options.ip ?? '127.0.0.1',
    socket: {
      remoteAddress: options.remoteAddress ?? '127.0.0.1',
    },
  } as unknown as Request;
}

function createResponse(): Response {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  } as unknown as Response;
}

async function createAdminUser(
  username: string,
  password: string,
): Promise<AdminUserRecord> {
  return {
    id: `user-${username}`,
    singletonKey: 1,
    username,
    normalizedUsername: username.toLowerCase(),
    passwordHash: await argon2.hash(password, {
      type: argon2.argon2id,
    }),
    sessionVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createAdminSession(
  userId: string,
  sessionVersion: number,
  id: string,
): AdminSessionRecord {
  return {
    id,
    userId,
    sessionVersion,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    lastSeenAt: new Date(),
    persistent: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function matchesSessionDelete(
  session: AdminSessionRecord,
  where: Record<string, unknown>,
): boolean {
  if (typeof where.id === 'string') {
    return session.id === where.id;
  }

  if (where.id && typeof where.id === 'object' && 'not' in where.id) {
    return session.userId === where.userId && session.id !== where.id.not;
  }

  if (typeof where.userId === 'string') {
    return session.userId === where.userId;
  }

  const expiresAt = where.expiresAt as { lt?: Date } | undefined;
  if (expiresAt?.lt) {
    return session.expiresAt < expiresAt.lt;
  }

  return false;
}

function createUniqueConstraintError(): Error & { code: string } {
  // Prisma throws an Error carrying the P2002 code.
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
  });
}
