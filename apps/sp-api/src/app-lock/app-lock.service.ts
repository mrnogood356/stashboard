import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { LoginAttemptService } from '../auth/login-attempt.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppLockStatusDto, UpdateAppLockSettingsDto } from './dto/app-lock.dto';

export const APP_LOCKED_CODE = 'APP_LOCKED';
/** Sent by the app installed on a phone; App Lock applies only to it. */
export const PHONE_APP_HEADER = 'x-stashboard-app';

interface LockSettings {
  enabled: boolean;
  pinHash: string | null;
  timeoutSeconds: number;
  hideInSwitcher: boolean;
}

/** Don't write "last active" more often than this, to keep requests cheap. */
const ACTIVITY_WRITE_INTERVAL_MS = 15_000;
/** Wrong PINs on one device before its session ends and the password is needed. */
const MAX_WRONG_PINS = 10;
/** Background requests (polling) can't keep a device unlocked beyond this grace. */
const SETTINGS_CACHE_MS = 30_000;

/**
 * App Lock. Each device (login session) locks after a period in the background,
 * and every request except unlocking is refused while it is locked, so the lock
 * can't be bypassed by clearing the page or calling the API directly.
 */
@Injectable()
export class AppLockService {
  private readonly logger = new Logger(AppLockService.name);
  private readonly settingsCache = new Map<
    string,
    { value: LockSettings; at: number }
  >();

