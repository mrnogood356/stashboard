import { Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What every encrypted value starts with; anything else is from before encryption. */
export const SECRET_PREFIX = 'enc:v1:';
const KEY_FILE = 'secret-key';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The columns that hold someone's keys, tokens or secret links, per model.
 * The database only ever sees these encrypted (AES-256-GCM).
 */
export const SECRET_FIELDS = {
  integrationConfig: ['apiKey'],
  notificationSettings: ['url', 'token', 'userKey'],
  organizerSettings: ['tpdbApiKey'],
  libraryAutomationSettings: ['webhookToken'],
} as const;

export type SecretModel = keyof typeof SECRET_FIELDS;

/**
 * Encrypts and decrypts the secrets Stashboard stores. The key comes from
 * STASHBOARD_SECRET_KEY, or from APP_DATA_DIR/secret-key (made on first
 * start), never from the database, so a copy of the database alone holds no
 * usable keys. Values saved before encryption are read as they are, and a
 * value this key can't open reads as missing, with a warning saying what to
 * enter again.
 */
export class SecretBox {
  private readonly logger = new Logger('Secrets');
  private readonly warned = new Set<string>();

  constructor(private readonly key: Buffer | null) {}

  /** Whether values are encrypted when saved. */
  get enabled(): boolean {
    return this.key !== null;
  }

  encrypt(value: string): string {
    // Everything is encrypted, even text that happens to start with the
    // prefix, so whatever is saved reads back exactly as it went in.
    if (!this.key || value === '') {
      return value;
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const sealed = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return (
      SECRET_PREFIX +
      Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64')
    );
  }

  /** The plain value, or null when it was locked with a different key. */
  decrypt(value: string, label: string): string | null {
    if (!value.startsWith(SECRET_PREFIX)) {
      return value;
    }
    try {
      if (!this.key) {
        throw new Error('no key');
      }
      const raw = Buffer.from(value.slice(SECRET_PREFIX.length), 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        raw.subarray(0, IV_BYTES),
      );
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      if (!this.warned.has(label)) {
        this.warned.add(label);
        this.logger.warn(
          `Couldn't unlock the saved ${label}: it was saved with a different secret key (the app data folder or STASHBOARD_SECRET_KEY changed). Enter it again in Settings.`,
        );
      }
      return null;
    }
  }
}

/** Fixed, so the same STASHBOARD_SECRET_KEY always gives the same key. */
const PASSPHRASE_SALT = 'stashboard-secret-key-v1';

/**
 * STASHBOARD_SECRET_KEY (any text, stretched with scrypt so a short one is
 * still slow to guess), else the key file in the app data folder, made on
 * first start. A key file that's there but unreadable or damaged stops the
 * start: carrying on would save new keys unencrypted and lose the old ones.
 * Null, with an error logged, only when there's no key file and one can't be
 * made: secrets are then saved as they are rather than locked with a key
 * that would be lost on restart.
 */
export function loadSecretKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const logger = new Logger('Secrets');
  const configured = env.STASHBOARD_SECRET_KEY?.trim();
  if (configured) {
    return scryptSync(configured, PASSPHRASE_SALT, 32, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
  }
  const file = join(
    env.APP_DATA_DIR?.trim() || '/var/lib/stashboard',
    KEY_FILE,
  );
  const existing = readKeyFile(file);
  if (existing) {
    return existing;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const key = randomBytes(32);
    try {
      writeFileSync(file, `${key.toString('base64')}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      // Another start made it first: use that one.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return loadSecretKey(env);
      }
      throw error;
    }
    chmodSync(file, 0o600);
    logger.log(
      `Made a secret key for saved API keys at ${file}. Keep it with your app data.`,
    );
    return key;
  } catch (error) {
    logger.error(
      `No secret key, so API keys and tokens are saved unencrypted: ${error instanceof Error ? error.message : String(error)}. Set STASHBOARD_SECRET_KEY or make the app data folder writable.`,
    );
    return null;
  }
}

/** The key in the file; null only when there's no file yet. */
function readKeyFile(file: string): Buffer | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(
      `Couldn't read the secret key at ${file} (${(error as Error).message}). Fix its permissions, or restore it from a backup.`,
    );
  }
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(
      `${file} doesn't hold a valid secret key. Restore it from a backup; deleting it means entering every API key again.`,
    );
  }
  return key;
}
