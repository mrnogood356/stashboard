import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AppLockService, PHONE_APP_HEADER } from '../app-lock/app-lock.service';
import { AuthService } from './auth.service';
import {
  ALLOW_JUST_AFTER_LOCK,
  ALLOW_WHEN_LOCKED,
} from './decorators/allow-when-locked.decorator';
import { IS_PUBLIC_ROUTE } from './decorators/public.decorator';

/** How long after locking a phone's leaving-the-app saves still go through. */
const JUST_LOCKED_GRACE_MS = 15_000;

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly appLock?: AppLockService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublicRoute = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (isPublicRoute) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const authContext = await this.authService.resolveRequestAuth(
      request,
      response,
    );

    if (!authContext.authenticated) {
      throw new UnauthorizedException('Authentication required.');
    }

    if (
      this.appLock &&
      authContext.sessionId &&
      request.headers[PHONE_APP_HEADER] === 'phone'
    ) {
      await this.appLock.notePhoneApp(authContext.sessionId);
    }

    // App Lock: while this device is locked, only unlocking is allowed.
    const allowWhenLocked = this.reflector.getAllAndOverride<boolean>(
      ALLOW_WHEN_LOCKED,
      [context.getHandler(), context.getClass()],
    );
    if (
      !allowWhenLocked &&
      this.appLock &&
      authContext.user &&
      authContext.sessionId
    ) {
      const justAfterLock = this.reflector.getAllAndOverride<boolean>(
        ALLOW_JUST_AFTER_LOCK,
        [context.getHandler(), context.getClass()],
      );
      await (justAfterLock
        ? this.appLock.assertUnlocked(
            authContext.user.id,
            authContext.sessionId,
            { justLockedGraceMs: JUST_LOCKED_GRACE_MS },
          )
        : this.appLock.assertUnlocked(
            authContext.user.id,
            authContext.sessionId,
          ));
    }

    return true;
  }
}
