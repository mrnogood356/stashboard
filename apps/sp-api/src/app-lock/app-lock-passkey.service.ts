import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  type AuthenticatorTransport,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppLockService } from './app-lock.service';

const CHALLENGE_TTL_MS = 5 * 60_000;

interface PendingChallenge {
  challenge: string;
  purpose: 'register' | 'unlock';
  label?: string;
  expiresAt: number;
}

/**
 * Face ID / Touch ID unlock via passkeys (WebAuthn). Browsers only allow this on
 * HTTPS (or localhost), so it's offered only when Stashboard is opened that way.
 */
@Injectable()
export class AppLockPasskeyService {
  private readonly challenges = new Map<string, PendingChallenge>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly appLock: AppLockService,
  ) {}

  async registrationOptions(
    request: Request,
    userId: string,
    sessionId: string,
    label?: string,
  ) {
    const { rpID } = this.relyingParty(request);
    const user = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: userId },
    });
    const existing = await this.prisma.appLockPasskey.findMany({
      where: { userId },
    });

    const options = await generateRegistrationOptions({
      rpName: 'Stashboard',
      rpID,
      userName: user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });

    this.remember(sessionId, {
      challenge: options.challenge,
      purpose: 'register',
      label,
    });
    return options;
  }

  async verifyRegistration(
    request: Request,
    userId: string,
    sessionId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const pending = this.take(sessionId, 'register');
    const { rpID, origin } = this.relyingParty(request);

    const verification = await verifyRegistrationResponse({
      response: response as unknown as Parameters<
        typeof verifyRegistrationResponse
      >[0]['response'],
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    }).catch(() => null);

    if (!verification?.verified || !verification.registrationInfo) {
      throw new BadRequestException('Face ID could not be set up. Try again.');
    }

    const { credential } = verification.registrationInfo;
    await this.prisma.appLockPasskey.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        label: pending.label?.trim() || this.guessDeviceLabel(request),
      },
    });
  }

  async unlockOptions(request: Request, userId: string, sessionId: string) {
    const { rpID } = this.relyingParty(request);
    const passkeys = await this.prisma.appLockPasskey.findMany({
      where: { userId },
    });
    if (passkeys.length === 0) {
      throw new BadRequestException('Face ID is not set up for App Lock.');
    }

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'required',
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransport[],
      })),
    });
    this.remember(sessionId, {
      challenge: options.challenge,
      purpose: 'unlock',
    });
    return options;
  }

  async verifyUnlock(
    request: Request,
    userId: string,
    sessionId: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const pending = this.take(sessionId, 'unlock');
    const { rpID, origin } = this.relyingParty(request);
    const credentialId = typeof response.id === 'string' ? response.id : '';
    const passkey = await this.prisma.appLockPasskey.findFirst({
      where: { userId, credentialId },
    });
    if (!passkey) {
      throw new ForbiddenException(
        'That passkey is not registered for App Lock.',
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: response as unknown as Parameters<
        typeof verifyAuthenticationResponse
      >[0]['response'],
      expectedChallenge: pending.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
    }).catch(() => null);

    if (!verification?.verified) {
      throw new ForbiddenException('Face ID did not match.');
    }

    await this.prisma.appLockPasskey.update({
      where: { id: passkey.id },
      data: {
        counter: verification.authenticationInfo.newCounter,
        lastUsedAt: new Date(),
      },
    });
    await this.appLock.markUnlocked(sessionId);
  }

  async remove(userId: string, passkeyId: string): Promise<void> {
    await this.prisma.appLockPasskey.deleteMany({
      where: { id: passkeyId, userId },
    });
  }

  /** WebAuthn is bound to the site's hostname and needs a secure (HTTPS) origin. */
  relyingParty(request: Request): { rpID: string; origin: string } {
    const host = request.get('host') ?? '';
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const secure = request.protocol === 'https' || hostname === 'localhost';
    if (!hostname || !secure) {
      throw new BadRequestException(
        'Face ID needs Stashboard to be opened over HTTPS. Use your PIN, or set up HTTPS to enable Face ID.',
      );
    }
    // WebAuthn refuses IP addresses (IPv4, or IPv6 with its colons) as the relying party.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
      throw new BadRequestException(
        'Face ID needs a domain name, not an IP address.',
      );
    }
    return { rpID: hostname, origin: `${request.protocol}://${host}` };
  }

  private remember(
    sessionId: string,
    challenge: Omit<PendingChallenge, 'expiresAt'>,
  ): void {
    const now = Date.now();
    for (const [key, value] of this.challenges) {
      if (value.expiresAt < now) {
        this.challenges.delete(key);
      }
    }
    this.challenges.set(sessionId, {
      ...challenge,
      expiresAt: now + CHALLENGE_TTL_MS,
    });
  }

  private take(
    sessionId: string,
    purpose: PendingChallenge['purpose'],
  ): PendingChallenge {
    const pending = this.challenges.get(sessionId);
    this.challenges.delete(sessionId);
    if (
      !pending ||
      pending.purpose !== purpose ||
      pending.expiresAt < Date.now()
    ) {
      throw new BadRequestException('That request expired. Try again.');
    }
    return pending;
  }

  private guessDeviceLabel(request: Request): string {
    const agent = request.get('user-agent') ?? '';
    if (/iPhone/.test(agent)) return 'iPhone';
    if (/iPad/.test(agent)) return 'iPad';
    if (/Macintosh/.test(agent)) return 'Mac';
    if (/Android/.test(agent)) return 'Android';
    if (/Windows/.test(agent)) return 'Windows';
    return 'This device';
  }
}
