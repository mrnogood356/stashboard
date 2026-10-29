import {
  HttpException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AdminUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { AppLockPasskeyService } from '../app-lock/app-lock-passkey.service';
import { PrismaService } from '../prisma/prisma.service';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { PasskeyLoginDto } from './dto/passkey-login.dto';
import {
  type AuthStatusResponse,
  type AuthenticatedAdmin,
  type AuthenticatedRequest,
  type RequestAuthContext,
} from './auth.types';
import { LoginAttemptService } from './login-attempt.service';
import { SessionCookieService } from './session-cookie.service';

type AdminSessionRecord = Awaited<ReturnType<AuthService['loadSessionRecord']>>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private static readonly SESSION_TOUCH_INTERVAL_MS = 15 * 60 * 1000;
  private dummyPasswordHash: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionCookieService: SessionCookieService,
    private readonly loginAttemptService: LoginAttemptService,
    private readonly passkeys: AppLockPasskeyService,
  ) {}

  async getStatus(
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
    const authContext = await this.resolveRequestAuth(request, response);
    return this.toStatus(
      authContext,
      await this.passkeySignInAvailable(authContext, request),
    );
  }

  async bootstrapAdmin(
    dto: BootstrapAdminDto,
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
    if (!setupCodeMatches(dto.setupCode)) {
      this.logger.warn('Refused to create an admin account: wrong setup code.');
      throw new ForbiddenException(
        'That setup code is wrong. It is the SETUP_CODE set on the server.',
      );
    }

    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    let user: AdminUser;
    try {
      user = await this.prisma.adminUser.create({
        data: {
          singletonKey: 1,
          username: dto.username.trim(),
          normalizedUsername: normalizeUsername(dto.username),
          passwordHash,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        this.logger.warn(
          'Refused to create an admin account: one already exists.',
        );
        throw new ConflictException('Bootstrap is no longer available.');
      }

      throw error;
    }

    const sessionId = await this.startSession(
      user.id,
      user.sessionVersion,
      response,
    );
    this.logger.log(`Created the admin account “${user.username}”.`);
    return this.toStatus(
      this.writeCachedRequestAuth(request, {
        bootstrapRequired: false,
        authenticated: true,
        user: {
          id: user.id,
          username: user.username,
          normalizedUsername: user.normalizedUsername,
          sessionVersion: user.sessionVersion,
        },
        sessionId,
      }),
    );
  }

  async login(
    dto: LoginDto,
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
    const normalizedUsername = normalizeUsername(dto.username);
    const ipAddress = this.getRequestIp(request);

    // Counted up front, before any await, so parallel guesses can't all pass
    // the check; a success clears it again.
    try {
      this.reserveLoginAttempt(ipAddress, normalizedUsername);
    } catch (error) {
      this.logger.warn(
        `Login for “${normalizedUsername}” from ${ipAddress} refused: too many wrong tries.`,
      );
      throw error;
    }

    const attemptKeys = this.loginAttemptKeys(ipAddress, normalizedUsername);
    try {
      const adminUser = await this.prisma.adminUser.findUnique({
        where: {
          normalizedUsername,
        },
      });

      if (!adminUser) {
        if ((await this.prisma.adminUser.count()) === 0) {
          this.clearLoginFailures(ipAddress, normalizedUsername);
          throw new ConflictException(
            'Bootstrap is required before logging in.',
          );
        }

        // Spend the same time as a real check, so how long the answer takes
        // doesn't tell a guesser which usernames exist.
        await argon2
          .verify(await this.dummyHash(), dto.password)
          .catch(() => false);
        this.logger.warn(
          `Failed login from ${ipAddress}: no user “${normalizedUsername}”.`,
        );
        throw new UnauthorizedException('Invalid username or password.');
      }

      const passwordMatches = await argon2.verify(
        adminUser.passwordHash,
        dto.password,
      );
      if (!passwordMatches) {
        this.logger.warn(
          `Failed login for “${adminUser.username}” from ${ipAddress}: wrong password.`,
        );
        throw new UnauthorizedException('Invalid username or password.');
      }

      this.clearLoginFailures(ipAddress, normalizedUsername);
      const sessionId = await this.startSession(
        adminUser.id,
        adminUser.sessionVersion,
        response,
        dto.rememberMe ?? true,
      );
      this.logger.log(`“${adminUser.username}” logged in from ${ipAddress}.`);
      return this.toStatus(
        this.writeCachedRequestAuth(request, {
          bootstrapRequired: false,
          authenticated: true,
          user: {
            id: adminUser.id,
            username: adminUser.username,
            normalizedUsername: adminUser.normalizedUsername,
            sessionVersion: adminUser.sessionVersion,
          },
          sessionId,
        }),
      );
    } catch (error) {
      // A wrong password stays counted; a server error gives the try back.
      if (!(error instanceof HttpException)) {
        this.loginAttemptService.release(attemptKeys);
      }
      throw error;
    }
  }

  /** Options for signing in with Face ID (a passkey added for App Lock). */
  async passkeyLoginOptions(request: Request) {
    // Refused while this address is blocked, though asking isn't a guess.
    this.loginAttemptService.assertAllowed(
      this.loginAttemptIpKey(this.getRequestIp(request)),
    );
    return this.passkeys.loginOptions(request);
  }

  /**
   * Signs in with Face ID: throttled with password logins from the same
   * address, and starts the same kind of session.
   */
  async loginWithPasskey(
    dto: PasskeyLoginDto,
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
    // A site passkeys can't work on isn't a wrong guess: refused uncounted.
    this.passkeys.relyingParty(request);
    const ipAddress = this.getRequestIp(request);
    const attemptKeys = [
      this.loginAttemptIpKey(ipAddress),
      `passkey-login:${ipAddress}`,
    ];

    let adminUser: AdminUser | null;
    try {
      adminUser = await this.loginAttemptService.withReserved(
        attemptKeys,
        async () => {
          const userId = await this.passkeys.verifyLogin(request, dto.response);
          const user = await this.prisma.adminUser.findUnique({
            where: { id: userId },
          });
          if (!user) {
            throw new UnauthorizedException('Face ID sign-in failed.');
          }
          return user;
        },
      );
    } catch (error) {
      this.logger.warn(
        `Face ID sign-in from ${ipAddress} refused: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    attemptKeys.forEach((key) => this.loginAttemptService.clear(key));
    const sessionId = await this.startSession(
      adminUser.id,
      adminUser.sessionVersion,
      response,
      dto.rememberMe ?? true,
    );
    this.logger.log(
      `“${adminUser.username}” signed in with Face ID from ${ipAddress}.`,
    );
    return this.toStatus(
      this.writeCachedRequestAuth(request, {
        bootstrapRequired: false,
        authenticated: true,
        user: {
          id: adminUser.id,
          username: adminUser.username,
          normalizedUsername: adminUser.normalizedUsername,
          sessionVersion: adminUser.sessionVersion,
        },
        sessionId,
      }),
    );
  }

  async logout(
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
    const authContext = await this.resolveRequestAuth(request, response);
    if (authContext.sessionId) {
      await this.prisma.adminSession.deleteMany({
        where: {
          id: authContext.sessionId,
        },
      });
    }

    this.sessionCookieService.clearSessionCookie(response);
    this.logger.log(
      authContext.user
        ? `“${authContext.user.username}” logged out.`
        : 'Logged out a visitor without a session.',
    );
    const bootstrapRequired = (await this.prisma.adminUser.count()) === 0;

    const unauthenticatedStatus: RequestAuthContext = {
      bootstrapRequired,
      authenticated: false,
      user: null,
      sessionId: null,
    };
    this.writeCachedRequestAuth(request, unauthenticatedStatus);

    return this.toStatus(
      unauthenticatedStatus,
      await this.passkeySignInAvailable(unauthenticatedStatus, request),
    );
  }

  async changePassword(
    request: Request,
    response: Response,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const authContext = await this.requireAuthenticatedRequest(
      request,
      response,
    );
    const adminUser = await this.prisma.adminUser.findUnique({
      where: {
        id: authContext.user.id,
      },
    });

    if (!adminUser) {
      throw new UnauthorizedException('Authentication required.');
    }

    // A stolen session cookie must not allow unlimited guesses at the
    // password, so this is throttled per user like login.
    const attemptKey = `change-password:${adminUser.id}`;
    await this.loginAttemptService.withReserved([attemptKey], async () => {
      const currentPasswordMatches = await argon2.verify(
        adminUser.passwordHash,
        dto.currentPassword,
      );
      if (!currentPasswordMatches) {
        this.logger.warn(
          `Password change for “${adminUser.username}” refused: the current password was wrong.`,
        );
        throw new UnauthorizedException('Current password is incorrect.');
      }
    });
    this.loginAttemptService.clear(attemptKey);

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException(
        'New password must be different from the current password.',
      );
    }

    const nextSessionVersion = adminUser.sessionVersion + 1;
    const currentSession = await this.prisma.adminSession.findUnique({
      where: { id: authContext.sessionId },
      select: { persistent: true },
    });
    const persistent = currentSession?.persistent ?? true;
    const nextExpiresAt = this.buildSessionExpiry(persistent);

    await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: {
          id: adminUser.id,
        },
        data: {
          passwordHash: await argon2.hash(dto.newPassword, {
            type: argon2.argon2id,
          }),
          sessionVersion: nextSessionVersion,
        },
      }),
      this.prisma.adminSession.update({
        where: {
          id: authContext.sessionId,
        },
        data: {
          sessionVersion: nextSessionVersion,
          expiresAt: nextExpiresAt,
          lastSeenAt: new Date(),
        },
      }),
      this.prisma.adminSession.deleteMany({
        where: {
          userId: adminUser.id,
          id: {
            not: authContext.sessionId,
          },
        },
      }),
    ]);

    this.sessionCookieService.setSessionCookie(
      response,
      authContext.sessionId,
      nextExpiresAt,
      persistent,
    );
    this.writeCachedRequestAuth(request, {
      bootstrapRequired: false,
      authenticated: true,
      user: {
        ...authContext.user,
        sessionVersion: nextSessionVersion,
      },
      sessionId: authContext.sessionId,
    });
    this.logger.log(
      `“${adminUser.username}” changed their password; other sessions were signed out.`,
    );
  }

  async resolveRequestAuth(
    request: Request,
    response?: Response,
  ): Promise<RequestAuthContext> {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (authenticatedRequest.authContext) {
      return authenticatedRequest.authContext;
    }

    const adminUserCount = await this.prisma.adminUser.count();
    if (adminUserCount === 0) {
      if (response) {
        this.sessionCookieService.clearSessionCookie(response);
      }

      return this.writeCachedRequestAuth(request, {
        bootstrapRequired: true,
        authenticated: false,
        user: null,
        sessionId: null,
      });
    }

    const sessionId = this.sessionCookieService.readSessionId(
      request.headers.cookie,
    );
    if (!sessionId) {
      return this.writeCachedRequestAuth(request, {
        bootstrapRequired: false,
        authenticated: false,
        user: null,
        sessionId: null,
      });
    }

    const session = await this.loadSessionRecord(sessionId);
    if (!session) {
      if (response) {
        this.sessionCookieService.clearSessionCookie(response);
      }

      return this.writeCachedRequestAuth(request, {
        bootstrapRequired: false,
        authenticated: false,
        user: null,
        sessionId: null,
      });
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.adminSession.deleteMany({
        where: {
          id: session.id,
        },
      });
      if (response) {
        this.sessionCookieService.clearSessionCookie(response);
      }

      return this.writeCachedRequestAuth(request, {
        bootstrapRequired: false,
        authenticated: false,
        user: null,
        sessionId: null,
      });
    }

    if (
      !session.user ||
      session.sessionVersion !== session.user.sessionVersion
    ) {
      await this.prisma.adminSession.deleteMany({
        where: {
          id: session.id,
        },
      });
      if (response) {
        this.sessionCookieService.clearSessionCookie(response);
      }

      return this.writeCachedRequestAuth(request, {
        bootstrapRequired: false,
        authenticated: false,
        user: null,
        sessionId: null,
      });
    }

    const authContext: RequestAuthContext = {
      bootstrapRequired: false,
      authenticated: true,
      user: {
        id: session.user.id,
        username: session.user.username,
        normalizedUsername: session.user.normalizedUsername,
        sessionVersion: session.user.sessionVersion,
      },
      sessionId: session.id,
    };
    this.writeCachedRequestAuth(request, authContext);

    await this.touchSessionIfNeeded(session, response);
    return authContext;
  }

  async requireAuthenticatedRequest(
    request: Request,
    response?: Response,
  ): Promise<{
    bootstrapRequired: false;
    authenticated: true;
    user: AuthenticatedAdmin;
    sessionId: string;
  }> {
    const authContext = await this.resolveRequestAuth(request, response);
    if (
      !authContext.authenticated ||
      !authContext.user ||
      !authContext.sessionId
    ) {
      throw new UnauthorizedException('Authentication required.');
    }

    return {
      bootstrapRequired: false,
      authenticated: true,
      user: authContext.user,
      sessionId: authContext.sessionId,
    };
  }

  private async startSession(
    userId: string,
    sessionVersion: number,
    response: Response,
    persistent = true,
  ): Promise<string> {
    // Sessions are otherwise only deleted when their cookie comes back, so
    // ones from browsers that never return would pile up.
    await this.prisma.adminSession
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => undefined);
    const expiresAt = this.buildSessionExpiry(persistent);
    const session = await this.prisma.adminSession.create({
      data: {
        userId,
        sessionVersion,
        expiresAt,
        persistent,
      },
    });

    this.sessionCookieService.setSessionCookie(
      response,
      session.id,
      expiresAt,
      persistent,
    );
    return session.id;
  }

  /** A hash of nothing in particular, made once, for logins with an unknown username. */
  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= argon2.hash(randomBytes(16).toString('hex'), {
      type: argon2.argon2id,
    });
    return this.dummyPasswordHash;
  }

  private buildSessionExpiry(persistent: boolean): Date {
    return new Date(
      Date.now() + this.sessionCookieService.sessionTtlFor(persistent),
    );
  }

  private async loadSessionRecord(sessionId: string) {
    return this.prisma.adminSession.findUnique({
      where: {
        id: sessionId,
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            normalizedUsername: true,
            sessionVersion: true,
          },
        },
      },
    });
  }

  private async touchSessionIfNeeded(
    session: NonNullable<AdminSessionRecord>,
    response?: Response,
  ): Promise<void> {
    if (!response) {
      return;
    }

    if (
      Date.now() - session.lastSeenAt.getTime() <
      AuthService.SESSION_TOUCH_INTERVAL_MS
    ) {
      return;
    }

    // Sessions not kept signed in last 12 hours from the last visit; the
    // others a month.
    const persistent = session.persistent ?? true;
    const expiresAt = this.buildSessionExpiry(persistent);
    await this.prisma.adminSession.update({
      where: {
        id: session.id,
      },
      data: {
        expiresAt,
        lastSeenAt: new Date(),
      },
    });
    this.sessionCookieService.setSessionCookie(
      response,
      session.id,
      expiresAt,
      persistent,
    );
  }

  private reserveLoginAttempt(
    ipAddress: string,
    normalizedUsername: string,
  ): void {
    this.loginAttemptService.reserve(
      this.loginAttemptKeys(ipAddress, normalizedUsername),
    );
  }

  private loginAttemptKeys(
    ipAddress: string,
    normalizedUsername: string,
  ): string[] {
    return [
      this.loginAttemptIpKey(ipAddress),
      this.loginAttemptUsernameKey(ipAddress, normalizedUsername),
    ];
  }

  private clearLoginFailures(
    ipAddress: string,
    normalizedUsername: string,
  ): void {
    this.loginAttemptService.clear(this.loginAttemptIpKey(ipAddress));
    this.loginAttemptService.clear(
      this.loginAttemptUsernameKey(ipAddress, normalizedUsername),
    );
  }

  private loginAttemptIpKey(ipAddress: string): string {
    return `ip:${ipAddress}`;
  }

  private loginAttemptUsernameKey(
    ipAddress: string,
    normalizedUsername: string,
  ): string {
    return `login:${ipAddress}:${normalizedUsername}`;
  }

  private getRequestIp(request: Request): string {
    // Express applies trust-proxy rules to request.ip when configured.
    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private toStatus(
    authContext: RequestAuthContext,
    passkeySignIn = false,
  ): AuthStatusResponse {
    return {
      bootstrapRequired: authContext.bootstrapRequired,
      authenticated: authContext.authenticated,
      username: authContext.user?.username ?? null,
      passkeySignIn,
      setupCodeRequired:
        authContext.bootstrapRequired && configuredSetupCode() !== null,
    };
  }

  /**
   * Whether the sign-in page should offer Face ID: only to someone signed
   * out, on a site passkeys work on, once a passkey has been added.
   */
  private async passkeySignInAvailable(
    authContext: RequestAuthContext,
    request: Request,
  ): Promise<boolean> {
    if (authContext.authenticated || authContext.bootstrapRequired) {
      return false;
    }
    return this.passkeys.loginAvailable(request).catch(() => false);
  }

  private writeCachedRequestAuth(
    request: Request,
    authContext: RequestAuthContext,
  ): RequestAuthContext {
    (request as AuthenticatedRequest).authContext = authContext;
    return authContext;
  }

  private clearCachedRequestAuth(request: Request): void {
    delete (request as AuthenticatedRequest).authContext;
  }
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

/**
 * SETUP_CODE: when set, creating the first admin also needs this code, so
 * someone who reaches a fresh install before you do can't claim it.
 */
function configuredSetupCode(): string | null {
  return process.env.SETUP_CODE?.trim() || null;
}

function setupCodeMatches(given: string | undefined): boolean {
  const expected = configuredSetupCode();
  if (!expected) {
    return true;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(given?.trim() ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
