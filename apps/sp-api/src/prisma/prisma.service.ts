import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  SECRET_FIELDS,
  SECRET_PREFIX,
  SecretBox,
  loadSecretKey,
  type SecretModel,
} from './secret-box';
import { secretFieldsExtension } from './secret-fields.extension';

type Row = Record<string, unknown>;
type Delegate = {
  findMany(args?: unknown): Promise<Row[]>;
  update(args: unknown): Promise<unknown>;
};

/**
 * The database client. Keys, tokens and secret links (SECRET_FIELDS) are
 * encrypted on the way in and decrypted on the way out; everything else
 * passes through untouched.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger('Secrets');
  private readonly secrets: SecretBox;
  /** This client without the extension: values exactly as stored. */
  private readonly unextended: PrismaClient;

  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    const adapter = new PrismaPg({ connectionString });

    super({ adapter });
    const secrets = new SecretBox(loadSecretKey());
    this.secrets = secrets;
    this.unextended = this;

    // Model calls (and transactions) go through the extended client; this
    // class's own members (lifecycle hooks, the plain client) stay reachable.
    const extended = this.$extends(secretFieldsExtension(secrets));
    const unextended = this.unextended;
    return new Proxy(extended, {
      get(target, property, receiver): unknown {
        return property in target
          ? Reflect.get(target, property, receiver)
          : Reflect.get(unextended, property);
      },
    }) as unknown as this;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.encryptStoredSecrets();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Encrypts secrets saved before encryption (or while there was no key).
   * Reads through the plain client to see what's stored; saving through the
   * extended one encrypts. Never stops the app from starting.
   */
  private async encryptStoredSecrets(): Promise<void> {
    if (!this.secrets.enabled) {
      return;
    }
    let encrypted = 0;
    try {
      for (const model of Object.keys(SECRET_FIELDS) as SecretModel[]) {
        const fields = SECRET_FIELDS[model];
        const stored = await this.plainDelegate(model).findMany();
        for (const row of stored) {
          const plainValues: Row = {};
          for (const field of fields) {
            const value = row[field];
            if (
              typeof value === 'string' &&
              value &&
              !value.startsWith(SECRET_PREFIX)
            ) {
              plainValues[field] = value;
            }
          }
          if (Object.keys(plainValues).length === 0) {
            continue;
          }
          await this.delegate(model).update({
            where: whereFor(model, row),
            data: plainValues,
          });
          encrypted += Object.keys(plainValues).length;
        }
      }
      if (encrypted > 0) {
        this.logger.log(`Encrypted ${encrypted} saved key(s) and token(s).`);
      }
    } catch (error) {
      this.logger.error(
        `Couldn't encrypt saved keys yet; trying again next start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The model through the extension (encrypts what it saves). */
  private delegate(model: SecretModel): Delegate {
    return (this as unknown as Record<string, Delegate>)[model];
  }

  /** The model straight from the database, values as stored. */
  private plainDelegate(model: SecretModel): Delegate {
    return (this.unextended as unknown as Record<string, Delegate>)[model];
  }
}

function whereFor(model: SecretModel, row: Row): Row {
  return model === 'integrationConfig' ? { id: row.id } : { key: row.key };
}
