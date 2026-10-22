import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrganizerSettings } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { canSee } from '../organizer/folder-cleanup.util';
import { OrganizerService } from '../organizer/organizer.service';
import { findRoot, RENAME_TOKENS } from '../organizer/rename.util';
import { mapPath } from '../organizer/whisparr-handoff.service';
import { hasWhisparrTokens } from '../organizer/whisparr-naming.util';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import {
  ProwlarrAdapter,
  ProwlarrAdapterBaseConfig,
} from '../providers/prowlarr/prowlarr.adapter';
import {
  SabnzbdAdapter,
  SabnzbdAdapterBaseConfig,
} from '../providers/sabnzbd/sabnzbd.adapter';
import {
  StashAdapter,
  StashAdapterBaseConfig,
} from '../providers/stash/stash.adapter';
import {
  WhisparrAdapter,
  WhisparrAdapterBaseConfig,
} from '../providers/whisparr/whisparr.adapter';
import {
  SETUP_FIX_ACTIONS,
  SetupCheck,
  SetupCheckResponse,
  SetupFixAction,
  SetupFixResult,
} from './setup-check.types';
import { trimSeparators, trimTrailingSeparators } from '../path-separators';

type CheckBody = Omit<SetupCheck, 'id' | 'title'>;

const HOOK_PATH = '/api/hooks/whisparr/';
const INTEGRATIONS = { label: 'Integrations', route: '/settings/integrations' };
const NEEDS_STASH: CheckBody = {
  status: 'skip',
  summary: 'Needs Stash to be reachable first.',
};
const NEEDS_WHISPARR: CheckBody = {
  status: 'skip',
  summary: 'Needs Whisparr to be reachable first.',
};

/**
 * Looks over how Stash, StashDB, Whisparr and Stashboard are set up together,
 * and says what to change. Each check stands alone: one that can't run is
 * skipped with the reason, never failing the rest.
 */
@Injectable()
export class SetupCheckService {
  private readonly logger = new Logger(SetupCheckService.name);

