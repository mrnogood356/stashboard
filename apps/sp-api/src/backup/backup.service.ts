import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IntegrationStatus, IntegrationType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AppearanceService } from '../appearance/appearance.service';
import { UpdateAppearanceDto } from '../appearance/dto/appearance.dto';
import { UpdateAutomationDto } from '../automation/automation.controller';
import { AutomationService } from '../automation/automation.service';
import { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import { UpdateDownloadHandoffDto } from '../download-handoff/dto/update-download-handoff.dto';
import { resolveAppVersion } from '../health/health.controller';
import { UpdateHiddenContentSettingsDto } from '../hidden-content/dto/hidden-content-settings.dto';
import { HiddenContentService } from '../hidden-content/hidden-content.service';
import { UpdateIntegrationDto } from '../integrations/dto/update-integration.dto';
import {
  IntegrationsService,
  integrationLabel,
} from '../integrations/integrations.service';
import { UpdateLogSettingsDto } from '../logs/dto/logs.dto';
import { LogsService } from '../logs/logs.service';
import { UpdateNotificationSettingsDto } from '../notifications/dto/notification-settings.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { UpdateOrganizerSettingsDto } from '../organizer/dto/organizer.dto';
import { OrganizerService } from '../organizer/organizer.service';
import { UpdatePlaybackSettingsDto } from '../playback/dto/playback-settings.dto';
import { PlaybackSettingsService } from '../playback/playback-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { instanceCatalogProviderTypeFromIntegrations } from '../providers/catalog/catalog-provider.util';

export const BACKUP_FORMAT = 'stashboard-settings';
export const BACKUP_FORMAT_VERSION = 1;

type Values = Record<string, unknown>;

export interface SettingsBackup {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  /** Whether API keys, tokens and webhook links are in the file. */
  includesSecrets: boolean;
  settings: {
    integrations?: Values[];
    [section: string]: Values | Values[] | undefined;
  };
}

export type RestoreStatus = 'restored' | 'warning' | 'failed';

export interface RestoreResult {
  id: string;
  label: string;
  status: RestoreStatus;
  message: string | null;
}

export interface RestoreResponse {
  results: RestoreResult[];
}

/**
 * One settings page in the backup: the fields it keeps (the same ones its
 * page saves), which of them are secrets, and how to read and save them. Saving
 * goes through the page's own service, so a restored value gets the same
 * checks as one typed in.
 */
interface Section<T extends object = object> {
  id: string;
  label: string;
  dto: new () => T;
  fields: readonly string[];
  secretFields?: readonly string[];
  read(): Promise<Values>;
  /** Saves values the DTO's checks have passed. */
  write(values: T): Promise<unknown>;
}

function defineSection<T extends object>(section: Section<T>): Section {
  return section;
}

const INTEGRATION_FIELDS = ['enabled', 'name', 'baseUrl', 'apiKey'] as const;
const INTEGRATION_TYPES = new Set<string>(Object.values(IntegrationType));
const WEBHOOK_TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;

/**
 * Settings → Backup: every setting as one JSON file, and putting such a file
 * back. Library data (the scene index, requests, activity) and the account
 * aren't in it: they come back from Stash and Whisparr, or belong to this
 * install. Restoring changes only what the file has; a section that can't be
 * saved (a folder that doesn't exist here, say) is reported and skipped, and
 * the rest still goes in.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);
  private readonly sections: readonly Section[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly automation: AutomationService,
    notifications: NotificationsService,
    organizer: OrganizerService,
    handoff: DownloadHandoffService,
    hidden: HiddenContentService,
    appearance: AppearanceService,
    playback: PlaybackSettingsService,
    logs: LogsService,
  ) {
    this.sections = [
      defineSection({
        id: 'notifications',
        label: 'Notifications',
        dto: UpdateNotificationSettingsDto,
        fields: [
          'enabled',
          'channel',
          'url',
          'token',
          'userKey',
          'notifyDownloading',
          'notifyAvailable',
          'notifyFailed',
        ],
        // A Discord or ntfy link is as good as a password to whoever has it.
        secretFields: ['url', 'token', 'userKey'],
        read: async () => ({ ...(await notifications.getSettings()) }),
        write: (values) => notifications.updateSettings(values),
      }),
      defineSection({
        id: 'automation',
        label: 'Automation',
        dto: UpdateAutomationDto,
        fields: [
          'scanOnImport',
          'identifyNew',
          'generateNew',
          'removeSamples',
          'watchFolders',
          'tidyAfterImport',
        ],
        read: async () => ({ ...(await automation.getSettingsDto()) }),
        write: (values) => automation.updateSettings(values),
      }),
      defineSection({
        id: 'organizer',
        label: 'Match & rename',
        dto: UpdateOrganizerSettingsDto,
        fields: [
          'renamePattern',
          'renameRoot',
          'renameAfterMatch',
          'moveUnmatched',
          'cleanEmptyFolders',
          'keepFolders',
          'skipWhisparrFiles',
          'autoMatchNightly',
          'useStashScrapers',
          'tpdbApiKey',
          'sendToWhisparr',
          'addToWhisparr',
          'whisparrImportMode',
          'whisparrPathFrom',
          'whisparrPathTo',
        ],
        secretFields: ['tpdbApiKey'],
        read: async () => ({
          ...(await organizer.getSettingsDto()),
          // The page only says whether a key is saved.
          tpdbApiKey: (await organizer.getSettings()).tpdbApiKey,
        }),
        write: (values) => organizer.updateSettings(values),
      }),
      defineSection({
        id: 'downloads',
        label: 'Finished downloads',
        dto: UpdateDownloadHandoffDto,
        fields: [
          'enabled',
          'category',
          'destination',
          'sabPathFrom',
          'sabPathTo',
          'importMode',
          'dropIns',
          'sabManualJobs',
        ],
        read: async () => ({ ...(await handoff.getSettingsDto()) }),
        write: (values) => handoff.updateSettings(values),
      }),
      defineSection({
        id: 'hidden',
        label: 'Hidden',
        dto: UpdateHiddenContentSettingsDto,
        fields: ['words', 'tags', 'studios', 'performers', 'hideOwned'],
        read: async () => ({ ...(await hidden.getSettings()) }),
        write: (values) => hidden.updateSettings(values),
      }),
      defineSection({
        id: 'appearance',
        label: 'Appearance',
        dto: UpdateAppearanceDto,
        fields: [
          'mode',
          'lightTheme',
          'darkTheme',
          'accentColor',
          'radius',
          'density',
          'fontScale',
          'material',
          'customCss',
        ],
        read: async () => ({ ...(await appearance.get()) }),
        write: (values) => appearance.update(values),
      }),
      defineSection({
        id: 'playback',
        label: 'Playback',
        dto: UpdatePlaybackSettingsDto,
        fields: ['enabled', 'feedEnabled', 'previewsEnabled'],
        read: async () => ({ ...(await playback.get()) }),
        write: (values) => playback.update(values),
      }),
      defineSection({
        id: 'logs',
        label: 'Logs',
        dto: UpdateLogSettingsDto,
        fields: ['level', 'fileEnabled'],
        read: async () => ({ ...(await logs.settings()) }),
        write: (values) => logs.updateSettings(values),
      }),
    ];
  }

  async export(includeSecrets: boolean): Promise<SettingsBackup> {
    const settings: SettingsBackup['settings'] = {
      integrations: await this.exportIntegrations(includeSecrets),
    };
    for (const section of this.sections) {
      const values = pick(
        await section.read(),
        section.fields.filter(
          (field) => includeSecrets || !section.secretFields?.includes(field),
        ),
      );
      settings[section.id] = values;
    }
    if (includeSecrets) {
      // The secret in the link Whisparr calls; without it, Whisparr would
      // need the new link pasted in after a restore.
      const automation = settings.automation as Values;
      automation.webhookToken = (
        await this.automation.getSettings()
      ).webhookToken;
    }
    this.logger.log(
      `Settings exported${includeSecrets ? ' with keys and tokens' : ' without keys and tokens'}.`,
    );
    return {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: resolveAppVersion(),
      exportedAt: new Date().toISOString(),
      includesSecrets: includeSecrets,
      settings,
    };
  }

  /**
   * Checks the whole file before changing anything: one bad value and nothing
   * is restored. Then saves each section in turn; integrations go first (and
   * are tested, like Save & test), because other sections check folders
   * against Stash.
   */
  async restore(file: unknown): Promise<RestoreResponse> {
    const settings = readBackup(file);
    const plan: Array<{ section: Section; values: object }> = [];
    const problems: string[] = [];

    const integrations = await this.planIntegrations(
      settings.integrations,
      problems,
    );
    for (const section of this.sections) {
      const fromFile = settings[section.id];
      if (fromFile === undefined) {
        continue;
      }
      if (!isRecord(fromFile)) {
        problems.push(`${section.label}: not a list of settings.`);
        continue;
      }
      // Anything the file leaves out keeps its current value.
      const values = {
        ...pick(await section.read(), section.fields),
        ...pick(fromFile, section.fields),
      };
      const checked = await check(section.dto, values);
      if (typeof checked === 'string') {
        problems.push(`${section.label}: ${checked}`);
        continue;
      }
      plan.push({ section, values: checked });
    }
    const webhookToken = settings.automation
      ? (settings.automation as Values).webhookToken
      : undefined;
    if (
      webhookToken !== undefined &&
      (typeof webhookToken !== 'string' ||
        !WEBHOOK_TOKEN_PATTERN.test(webhookToken))
    ) {
      problems.push('Automation: the Whisparr webhook token isn’t valid.');
    }
    if (problems.length > 0) {
      throw new BadRequestException(
        `Nothing was restored. ${problems.join(' ')}`,
      );
    }

    const results: RestoreResult[] = [];
    for (const { type, values } of integrations) {
      results.push(await this.restoreIntegration(type, values));
    }
    for (const { section, values } of plan) {
      try {
        await section.write(values);
        results.push({
          id: section.id,
          label: section.label,
          status: 'restored',
          message: null,
        });
      } catch (error) {
        results.push({
          id: section.id,
          label: section.label,
          status: 'failed',
          message: errorMessage(error),
        });
      }
    }
    if (typeof webhookToken === 'string') {
      await this.automation.getSettings();
      await this.prisma.libraryAutomationSettings.update({
        where: { key: 'GLOBAL' },
        data: { webhookToken },
      });
    }

    const failed = results.filter((result) => result.status !== 'restored');
    this.logger.log(
      `Settings restored from a backup: ${results.length - failed.length} of ${results.length} part(s) went in${
        failed.length > 0
          ? `; ${failed.map((result) => `${result.label}: ${result.message}`).join('; ')}`
          : ''
      }.`,
    );
    return { results };
  }

  /** What's been set up, with this install's catalog first. */
  private async exportIntegrations(includeSecrets: boolean): Promise<Values[]> {
    const rows = await this.prisma.integrationConfig.findMany({
      orderBy: { type: 'asc' },
    });
    const catalog = instanceCatalogProviderTypeFromIntegrations(rows);
    return rows
      .filter((row) => row.baseUrl || row.apiKey)
      .sort((a, b) => Number(b.type === catalog) - Number(a.type === catalog))
      .map((row) =>
        pick(
          row,
          ['type', ...INTEGRATION_FIELDS].filter(
            (field) => includeSecrets || field !== 'apiKey',
          ),
        ),
      );
  }

  private async planIntegrations(
    fromFile: unknown,
    problems: string[],
  ): Promise<Array<{ type: IntegrationType; values: UpdateIntegrationDto }>> {
    if (fromFile === undefined) {
      return [];
    }
    if (!Array.isArray(fromFile)) {
      problems.push('Integrations: not a list.');
      return [];
    }
    const plan: Array<{ type: IntegrationType; values: UpdateIntegrationDto }> =
      [];
    for (const entry of fromFile) {
      const type = isRecord(entry) ? entry.type : undefined;
      if (typeof type !== 'string' || !INTEGRATION_TYPES.has(type)) {
        problems.push(`Integrations: “${String(type)}” isn’t a known service.`);
        continue;
      }
      const checked = await check(
        UpdateIntegrationDto,
        pick(entry as Values, INTEGRATION_FIELDS),
      );
      if (typeof checked === 'string') {
        problems.push(
          `${integrationLabel(type as IntegrationType)}: ${checked}`,
        );
        continue;
      }
      plan.push({ type: type as IntegrationType, values: checked });
    }
    return plan;
  }

  /** Saves and tests it, so a service that's down here is said straight away. */
  private async restoreIntegration(
    type: IntegrationType,
    values: UpdateIntegrationDto,
  ): Promise<RestoreResult> {
    const label = integrationLabel(type);
    try {
      const saved = await this.integrations.testIntegration(type, values);
      return saved.status === IntegrationStatus.ERROR
        ? {
            id: `integration-${type}`,
            label,
            status: 'warning',
            message: `Saved, but couldn’t connect: ${saved.lastErrorMessage ?? 'no answer'}`,
          }
        : {
            id: `integration-${type}`,
            label,
            status: 'restored',
            message: null,
          };
    } catch (error) {
      return {
        id: `integration-${type}`,
        label,
        status: 'failed',
        message: errorMessage(error),
      };
    }
  }
}

