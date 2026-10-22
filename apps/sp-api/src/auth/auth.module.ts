import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { AppLockPasskeyService } from '../app-lock/app-lock-passkey.service';
import { AppLockController } from '../app-lock/app-lock.controller';
import { AppLockService } from '../app-lock/app-lock.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminSessionGuard } from './admin-session.guard';
import { LoginAttemptService } from './login-attempt.service';
import { SessionCookieService } from './session-cookie.service';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController, AppLockController],
  providers: [
    AuthService,
    SessionCookieService,
    LoginAttemptService,
    AppLockService,
    AppLockPasskeyService,
    Reflector,
    {
      provide: APP_GUARD,
      useClass: AdminSessionGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
