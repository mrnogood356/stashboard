import { Prisma } from '@prisma/client';
import { SECRET_FIELDS, type SecretBox, type SecretModel } from './secret-box';

type Row = Record<string, unknown>;

const LABELS: Record<SecretModel, string> = {
  integrationConfig: 'integration API key',
  notificationSettings: 'notification link or token',
  organizerSettings: 'ThePornDB key',
  libraryAutomationSettings: 'Whisparr webhook token',
};

/**
 * Encrypts the secret columns (SECRET_FIELDS) on every write and decrypts
 * them on every read, inside transactions too, so the rest of Stashboard
 * only ever sees plain values.
 */
export function secretFieldsExtension(box: SecretBox) {
  const handle = (model: SecretModel) => ({
    seal: <T>(args: T): T =>
      sealArgs(args as Row, SECRET_FIELDS[model], box) as T,
    open: (result: unknown): unknown =>
      openResult(result, SECRET_FIELDS[model], box, LABELS[model]),
  });
  const integration = handle('integrationConfig');
  const notification = handle('notificationSettings');
  const organizer = handle('organizerSettings');
  const automation = handle('libraryAutomationSettings');

  return Prisma.defineExtension({
    name: 'secret-fields',
    query: {
      integrationConfig: {
        async $allOperations({ args, query }) {
          return integration.open(await query(integration.seal(args)));
        },
      },
      notificationSettings: {
        async $allOperations({ args, query }) {
          return notification.open(await query(notification.seal(args)));
        },
      },
      organizerSettings: {
        async $allOperations({ args, query }) {
          return organizer.open(await query(organizer.seal(args)));
        },
      },
      libraryAutomationSettings: {
        async $allOperations({ args, query }) {
          return automation.open(await query(automation.seal(args)));
        },
      },
    },
  });
}

/** data, create and update (single or many) with their secrets encrypted. */
function sealArgs(args: Row, fields: readonly string[], box: SecretBox): Row {
  if (!args || typeof args !== 'object') {
    return args;
  }
  const sealed: Row = { ...args };
  for (const key of ['data', 'create', 'update']) {
    const value = sealed[key];
    if (Array.isArray(value)) {
      sealed[key] = value.map((row) => sealRow(row as Row, fields, box));
    } else if (value && typeof value === 'object') {
      sealed[key] = sealRow(value as Row, fields, box);
    }
  }
  return sealed;
}

function sealRow(row: Row, fields: readonly string[], box: SecretBox): Row {
  const sealed: Row = { ...row };
  for (const field of fields) {
    const value = sealed[field];
    if (typeof value === 'string') {
      sealed[field] = box.encrypt(value);
    } else if (
      value &&
      typeof value === 'object' &&
      typeof (value as Row).set === 'string'
    ) {
      sealed[field] = { set: box.encrypt((value as Row).set as string) };
    }
  }
  return sealed;
}

function openResult(
  result: unknown,
  fields: readonly string[],
  box: SecretBox,
  label: string,
): unknown {
  if (Array.isArray(result)) {
    return result.map((row) => openResult(row, fields, box, label));
  }
  if (!result || typeof result !== 'object') {
    return result;
  }
  const row = result as Row;
  for (const field of fields) {
    if (typeof row[field] === 'string') {
      row[field] = box.decrypt(row[field], label);
    }
  }
  return row;
}