  /** Sessions already marked as the phone app, to skip the write. */
  private readonly phoneAppSessions = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly loginAttempts: LoginAttemptService,
  ) {}

  /**
   * Marks the session as the app installed on a phone, the only place App
   * Lock applies. It stays marked, so leaving the header off later doesn't
   * get around the lock.
   */
  async notePhoneApp(sessionId: string): Promise<void> {
    if (this.phoneAppSessions.has(sessionId)) {
      return;
    }
    await this.prisma.adminSession.updateMany({
      where: { id: sessionId, phoneApp: false },
      data: { phoneApp: true },
    });
    this.phoneAppSessions.add(sessionId);
  }

  /** Throws 423 if this session is locked. Called by the guard for every request. */
  async assertUnlocked(userId: string, sessionId: string): Promise<void> {
    if (await this.isLocked(userId, sessionId, true)) {
      throw new HttpException(
        {
          statusCode: HttpStatus.LOCKED,
          code: APP_LOCKED_CODE,
          message: 'Stashboard is locked.',
        },
        HttpStatus.LOCKED,
      );
    }
  }

  async isLocked(
    userId: string,
    sessionId: string,
    recordActivity = false,
  ): Promise<boolean> {
    const settings = await this.getSettings(userId);
    if (!settings.enabled || !settings.pinHash) {
      return false;
    }

    const session = await this.prisma.adminSession.findUnique({
      where: { id: sessionId },
      select: { lockedAt: true, lastActiveAt: true, phoneApp: true },
    });
    // Browsers on a computer, or a phone's browser tab, never lock.
    if (!session?.phoneApp) {
      return false;
    }
    if (session.lockedAt) {
      return true;
    }

    const now = Date.now();
    const lastActive = session.lastActiveAt?.getTime() ?? null;
    // Server-side idle lock: covers the app being killed or backgrounded
    // without notice. While it's open the app says so every few seconds,
    // so only time away from it counts.
    const idleLimitMs = Math.max(settings.timeoutSeconds, 45) * 1000;
    if (lastActive !== null && now - lastActive > idleLimitMs) {
      await this.prisma.adminSession.update({
        where: { id: sessionId },
        data: { lockedAt: new Date(now) },
      });
      this.logger.log(
        `Locked a phone after ${Math.round((now - lastActive) / 1000)}s away.`,
      );
      return true;
    }

    if (
      recordActivity &&
      (lastActive === null || now - lastActive > ACTIVITY_WRITE_INTERVAL_MS)
    ) {
      void this.prisma.adminSession
        .update({
          where: { id: sessionId },
          data: { lastActiveAt: new Date(now) },
        })
        .catch((error: unknown) =>
          this.logger.debug(`activity update failed: ${String(error)}`),
        );
    }
    return false;
  }

  async getStatus(
    userId: string,
    sessionId: string,
  ): Promise<AppLockStatusDto> {
    const settings = await this.getSettings(userId);
    const passkeys = await this.prisma.appLockPasskey.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    });

    return {
      enabled: settings.enabled && !!settings.pinHash,
      locked: await this.isLocked(userId, sessionId),
      timeoutSeconds: settings.timeoutSeconds,
      hideInSwitcher: settings.hideInSwitcher,
      hasPin: !!settings.pinHash,
      passkeys: passkeys.map((passkey) => ({
        id: passkey.id,
        label: passkey.label,
        createdAt: passkey.createdAt.toISOString(),
        lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Locks this device now (sent by the app when it goes to the background). */
  async lock(userId: string, sessionId: string): Promise<void> {
    const settings = await this.getSettings(userId);
    if (!settings.enabled || !settings.pinHash) {
      return;
    }
    await this.prisma.adminSession.updateMany({
      where: { id: sessionId, lockedAt: null },
      data: { lockedAt: new Date() },
    });
  }

  async unlockWithPin(
    userId: string,
    sessionId: string,
    pin: string,
    ip: string,
  ): Promise<void> {
    const keys = [`app-lock:${sessionId}`, `app-lock-ip:${ip}`];
    // Counted before any await, so parallel guesses can't all pass the
    // check, and cleared again on success. A wrong PIN stays counted; a
    // server error gives the try back.
    const unlocked = await this.loginAttempts.withReserved(
      keys,
      async ([sessionTries]) => {
        const settings = await this.getSettings(userId);
        if (!settings.enabled || !settings.pinHash) {
          keys.forEach((key) => this.loginAttempts.clear(key));
          await this.markUnlocked(sessionId);
          return false;
        }

        if (!(await argon2.verify(settings.pinHash, pin))) {
          if (sessionTries >= MAX_WRONG_PINS) {
            // Too many guesses on this device: end the session, so getting back
            // in needs the account password.
            await this.prisma.adminSession.deleteMany({
              where: { id: sessionId },
            });
            keys.forEach((key) => this.loginAttempts.clear(key));
            this.logger.warn(
              `Too many wrong App Lock PINs from ${ip}; signed that device out.`,
            );
            throw new UnauthorizedException(
              'Too many wrong PINs. Sign in again with your password.',
            );
          }
          // 403, not 401: the session is still valid, only the PIN was wrong.
          throw new ForbiddenException('Wrong PIN.');
        }

        return true;
      },
    );
    if (!unlocked) {
      return;
    }
    keys.forEach((key) => this.loginAttempts.clear(key));
    await this.markUnlocked(sessionId);
  }

  async markUnlocked(sessionId: string): Promise<void> {
    await this.prisma.adminSession.update({
      where: { id: sessionId },
      data: { lockedAt: null, lastActiveAt: new Date() },
    });
  }

  async updateSettings(
    userId: string,
    sessionId: string,
    dto: UpdateAppLockSettingsDto,
  ): Promise<AppLockStatusDto> {
    const user = await this.prisma.adminUser.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new NotFoundException();
    }
    // Throttled like login: a stolen session must not get unlimited
    // guesses at the account password here either.
    const attemptKey = `app-lock-settings:${userId}`;
    await this.loginAttempts.withReserved([attemptKey], async () => {
      if (!(await argon2.verify(user.passwordHash, dto.currentPassword))) {
        this.logger.warn(
          'App Lock settings change refused: the account password was wrong.',
        );
        throw new ForbiddenException('Your account password is incorrect.');
      }
    });
    this.loginAttempts.clear(attemptKey);

    const existing = await this.getSettings(userId);
    if (dto.enabled && !dto.pin && !existing.pinHash) {
      throw new BadRequestException('Choose a PIN to turn on App Lock.');
    }

    const pinHash = dto.pin
      ? await argon2.hash(dto.pin, { type: argon2.argon2id })
      : existing.pinHash;
    const data = {
      enabled: dto.enabled,
      pinHash,
      timeoutSeconds: dto.timeoutSeconds,
      hideInSwitcher: dto.hideInSwitcher,
    };

    await this.prisma.appLock.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    this.settingsCache.delete(userId);
    this.logger.log(
      `App Lock settings saved: ${dto.enabled ? 'on' : 'off'}, locks after ${dto.timeoutSeconds}s${dto.pin ? ', new PIN' : ''}.`,
    );
    // Changing settings counts as activity; this device stays unlocked.
    await this.markUnlocked(sessionId);

    return this.getStatus(userId, sessionId);
  }

  async getSettings(userId: string): Promise<LockSettings> {
    const cached = this.settingsCache.get(userId);
    if (cached && Date.now() - cached.at < SETTINGS_CACHE_MS) {
      return cached.value;
    }

    const row = await this.prisma.appLock.findUnique({ where: { userId } });
    const value: LockSettings = {
      enabled: row?.enabled ?? false,
      pinHash: row?.pinHash ?? null,
      timeoutSeconds: row?.timeoutSeconds ?? 60,
      hideInSwitcher: row?.hideInSwitcher ?? true,
    };
    this.settingsCache.set(userId, { value, at: Date.now() });
    return value;
  }
}
