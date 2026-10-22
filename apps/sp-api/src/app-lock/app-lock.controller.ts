import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { AllowWhenLocked } from '../auth/decorators/allow-when-locked.decorator';
import { AppLockPasskeyService } from './app-lock-passkey.service';
import { AppLockService } from './app-lock.service';
import {
  AppLockStatusDto,
  PasskeyRegistrationOptionsDto,
  PasskeyResponseDto,
  UnlockWithPinDto,
  UpdateAppLockSettingsDto,
} from './dto/app-lock.dto';

@Controller('api/app-lock')
export class AppLockController {
  private readonly logger = new Logger('AppLock');

  constructor(
    private readonly auth: AuthService,
    private readonly appLock: AppLockService,
    private readonly passkeys: AppLockPasskeyService,
  ) {}

  @AllowWhenLocked()
  @Get('status')
  async status(@Req() request: Request): Promise<AppLockStatusDto> {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    return this.appLock.getStatus(user.id, sessionId);
  }

  /**
   * Sent every few seconds while the app is open on screen, so time spent
   * in the app (watching, reading) never counts as being away. Not allowed
   * while locked: the guard refuses it then, and records the activity
   * otherwise.
   */
  @Post('active')
  @HttpCode(204)
  active(): void {}

  /** Sent by the app when it goes to the background with "lock immediately". */
  @AllowWhenLocked()
  @Post('lock')
  @HttpCode(204)
  async lock(@Req() request: Request): Promise<void> {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    await this.appLock.lock(user.id, sessionId);
    this.logger.log('Locked as the app went to the background.');
  }

  @AllowWhenLocked()
  @Post('unlock/pin')
  @HttpCode(204)
  async unlockWithPin(
    @Req() request: Request,
    @Body() body: UnlockWithPinDto,
  ): Promise<void> {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    try {
      await this.appLock.unlockWithPin(
        user.id,
        sessionId,
        body.pin,
        request.ip || request.socket.remoteAddress || 'unknown',
      );
    } catch (error) {
      this.logger.warn(`Unlock with PIN refused: ${messageOf(error)}`);
      throw error;
    }
    this.logger.log('Unlocked with PIN.');
  }

  @AllowWhenLocked()
  @Post('unlock/passkey/options')
  async passkeyUnlockOptions(@Req() request: Request) {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    return this.passkeys.unlockOptions(request, user.id, sessionId);
  }

  @AllowWhenLocked()
  @Post('unlock/passkey')
  @HttpCode(204)
  async passkeyUnlock(
    @Req() request: Request,
    @Body() body: PasskeyResponseDto,
  ): Promise<void> {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    try {
      await this.passkeys.verifyUnlock(
        request,
        user.id,
        sessionId,
        body.response,
      );
    } catch (error) {
      this.logger.warn(`Unlock with Face ID refused: ${messageOf(error)}`);
      throw error;
    }
    this.logger.log('Unlocked with Face ID.');
  }

  @Put('settings')
  async updateSettings(
    @Req() request: Request,
    @Body() body: UpdateAppLockSettingsDto,
  ): Promise<AppLockStatusDto> {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    return this.appLock.updateSettings(user.id, sessionId, body);
  }

  @Post('passkeys/options')
  async passkeyRegistrationOptions(
    @Req() request: Request,
    @Body() body: PasskeyRegistrationOptionsDto,
  ) {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    return this.passkeys.registrationOptions(
      request,
      user.id,
      sessionId,
      body.label,
    );
  }

  @Post('passkeys')
  @HttpCode(204)
  async registerPasskey(
    @Req() request: Request,
    @Body() body: PasskeyResponseDto,
  ): Promise<void> {
    const { user, sessionId } =
      await this.auth.requireAuthenticatedRequest(request);
    await this.passkeys.verifyRegistration(
      request,
      user.id,
      sessionId,
      body.response,
    );
    this.logger.log('Added a Face ID passkey for App Lock.');
  }

  @Delete('passkeys/:id')
  @HttpCode(204)
  async removePasskey(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<void> {
    const { user } = await this.auth.requireAuthenticatedRequest(request);
    await this.passkeys.remove(user.id, id);
    this.logger.log('Removed an App Lock passkey.');
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