  /** Whether Stashboard can see a folder. Swapped in tests. */
  see: (folder: string) => Promise<boolean> = canSee;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stash: StashAdapter,
    private readonly whisparr: WhisparrAdapter,
    private readonly catalogProvider: CatalogProviderService,
    private readonly organizer: OrganizerService,
    private readonly prowlarr: ProwlarrAdapter,
    private readonly sabnzbd: SabnzbdAdapter,
  ) {}

  /** origin: Stashboard's address as the browser sees it, for the webhook. */
  async run(origin?: string | null): Promise<SetupCheckResponse> {
    const [stashConfig, whisparrConfig, prowlarrConfig, sabnzbdConfig] =
      await Promise.all([
        this.integration('STASH'),
        this.integration('WHISPARR'),
        this.savedOptional('PROWLARR'),
        this.savedOptional('SABNZBD'),
      ]);
    const [stashCheck, whisparrCheck] = await Promise.all([
      this.guard('stash', 'Stash', () => this.checkStash(stashConfig)),
      this.guard('whisparr', 'Whisparr', () =>
        this.checkWhisparr(whisparrConfig),
      ),
    ]);
    const stash = stashCheck.status === 'ok' ? stashConfig : null;
    const whisparr = whisparrCheck.status === 'ok' ? whisparrConfig : null;
    const [roots, settings] = await Promise.all([
      stash
        ? this.stash.getLibraryRoots(stash).catch(() => null)
        : Promise.resolve(null),
      this.organizer.getSettings().catch(() => null),
    ]);

    const rest = await Promise.all([
      this.guard('stash-boxes', 'StashDB in Stash', () =>
        this.checkStashBoxes(stash),
      ),
      this.guard('library-folders', 'Library folders', () =>
        this.checkLibraryFolders(stash, roots),
      ),
      this.guard('path-mapping', 'Whisparr’s folders in Stash', () =>
        this.checkPathMapping(whisparr, stash ? roots : null, settings),
      ),
      this.guard('import-mode', 'How Whisparr imports', () =>
        this.checkImportMode(whisparr, settings),
      ),
      this.guard('naming', 'File names', () =>
        this.checkNaming(whisparr, settings),
      ),
      this.guard('webhook', 'Whisparr webhook', () =>
        this.checkWebhook(whisparr, origin),
      ),
      this.guard('indexers', 'Indexers', () => this.checkIndexers(whisparr)),
      // Optional, so only checked once it's been added.
      ...(prowlarrConfig
        ? [
            this.guard('prowlarr', 'Prowlarr', () =>
              this.checkProwlarr(prowlarrConfig),
            ),
          ]
        : []),
      ...(sabnzbdConfig
        ? [
            this.guard('sabnzbd', 'SABnzbd', () =>
              this.checkSabnzbd(sabnzbdConfig, stash, roots),
            ),
          ]
        : []),
    ]);

    const checks = [stashCheck, whisparrCheck, ...rest];
    const count = (status: string) =>
      checks.filter((check) => check.status === status).length;
    const failing = checks.filter(
      (check) => check.status === 'fail' || check.status === 'warn',
    );
    this.logger.log(
      `Setup check: ${count('ok')} ok, ${count('warn')} warning(s), ${count('fail')} problem(s), ${count('skip')} skipped${failing.length ? ` (${failing.map((check) => check.title).join(', ')})` : ''}.`,
    );
    return {
      checkedAt: new Date().toISOString(),
      checks,
    };
  }

  async fix(action: string, origin?: string | null): Promise<SetupFixResult> {
    if (!SETUP_FIX_ACTIONS.includes(action as SetupFixAction)) {
      throw new NotFoundException('There’s no automatic fix for that.');
    }
    try {
      const result = await this.runFix(action as SetupFixAction, origin);
      this.logger.log(`Setup fix ${action}: ${result.message}`);
      return result;
    } catch (error) {
      this.logger.warn(`Setup fix ${action} didn't work: ${messageOf(error)}`);
      throw error;
    }
  }

  private runFix(
    action: SetupFixAction,
    origin?: string | null,
  ): Promise<SetupFixResult> {
    switch (action) {
      case 'use-whisparr-naming':
        return this.useWhisparrNaming();
      case 'whisparr-hardlinks':
        return this.turnOnHardlinks();
      case 'whisparr-rename':
        return this.turnOnRenaming();
      case 'whisparr-webhook':
        return this.addWebhook(origin);
    }
  }

  // ---------- checks ----------

  private async checkStash(
    config: StashAdapterBaseConfig | null,
  ): Promise<CheckBody> {
    if (!config) {
      return {
        status: 'fail',
        summary: 'Stash isn’t set up yet.',
        detail: 'Add Stash’s address and API key in Settings → Integrations.',
        link: INTEGRATIONS,
      };
    }
    try {
      const version = await this.stash.getVersion(config);
      return {
        status: 'ok',
        summary: version
          ? `Connected to Stash ${version}.`
          : 'Connected to Stash.',
      };
    } catch (error) {
      return {
        status: 'fail',
        summary: 'Stashboard can’t reach Stash.',
        detail: `${messageOf(error)} Check that Stash is running, and its address and API key in Settings → Integrations.`,
        link: INTEGRATIONS,
      };
    }
  }

  private async checkWhisparr(
    config: WhisparrAdapterBaseConfig | null,
  ): Promise<CheckBody> {
    if (!config) {
      return {
        status: 'fail',
        summary: 'Whisparr isn’t set up yet.',
        detail:
          'Add Whisparr’s address and API key in Settings → Integrations.',
        link: INTEGRATIONS,
      };
    }
    try {
      const { version } = await this.whisparr.getSystemStatus(config);
      return {
        status: 'ok',
        summary: version
          ? `Connected to Whisparr ${version}.`
          : 'Connected to Whisparr.',
      };
    } catch (error) {
      return {
        status: 'fail',
        summary: 'Stashboard can’t reach Whisparr.',
        detail: `${messageOf(error)} Check that Whisparr is running, and its address and API key in Settings → Integrations.`,
        link: INTEGRATIONS,
      };
    }
  }

  /** Reachable, with indexers to search and a download client to send to. */
  private async checkProwlarr(
    config: ProwlarrAdapterBaseConfig,
  ): Promise<CheckBody> {
    let version: string | null;
    try {
      ({ version } = await this.prowlarr.getSystemStatus(config));
    } catch (error) {
      return {
        status: 'fail',
        summary: 'Stashboard can’t reach Prowlarr.',
        detail: `${messageOf(error)} Check that Prowlarr is running, and its address and API key in Settings → Integrations. Until then, Find downloads won’t work.`,
        link: INTEGRATIONS,
      };
    }
    const name = version ? `Prowlarr ${version}` : 'Prowlarr';
    const [indexers, clients] = await Promise.all([
      this.prowlarr.countEnabledIndexers(config).catch(() => null),
      this.prowlarr.listEnabledDownloadClients(config).catch(() => null),
    ]);
    if (indexers === 0) {
      return {
        status: 'warn',
        summary: `Connected to ${name}, but it has no indexers turned on.`,
        detail:
          'Find downloads searches Prowlarr’s indexers. Add or turn one on in Prowlarr under Indexers.',
      };
    }
    if (clients?.length === 0) {
      return {
        status: 'warn',
        summary: `Connected to ${name}, but it has no download client.`,
        detail:
          'Prowlarr sends the release you pick to its own download client. Add one in Prowlarr under Settings → Download Clients.',
      };
    }
    return {
      status: 'ok',
      summary:
        indexers && clients?.length
          ? `Connected to ${name}, with ${indexers} indexer${indexers === 1 ? '' : 's'} and ${clients.join(', ')} for downloads.`
          : `Connected to ${name}.`,
    };
  }

  /**
   * SABnzbd answers and has Stashboard's category; with Finished downloads on,
   * the destination is in Stash's library and Stashboard can see both it and
   * SABnzbd's finished downloads.
   */
  private async checkSabnzbd(
    config: SabnzbdAdapterBaseConfig,
    stash: StashAdapterBaseConfig | null,
    roots: string[] | null,
  ): Promise<CheckBody> {
    let version: string | null;
    try {
      version = await this.sabnzbd.getVersion(config);
    } catch (error) {
      return {
        status: 'fail',
        summary: 'Stashboard can’t reach SABnzbd.',
        detail: `${messageOf(error)} Check that SABnzbd is running, and its address and API key in Settings → Integrations. Until then, finished downloads stay where SABnzbd puts them.`,
        link: INTEGRATIONS,
      };
    }
    const name = version ? `SABnzbd ${version}` : 'SABnzbd';
    const settings = await this.prisma.downloadHandoffSettings
      .findUnique({ where: { key: 'GLOBAL' } })
      .catch(() => null);
    const category = settings?.category?.trim() || 'stashboard';
    const categories = await this.sabnzbd.listCategories(config);
    if (
      !categories.some(
        (entry) => entry.toLowerCase() === category.toLowerCase(),
      )
    ) {
      return {
        status: 'fail',
        summary: `${name} has no “${category}” category.`,
        detail: `Stashboard sends downloads to that category only, so nothing else in SABnzbd is touched. Add it in SABnzbd under Settings → Categories, with a folder of its own (like stashboard-downloads).`,
        link: INTEGRATIONS,
      };
    }
    if (!settings?.enabled) {
      return {
        status: 'ok',
        summary: `Connected to ${name}, with the “${category}” category. Finished downloads is off, so Find downloads still uses Prowlarr’s download client.`,
      };
    }
    const destination = settings.destination;
    if (!destination) {
      return {
        status: 'fail',
        summary: 'Finished downloads is on, but has no destination folder.',
        detail:
          'Pick a folder inside one of Stash’s library folders in Settings → Integrations → SABnzbd.',
        link: INTEGRATIONS,
      };
    }
    if (!stash || !roots) {
      return NEEDS_STASH;
    }
    if (!insideAny(destination, roots)) {
      return {
        status: 'fail',
        summary: `${destination} isn’t inside one of Stash’s library folders.`,
        detail: `Stash wouldn’t find what’s downloaded there. Stash’s library folders: ${roots.join(', ') || 'none'}. Pick one of them (or a folder inside one) in Settings → Integrations → SABnzbd.`,
        link: INTEGRATIONS,
      };
    }
    if (!(await this.see(destination))) {
      return {
        status: 'fail',
        summary: `Stashboard can’t see ${destination}.`,
        detail:
          'Stashboard moves finished downloads there itself, so that folder has to be mounted into Stashboard’s container at the same path Stash uses.',
      };
    }
    const sabFolder = await this.sabnzbd
      .categoryFolder(config, category)
      .catch(() => null);
    if (sabFolder) {
      const mapped = mapPath(
        sabFolder,
        settings.sabPathFrom,
        settings.sabPathTo,
      );
      if (!(await this.see(mapped))) {
        return {
          status: 'fail',
          summary: `Stashboard can’t see SABnzbd’s finished downloads (${mapped}).`,
          detail: `SABnzbd puts “${category}” downloads in ${sabFolder}. Mount that folder into Stashboard’s container, and set the folder mapping in Settings → Integrations → SABnzbd if Stashboard sees it at a different path.`,
          link: INTEGRATIONS,
        };
      }
    } else if (settings.dropIns) {
      // Drop-ins are looked for in that folder, so it has to be known.
      return {
        status: 'fail',
        summary: `SABnzbd didn’t say where its “${category}” downloads go, so files you put there can’t be brought in.`,
        detail:
          'Check the Completed Download Folder and the category’s folder in SABnzbd (Settings → Folders and Settings → Categories).',
        link: INTEGRATIONS,
      };
    }
    return {
      status: 'ok',
      summary:
        `Connected to ${name}. Finished “${category}” downloads go to ${destination}.` +
        (settings.dropIns && sabFolder
          ? ` Files you put in ${mapPath(sabFolder, settings.sabPathFrom, settings.sabPathTo)} are brought in too.`
          : ''),
    };
  }

  private async checkStashBoxes(
    stash: StashAdapterBaseConfig | null,
  ): Promise<CheckBody> {
    if (!stash) {
      return NEEDS_STASH;
    }
    const [boxes, catalog] = await Promise.all([
      this.stash.listStashBoxes(stash),
      this.catalogProvider
        .getConfiguredCatalogProviderOrNull()
        .catch(() => null),
    ]);
    const howTo =
      'In Stash: Settings → Metadata Providers → Stash-box Endpoints → Add, with the address (for StashDB, https://stashdb.org/graphql) and your API key from its profile page.';
    if (boxes.length === 0) {
      return {
        status: 'fail',
        summary: 'Stash has no StashDB set up, so it can’t identify scenes.',
        detail: howTo,
      };
    }
    if (catalog) {
      const wanted = hostOf(catalog.baseUrl);
      const box = boxes.find((entry) => hostOf(entry.endpoint) === wanted);
      if (!box) {
        return {
          status: 'warn',
          summary: `Stash doesn’t have ${catalog.label} set up.`,
          detail: `Stashboard uses ${catalog.label}, but Stash only has ${boxes.map((entry) => entry.name).join(', ')}. ${howTo}`,
        };
      }
      if (!box.apiKey) {
        return {
          status: 'warn',
          summary: `Stash’s ${box.name} has no API key.`,
          detail: `Without a key Stash can’t look scenes up there. ${howTo}`,
        };
      }
    }
    return {
      status: 'ok',
      summary: `Stash can identify scenes with ${boxes.map((entry) => entry.name).join(', ')}.`,
    };
  }

  private async checkLibraryFolders(
    stash: StashAdapterBaseConfig | null,
    roots: string[] | null,
  ): Promise<CheckBody> {
    if (!stash) {
      return NEEDS_STASH;
    }
    if (!roots) {
      return { status: 'skip', summary: 'Couldn’t read Stash’s library.' };
    }
    if (roots.length === 0) {
      return {
        status: 'warn',
        summary: 'Stash has no library folders yet.',
        detail: 'Add your media folders in Stash: Settings → Library.',
      };
    }
    const seen = await Promise.all(roots.map((root) => this.see(root)));
    const missing = roots.filter((_, index) => !seen[index]);
    if (missing.length === 0) {
      return {
        status: 'ok',
        summary:
          roots.length === 1
            ? 'Stashboard can see Stash’s library folder.'
            : `Stashboard can see all ${roots.length} of Stash’s library folders.`,
      };
    }
    return {
      status: 'warn',
      summary:
        missing.length === roots.length
          ? 'Stashboard can’t see Stash’s library folders.'
          : `Stashboard can’t see ${missing.length} of Stash’s ${roots.length} library folders.`,
      detail: `Not found inside Stashboard: ${missing.join(', ')}. Watching for new files and tidying empty folders need them. Mount each into Stashboard at the same path Stash uses. On Unraid: Docker → Stashboard → Edit → Add another Path, with the container path ${missing[0]} and the same host folder Stash uses, then Apply.`,
    };
  }

  private async checkPathMapping(
    whisparr: WhisparrAdapterBaseConfig | null,
    roots: string[] | null,
    settings: OrganizerSettings | null,
  ): Promise<CheckBody> {
    if (!whisparr) {
      return NEEDS_WHISPARR;
    }
    if (!roots) {
      return NEEDS_STASH;
    }
    const folders = await this.whisparr.getRootFolders(whisparr);
    if (folders.length === 0) {
      return {
        status: 'warn',
        summary: 'Whisparr has no root folders.',
        detail:
          'Add one in Whisparr: Settings → Media Management → Root Folders. Pick a folder Stash has in its library.',
      };
    }
    const mapped = folders.map((folder) => ({
      whisparr: folder.path,
      stash: mapPath(
        folder.path,
        settings?.whisparrPathTo,
        settings?.whisparrPathFrom,
      ),
    }));
    const outside = mapped.filter((entry) => !insideAny(entry.stash, roots));
    const mapping =
      settings?.whisparrPathFrom || settings?.whisparrPathTo
        ? `Folder mapping: Whisparr ${settings.whisparrPathTo || '/'} is Stash ${settings.whisparrPathFrom || '/'}.`
        : 'No folder mapping is set, so paths are compared as they are.';
    if (outside.length === 0) {
      return {
        status: 'ok',
        summary: 'Whisparr’s root folders are all in Stash’s library.',
        detail: mapping,
      };
    }
    const listed = outside
      .map((entry) =>
        entry.stash === entry.whisparr
          ? entry.whisparr
          : `${entry.whisparr} (${entry.stash} for Stash)`,
      )
      .join(', ');
    return {
      status: 'warn',
      summary:
        outside.length === 1 && folders.length === 1
          ? 'Whisparr’s root folder isn’t in Stash’s library.'
          : `${outside.length} of Whisparr’s root folders aren’t in Stash’s library.`,
      detail: `${listed}. Stash’s library: ${roots.join(', ') || 'none'}. ${mapping} Scenes Whisparr downloads there won’t show up in Stash. If Stash and Whisparr see the same folder under different paths, set the folder mapping in Settings → Integrations → Whisparr. Otherwise add the folder to Stash’s library.`,
      link: INTEGRATIONS,
    };
  }

  private async checkImportMode(
    whisparr: WhisparrAdapterBaseConfig | null,
    settings: OrganizerSettings | null,
  ): Promise<CheckBody> {
    if (!whisparr) {
      return NEEDS_WHISPARR;
    }
    const media = await this.whisparr.getConfigSection(
      whisparr,
      'mediamanagement',
    );
    const hardlinks = media.copyUsingHardlinks;
    if (typeof hardlinks !== 'boolean') {
      return {
        status: 'skip',
        summary: 'Whisparr didn’t say how it imports downloads.',
      };
    }
    const handoff =
      settings?.whisparrImportMode === 'copy'
        ? ' Stashboard hands files to Whisparr as copies too, so the file Stash had stays where it was.'
        : '';
    if (hardlinks) {
      return {
        status: 'ok',
        summary: 'Whisparr hardlinks finished downloads instead of copying.',
        detail: `Hardlinks take no extra space, but only when the downloads folder and the library are on the same disk or share. Otherwise Whisparr still copies.${handoff}`,
      };
    }
    return {
      status: 'warn',
      summary:
        'Whisparr copies finished torrents, so each scene takes twice the space.',
      detail: `Whisparr copies downloads it can’t move, like torrents still seeding. The original stays in the downloads folder until your download client removes it. With hardlinks on, the copy takes no extra space. In Whisparr: Settings → Media Management → Importing → Use Hardlinks instead of Copy.${handoff}`,
      fix: { label: 'Turn on hardlinks', action: 'whisparr-hardlinks' },
    };
  }

  private async checkNaming(
    whisparr: WhisparrAdapterBaseConfig | null,
    settings: OrganizerSettings | null,
  ): Promise<CheckBody> {
    if (!whisparr) {
      return NEEDS_WHISPARR;
    }
    const naming = await this.whisparr.getConfigSection(whisparr, 'naming');
    const rename = renameFlag(naming);
    if (rename === null) {
      return {
        status: 'skip',
        summary: 'Whisparr didn’t say whether it renames scenes.',
      };
    }
    if (!rename) {
      return {
        status: 'warn',
        summary: 'Whisparr keeps each download’s own file name.',
        detail:
          'Turn on Rename Scenes so Whisparr names every file the same way. In Whisparr: Settings → Media Management → Scene Naming.',
        fix: { label: 'Turn on renaming', action: 'whisparr-rename' },
      };
    }
    const pattern = settings?.renamePattern ?? null;
    if (!pattern) {
      return {
        status: 'ok',
        summary: 'Whisparr renames the scenes it imports.',
      };
    }
    const whisparrPattern = [
      naming.sceneFolderFormat,
      naming.standardSceneFormat,
    ]
      .filter((part): part is string => typeof part === 'string' && !!part)
      .map((part) => trimSeparators(part.trim()))
      .join('/');
    if (
      pattern === whisparrPattern ||
      hasWhisparrTokens(pattern, RENAME_TOKENS)
    ) {
      return {
        status: 'ok',
        summary: 'Whisparr and Stashboard name files the same way.',
      };
    }
    return {
      status: 'warn',
      summary: 'Stashboard names files differently from Whisparr.',
      detail: `Whisparr renames scenes with its own format, but Stashboard’s rename pattern is “${pattern}”. Files Stashboard renames won’t look like Whisparr’s, and Whisparr may rename them again.`,
      fix: { label: 'Use Whisparr’s naming', action: 'use-whisparr-naming' },
      link: { label: 'Organize', route: '/tools/organize' },
    };
  }

  private async checkWebhook(
    whisparr: WhisparrAdapterBaseConfig | null,
    origin?: string | null,
  ): Promise<CheckBody> {
    if (!whisparr) {
      return NEEDS_WHISPARR;
    }
    const [token, notifications] = await Promise.all([
      this.webhookToken(false),
      this.whisparr.listNotifications(whisparr),
    ]);
    const hooks = notifications.filter((entry) =>
      (fieldValue(entry, 'url') ?? '').includes(HOOK_PATH),
    );
    const current = token
      ? hooks.find((entry) =>
          (fieldValue(entry, 'url') ?? '').includes(`${HOOK_PATH}${token}`),
        )
      : undefined;
    const address = webhookAddress(origin, token);
    const canFix = usableOrigin(origin) !== null;
    const howTo = `In Whisparr: Settings → Connect → + → Webhook, with the URL ${address}, method POST, and On Import and On Upgrade ticked.`;
    const automation = { label: 'Automation', route: '/settings/automation' };

    if (current && current.onDownload !== false) {
      return {
        status: 'ok',
        summary: 'Whisparr tells Stashboard as soon as it imports a scene.',
      };
    }
    if (current) {
      return {
        status: 'warn',
        summary: 'Whisparr’s webhook to Stashboard is off for imports.',
        detail: `Tick On Import in Whisparr: Settings → Connect → ${typeof current.name === 'string' ? current.name : 'Webhook'}.`,
        ...(canFix
          ? { fix: { label: 'Turn it on', action: 'whisparr-webhook' } }
          : {}),
      };
    }
    if (hooks.length > 0) {
      return {
        status: 'warn',
        summary: 'Whisparr’s webhook uses an old Stashboard address.',
        detail: `The address changed (a new one was made in Settings → Automation). Update the URL to ${address}.`,
        ...(canFix
          ? { fix: { label: 'Update it', action: 'whisparr-webhook' } }
          : {}),
        link: automation,
      };
    }
    return {
      status: 'warn',
      summary: 'Whisparr doesn’t tell Stashboard when it imports a scene.',
      detail: `Without the webhook, Stashboard notices new scenes within a few minutes instead of right away. ${howTo}`,
      ...(canFix
        ? { fix: { label: 'Add it to Whisparr', action: 'whisparr-webhook' } }
        : {}),
      link: automation,
    };
  }

  private async checkIndexers(
    whisparr: WhisparrAdapterBaseConfig | null,
  ): Promise<CheckBody> {
    if (!whisparr) {
      return NEEDS_WHISPARR;
    }
    const health = await this.whisparr.getIndexerHealth(whisparr);
    if (health.searchable === 0) {
      return {
        status: 'fail',
        summary: 'Whisparr has no indexers it can search.',
        detail:
          'Without one, Whisparr can’t find downloads. Add one in Whisparr: Settings → Indexers (or through Prowlarr), with searching turned on.',
      };
    }
    if (health.paused.length > 0) {
      return {
        status: 'warn',
        summary:
          health.paused.length === 1
            ? 'One of Whisparr’s indexers is paused after errors.'
            : `${health.paused.length} of Whisparr’s indexers are paused after errors.`,
        detail: `${health.paused
          .map((entry) => `${entry.name} until ${formatTime(entry.until)}`)
          .join(
            ', ',
          )}. Whisparr tries them again then. Check them in Whisparr: System → Status.`,
      };
    }
    return {
      status: 'ok',
      summary:
        health.searchable === 1
          ? 'Whisparr can search 1 indexer.'
          : `Whisparr can search ${health.searchable} indexers.`,
    };
  }

  // ---------- fixes ----------

  private async useWhisparrNaming(): Promise<SetupFixResult> {
    const naming = await this.organizer.whisparrNaming();
    if (!naming) {
      throw new ConflictException(
        'Set up Whisparr in Settings → Integrations first.',
      );
    }
    if (!naming.pattern) {
      throw new BadRequestException(
        naming.problem ?? 'Couldn’t use Whisparr’s naming.',
      );
    }
    await this.organizer.updateSettings({ renamePattern: naming.pattern });
    return {
      ok: true,
      message: `Stashboard now names files like Whisparr: ${naming.pattern}`,
    };
  }

  private async turnOnHardlinks(): Promise<SetupFixResult> {
    const whisparr = await this.requireWhisparr();
    const media = await this.whisparr.getConfigSection(
      whisparr,
      'mediamanagement',
    );
    if (media.copyUsingHardlinks !== true) {
      await this.whisparr.updateConfigSection(whisparr, 'mediamanagement', {
        ...media,
        copyUsingHardlinks: true,
      });
    }
    return { ok: true, message: 'Whisparr now uses hardlinks.' };
  }

  private async turnOnRenaming(): Promise<SetupFixResult> {
    const whisparr = await this.requireWhisparr();
    const naming = await this.whisparr.getConfigSection(whisparr, 'naming');
    if (renameFlag(naming) !== true) {
      await this.whisparr.updateConfigSection(whisparr, 'naming', {
        ...naming,
        ...('renameMovies' in naming ? { renameMovies: true } : {}),
        renameScenes: true,
      });
    }
    return { ok: true, message: 'Whisparr now renames scenes it imports.' };
  }

  private async addWebhook(origin?: string | null): Promise<SetupFixResult> {
    const base = usableOrigin(origin);
    const whisparr = await this.requireWhisparr();
    const token = await this.webhookToken(true);
    if (!base || !token) {
      throw new BadRequestException(
        `Stashboard doesn’t know an address Whisparr can reach it on. Open Stashboard by its network address (not localhost), or add the webhook in Whisparr yourself: Settings → Connect → + → Webhook, URL ${webhookAddress(origin, token)}, method POST.`,
      );
    }
    const url = `${base}${HOOK_PATH}${token}`;
    const notifications = await this.whisparr.listNotifications(whisparr);
    const urlOf = (entry: Record<string, unknown>) =>
      fieldValue(entry, 'url') ?? '';
    const existing =
      notifications.find((entry) => urlOf(entry).includes(url)) ??
      notifications.find((entry) => urlOf(entry).includes(HOOK_PATH));
    if (existing) {
      await this.whisparr.saveNotification(whisparr, {
        ...existing,
        onDownload: true,
        onUpgrade: true,
        fields: withField(existing.fields, 'url', url),
      });
      return {
        ok: true,
        message: 'Whisparr’s webhook to Stashboard is fixed.',
      };
    }
    const schema = await this.whisparr.getNotificationSchema(whisparr);
    const template = schema.find(
      (entry) => String(entry.implementation).toLowerCase() === 'webhook',
    );
    if (!template) {
      throw new BadRequestException(
        `This Whisparr has no webhook connection. Add it yourself: URL ${url}, method POST.`,
      );
    }
    const body: Record<string, unknown> = {
      ...template,
      name: 'Stashboard',
      onDownload: true,
      onUpgrade: true,
      fields: withField(withField(template.fields, 'url', url), 'method', 1),
    };
    delete body.id;
    delete body.presets;
    await this.whisparr.saveNotification(whisparr, body);
    return {
      ok: true,
      message: 'Whisparr now tells Stashboard when it imports a scene.',
    };
  }

  // ---------- helpers ----------

  private async guard(
    id: string,
    title: string,
    check: () => Promise<CheckBody>,
  ): Promise<SetupCheck> {
    try {
      return { id, title, ...(await check()) };
    } catch (error) {
      this.logger.warn(
        `Setup check “${title}” couldn't run: ${messageOf(error)}`,
      );
      return {
        id,
        title,
        status: 'skip',
        summary: 'Couldn’t check this right now.',
        detail: messageOf(error),
      };
    }
  }

  private async integration(
    type: 'STASH' | 'WHISPARR',
  ): Promise<{ baseUrl: string; apiKey: string | null } | null> {
    const integration = await this.prisma.integrationConfig
      .findUnique({ where: { type } })
      .catch(() => null);
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== 'CONFIGURED' ||
      !baseUrl
    ) {
      return null;
    }
    return { baseUrl, apiKey: integration.apiKey };
  }

  /** Prowlarr or SABnzbd once it's been added (even if its last test failed). */
  private async savedOptional(
    type: 'PROWLARR' | 'SABNZBD',
  ): Promise<ProwlarrAdapterBaseConfig | null> {
    const integration = await this.prisma.integrationConfig
      .findUnique({ where: { type } })
      .catch(() => null);
    const baseUrl = integration?.baseUrl?.trim();
    return integration?.enabled && baseUrl
      ? { baseUrl, apiKey: integration.apiKey }
      : null;
  }

  private async requireWhisparr(): Promise<WhisparrAdapterBaseConfig> {
    const config = await this.integration('WHISPARR');
    if (!config) {
      throw new ConflictException(
        'Set up Whisparr in Settings → Integrations first.',
      );
    }
    return config;
  }

  /** The secret in the webhook address; made (as Automation would) when asked to. */
  private async webhookToken(create: boolean): Promise<string | null> {
    const existing = await this.prisma.libraryAutomationSettings.findUnique({
      where: { key: 'GLOBAL' },
    });
    if (existing || !create) {
      return existing?.webhookToken ?? null;
    }
    const created = await this.prisma.libraryAutomationSettings.upsert({
      where: { key: 'GLOBAL' },
      create: { key: 'GLOBAL', webhookToken: randomBytes(24).toString('hex') },
      update: {},
    });
    return created.webhookToken;
  }
}

