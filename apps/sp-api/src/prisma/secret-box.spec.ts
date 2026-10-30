import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECRET_PREFIX, SecretBox, loadSecretKey } from './secret-box';
import { secretFieldsExtension } from './secret-fields.extension';

const key = (byte: number) => Buffer.alloc(32, byte);

describe('SecretBox', () => {
  it('locks values so only the same key opens them', () => {
    const box = new SecretBox(key(1));
    const sealed = box.encrypt('stash-api-key');

    expect(sealed.startsWith(SECRET_PREFIX)).toBe(true);
    expect(sealed).not.toContain('stash-api-key');
    // A fresh IV each time: the same key never looks the same twice.
    expect(box.encrypt('stash-api-key')).not.toBe(sealed);
    expect(box.decrypt(sealed, 'test key')).toBe('stash-api-key');
    expect(new SecretBox(key(2)).decrypt(sealed, 'test key')).toBeNull();
  });

  it('reads values saved before encryption as they are', () => {
    const box = new SecretBox(key(1));
    expect(box.decrypt('plain-old-key', 'test key')).toBe('plain-old-key');
    expect(box.encrypt('')).toBe('');
  });

  it('round-trips a value that happens to start with the prefix', () => {
    const box = new SecretBox(key(1));
    const odd = `${SECRET_PREFIX}not-really-encrypted`;
    expect(box.decrypt(box.encrypt(odd), 'test key')).toBe(odd);
  });

  it('saves values as they are when there is no key', () => {
    const box = new SecretBox(null);
    expect(box.enabled).toBe(false);
    expect(box.encrypt('stash-api-key')).toBe('stash-api-key');
  });
});

describe('loadSecretKey', () => {
  it('makes a private key file once, then keeps using it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-key-'));
    const first = loadSecretKey({ APP_DATA_DIR: dir });
    const second = loadSecretKey({ APP_DATA_DIR: dir });

    expect(first).toHaveLength(32);
    expect(second?.equals(first!)).toBe(true);
    expect(statSync(join(dir, 'secret-key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'secret-key'), 'utf8').trim()).toBe(
      first!.toString('base64'),
    );
  });

  it('prefers STASHBOARD_SECRET_KEY over the file, giving the same key each time', () => {
    const env = {
      STASHBOARD_SECRET_KEY: 'my passphrase',
      APP_DATA_DIR: '/nonexistent/should-not-be-touched',
    };
    const fromEnv = loadSecretKey(env);
    expect(fromEnv).toHaveLength(32);
    expect(loadSecretKey(env)?.equals(fromEnv!)).toBe(true);
    expect(
      loadSecretKey({ ...env, STASHBOARD_SECRET_KEY: 'other' })?.equals(
        fromEnv!,
      ),
    ).toBe(false);
  });

  it('stops the start when the key file is there but damaged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-key-'));
    writeFileSync(join(dir, 'secret-key'), 'not a key\n');
    expect(() => loadSecretKey({ APP_DATA_DIR: dir })).toThrow(
      /doesn't hold a valid secret key/,
    );
  });

  it('stops the start when the key file is there but can’t be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-key-'));
    // A folder where the file should be: it exists, but can't be read as one.
    mkdirSync(join(dir, 'secret-key'));
    expect(() => loadSecretKey({ APP_DATA_DIR: dir })).toThrow(
      /Couldn't read the secret key/,
    );
  });
});

describe('secretFieldsExtension', () => {
  type Handler = (input: {
    args: Record<string, unknown>;
    query: (args: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<unknown>;

  function handler(model: string): Handler {
    const extension = secretFieldsExtension(
      new SecretBox(key(1)),
    ) as unknown as {
      query?: Record<string, { $allOperations: Handler }>;
    };
    // defineExtension returns a function of the client; read its definition.
    const definition =
      extension.query ??
      (
        extension as unknown as (client: unknown) => {
          query: Record<string, { $allOperations: Handler }>;
        }
      )({ $extends: (def: unknown) => def }).query;
    return definition[model].$allOperations;
  }

  it('encrypts secrets in what is saved and decrypts them in what comes back', async () => {
    const saved: Record<string, unknown>[] = [];
    const run = handler('integrationConfig');

    const result = await run({
      args: {
        where: { type: 'STASH' },
        create: { type: 'STASH', apiKey: 'k1', baseUrl: 'http://stash' },
        update: { apiKey: { set: 'k2' } },
      },
      query: (args) => {
        saved.push(args);
        const created = args.create as Record<string, unknown>;
        return Promise.resolve([{ ...created }]);
      },
    });

    const args = saved[0];
    const create = args.create as Record<string, unknown>;
    const update = args.update as { apiKey: { set: string } };
    expect(create.baseUrl).toBe('http://stash');
    expect(String(create.apiKey).startsWith(SECRET_PREFIX)).toBe(true);
    expect(update.apiKey.set.startsWith(SECRET_PREFIX)).toBe(true);
    expect(result).toEqual([
      { type: 'STASH', apiKey: 'k1', baseUrl: 'http://stash' },
    ]);
  });

  it('leaves results without secrets, like counts, alone', async () => {
    const run = handler('notificationSettings');
    await expect(
      run({ args: {}, query: () => Promise.resolve(3) }),
    ).resolves.toBe(3);
  });
});