function readBackup(file: unknown): SettingsBackup['settings'] {
  if (!isRecord(file) || file.format !== BACKUP_FORMAT) {
    throw new BadRequestException('This isn’t a Stashboard settings backup.');
  }
  if (
    typeof file.formatVersion !== 'number' ||
    file.formatVersion > BACKUP_FORMAT_VERSION
  ) {
    throw new BadRequestException(
      'This backup is from a newer Stashboard. Update Stashboard, then restore it.',
    );
  }
  if (!isRecord(file.settings)) {
    throw new BadRequestException('The backup has no settings in it.');
  }
  return file.settings as SettingsBackup['settings'];
}

/** The named fields that have a value; null and undefined are left out. */
function pick(values: Values, fields: readonly string[]): Values {
  const picked: Values = {};
  for (const field of fields) {
    const value = values[field];
    if (value !== undefined && value !== null) {
      picked[field] = value;
    }
  }
  return picked;
}

/**
 * The values as the DTO, once its checks (the page's own) pass; otherwise the
 * first thing they refuse, in words.
 */
async function check<T extends object>(
  dto: new () => T,
  values: Values,
): Promise<T | string> {
  const instance = plainToInstance(dto, values);
  const errors = await validate(instance, { forbidUnknownValues: false });
  if (errors.length === 0) {
    return instance;
  }
  const first = errors[0];
  const constraint = first.constraints
    ? Object.values(first.constraints)[0]
    : null;
  return constraint ?? `${first.property} isn’t valid.`;
}

function isRecord(value: unknown): value is Values {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof BadRequestException) {
    const response = error.getResponse();
    if (isRecord(response) && typeof response.message === 'string') {
      return response.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