function messageOf(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';
  return /[.!?…]$/.test(message.trim()) ? message.trim() : `${message.trim()}.`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function trimSlash(path: string): string {
  return trimTrailingSeparators(path) || path;
}

/** True when path is one of the roots or inside one. */
export function insideAny(path: string, roots: string[]): boolean {
  const clean = trimSlash(path);
  return (
    roots.some((root) => trimSlash(root) === clean) ||
    findRoot(clean, roots) !== null
  );
}

/** Whisparr's "rename scenes" switch (older builds call it renameMovies). */
function renameFlag(naming: Record<string, unknown>): boolean | null {
  const value = naming.renameScenes ?? naming.renameMovies;
  return typeof value === 'boolean' ? value : null;
}

function fieldValue(
  entry: Record<string, unknown>,
  name: string,
): string | null {
  const fields = Array.isArray(entry.fields) ? entry.fields : [];
  const field = fields.find(
    (item: unknown): item is { name: unknown; value: unknown } =>
      !!item &&
      typeof item === 'object' &&
      (item as { name?: unknown }).name === name,
  );
  return typeof field?.value === 'string' ? field.value : null;
}

function withField(fields: unknown, name: string, value: unknown): unknown[] {
  const list = Array.isArray(fields) ? [...(fields as unknown[])] : [];
  const index = list.findIndex(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      (item as { name?: unknown }).name === name,
  );
  if (index >= 0) {
    list[index] = { ...(list[index] as object), value };
  } else {
    list.push({ name, value });
  }
  return list;
}

/** Stashboard's address, when Whisparr could reach it (not localhost). */
export function usableOrigin(origin?: string | null): string | null {
  if (!origin) {
    return null;
  }
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host.startsWith('127.') ||
      host === '0.0.0.0'
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function webhookAddress(
  origin: string | null | undefined,
  token: string | null,
): string {
  const base = usableOrigin(origin) ?? '<Stashboard’s address>';
  return token
    ? `${base}${HOOK_PATH}${token}`
    : `${base}${HOOK_PATH}… (shown in Settings → Automation)`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
