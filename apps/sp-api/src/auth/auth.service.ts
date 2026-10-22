import {
  HttpException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { AdminUser } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
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
  ) {}

  async getStatus(
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
    return this.toStatus(await this.resolveRequestAuth(request, response));
  }

  async bootstrapAdmin(
    dto: BootstrapAdminDto,
    request: Request,
    response: Response,
  ): Promise<AuthStatusResponse> {
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

    return this.toStatus(unauthenticatedStatus);
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
    const nextExpiresAt = this.buildSessionExpiry();

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
  ): Promise<string> {
    // Sessions are otherwise only deleted when their cookie comes back, so
    // ones from browsers that never return would pile up.
    await this.prisma.adminSession
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => undefined);
    const expiresAt = this.buildSessionExpiry();
    const session = await this.prisma.adminSession.create({
      data: {
        userId,
        sessionVersion,
        expiresAt,
      },
    });

    this.sessionCookieService.setSessionCookie(response, session.id, expiresAt);
    return session.id;
  }

  /** A hash of nothing in particular, made once, for logins with an unknown username. */
  private dummyHash(): Promise<string> {
    this.dummyPasswordHash ??= argon2.hash(randomBytes(16).toString('hex'), {
      type: argon2.argon2id,
    });
    return this.dummyPasswordHash;
  }

  private buildSessionExpiry(): Date {
    return new Date(Date.now() + this.sessionCookieService.sessionTtlMs);
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

    const expiresAt = this.buildSessionExpiry();
    await this.prisma.adminSession.update({
      where: {
        id: session.id,
      },
      data: {
        expiresAt,
        lastSeenAt: new Date(),
      },
    });
    this.sessionCookieService.setSessionCookie(response, session.id, expiresAt);
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

  private toStatus(authContext: RequestAuthContext): AuthStatusResponse {
    return {
      bootstrapRequired: authContext.bootstrapRequired,
      authenticated: authContext.authenticated,
      username: authContext.user?.username ?? null,
    };
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
