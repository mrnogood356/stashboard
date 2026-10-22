import {
  ExecutionContext,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { AppLockController } from '../app-lock/app-lock.controller';
import { AppLockService } from '../app-lock/app-lock.service';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { HealthController } from '../health/health.controller';
import { PrismaService } from '../prisma/prisma.service';
import { SetupController } from '../setup/setup.controller';
import { SetupService } from '../setup/setup.service';
import { AdminSessionGuard } from './admin-session.guard';
import { AuthService } from './auth.service';

describe('AdminSessionGuard', () => {
  it('keeps the health route public so healthchecks work without authentication', async () => {
    const authService = {
      resolveRequestAuth: jest.fn(),
    } as unknown as AuthService;
    const guard = new AdminSessionGuard(new Reflector(), authService);

    await expect(
      guard.canActivate(
        createExecutionContext(
          HealthController,
          HealthController.prototype.getStatus,
        ),
      ),
    ).resolves.toBe(true);
    expect(authService.resolveRequestAuth).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const authService = {
      resolveRequestAuth: jest.fn().mockResolvedValue({
        bootstrapRequired: false,
        authenticated: false,
        user: null,
        sessionId: null,
      }),
    } as unknown as AuthService;
    const guard = new AdminSessionGuard(new Reflector(), authService);

    await expect(
      guard.canActivate(
        createExecutionContext(
          SetupController,
          SetupController.prototype.getStatus,
        ),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.resolveRequestAuth).toHaveBeenCalledTimes(1);
  });

  describe('App Lock', () => {
    const authenticated = {
      resolveRequestAuth: jest.fn().mockResolvedValue({
        bootstrapRequired: false,
        authenticated: true,
        user: { id: 'u1' },
        sessionId: 's1',
      }),
    } as unknown as AuthService;

    it('refuses normal routes while the device is locked', async () => {
      const appLock = {
        assertUnlocked: jest
          .fn()
          .mockRejectedValue(new HttpException('Stashboard is locked.', 423)),
      } as unknown as AppLockService;
      const guard = new AdminSessionGuard(
        new Reflector(),
        authenticated,
        appLock,
      );

      await expect(
        guard.canActivate(
          createExecutionContext(
            SetupController,
            SetupController.prototype.getStatus,
          ),
        ),
      ).rejects.toBeInstanceOf(HttpException);
      expect(appLock.assertUnlocked).toHaveBeenCalledWith('u1', 's1');
    });

    it('lets unlock routes through while locked', async () => {
      const appLock = {
        assertUnlocked: jest.fn(),
      } as unknown as AppLockService;
      const guard = new AdminSessionGuard(
        new Reflector(),
        authenticated,
        appLock,
      );

      await expect(
        guard.canActivate(
          createExecutionContext(
            AppLockController,
            AppLockController.prototype.unlockWithPin,
          ),
        ),
      ).resolves.toBe(true);
      expect(appLock.assertUnlocked).not.toHaveBeenCalled();
    });
  });
});

function createExecutionContext(
  controllerClass: object,
  handler: (...args: never[]) => unknown,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controllerClass,
    switchToHttp: () => ({
      getRequest: () => ({ headers: {} }) as Request,
      getResponse: () => ({ clearCookie: jest.fn() }) as unknown as Response,
    }),
  } as unknown as ExecutionContext;
}

void PrismaService;
void SetupService;
