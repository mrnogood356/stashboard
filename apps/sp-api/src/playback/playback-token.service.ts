import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PlaybackGrant {
  /** Stash scene id the link is for. */
  sceneId: string;
  /** Stash's file hash for this scene; scrub-preview files are named by it. */
  hash: string | null;
  /** Unix seconds. */
  expiresAt: number;
}

const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

/**
 * Signed, short-lived playback links. Video elements, TVs (AirPlay/Chromecast)
 * and HLS segment requests can't always send the login cookie, so stream URLs
 * carry a token scoped to one scene that expires after a few hours.
 */
@Injectable()
export class PlaybackTokenService {
  private readonly secret: string;

  constructor() {
    const configured = process.env.SESSION_SECRET?.trim();
    if (!configured && process.env.NODE_ENV !== 'test') {
      throw new Error('SESSION_SECRET is required');
    }
    // Separate key material from session cookies, derived from the same secret.
    this.secret = `${configured || 'test-session-secret'}:playback`;
  }

  issue(
    sceneId: string,
    hash: string | null,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): {
    token: string;
    expiresAt: number;
  } {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(
      JSON.stringify({ s: sceneId, h: hash, e: expiresAt }),
    ).toString('base64url');
    return { token: `${payload}.${this.sign(payload)}`, expiresAt };
  }

  verify(token: string): PlaybackGrant | null {
    const separator = token.indexOf('.');
    if (separator <= 0) {
      return null;
    }

    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = this.sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }

    try {
      const data = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as {
        s?: unknown;
        h?: unknown;
        e?: unknown;
      };
      if (typeof data.s !== 'string' || typeof data.e !== 'number') {
        return null;
      }
      if (data.e < Math.floor(Date.now() / 1000)) {
        return null;
      }
      return {
        sceneId: data.s,
        hash: typeof data.h === 'string' ? data.h : null,
        expiresAt: data.e,
      };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret)
      .update(payload)
      .digest('base64url');
  }
}
