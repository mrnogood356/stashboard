import { Injectable } from '@nestjs/common';
import { DownloadHandoff, SceneIndex, SceneLifecycle } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import type { ActivityEntryDto } from '../activity/activity.model';
import { OrganizerService } from '../organizer/organizer.service';
import type { RenamePlanDto, RenameState } from '../organizer/organizer.model';
import { labelFor, messageOf } from '../organizer/organizer-plan.util';
import { splitPath } from '../organizer/rename.util';
import { PrismaService } from '../prisma/prisma.service';
import type { StashOrganizerScene } from '../providers/stash/stash.adapter';
import { sameSceneIds } from './same-scene.util';
import type {
  EvidenceFact,
  EvidenceGroup,
  EvidenceSection,
  SceneEvidenceDto,
} from './scene-evidence.model';

/** Downloads sent to SABnzbd shown for one scene. */
const MAX_DOWNLOADS = 3;

const DOWNLOAD_STATUS: Record<string, string> = {
  sent: 'Sent to SABnzbd',
  downloading: 'Downloading in SABnzbd',
  completed: 'Moved into your library; waiting for Stash',
  imported: 'In your library and linked',
  failed: 'Failed',
  ignored: 'No longer watched',
};

/** Stash scenes whose rename plan is worked out (a scene rarely has more). */
const MAX_RENAME_SCENES = 5;

/** What a lookup gave, or why it failed; one failure never hides the rest. */
interface Attempt<T> {
  value: T | null;
  error: string | null;
}

type WhisparrFile = Awaited<ReturnType<OrganizerService['whisparrFileFor']>>;
type RenamePlans = Awaited<ReturnType<OrganizerService['renamePlansFor']>>;

/**
 * "Why is it like this?" for one scene: what Stashboard's index, Whisparr,
 * Stash, the rename preview and the activity log say about it, as plain
 * facts. Reuses the organizer's own checks, so it says what they'd do.
 * Only looks; nothing is fixed, linked or refreshed.
 */
@Injectable()
export class SceneEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizer: OrganizerService,
    private readonly activity: ActivityService,
  ) {}

  /** A StashDB/FansDB scene, by its catalog id. */
  async forCatalogScene(stashId: string): Promise<SceneEvidenceDto> {
    const id = stashId.trim();
    const [row, ids, catalog] = await Promise.all([
      attempt(() =>
        this.prisma.sceneIndex.findUnique({ where: { stashId: id } }),
      ),
      this.sameSceneIds(id),
      attempt(() => this.organizer.primaryCatalog()),
    ]);
    const [stash, whisparr, downloads] = await Promise.all([
      attempt(() => this.organizer.stashScenesLinkedTo(ids)),
      attempt(() => this.organizer.whisparrFileFor(ids)),
      this.downloadsFor(ids),
    ]);
    const scenes = stash.value ?? [];
    const [rename, reason] = await Promise.all([
      scenes.length > 0
        ? attempt(() =>
            this.organizer.renamePlansFor(
              scenes.slice(0, MAX_RENAME_SCENES).map((scene) => scene.id),
            ),
          )
        : // Without Stash's scenes there's nothing to plan; say why if it failed.
          Promise.resolve<Attempt<RenamePlans>>({
            value: null,
            error: stash.error,
          }),
      this.reasonFor(row.value),
    ]);
    const title = row.value?.title ?? scenes[0]?.title ?? null;
    const activity = await attempt(() =>
      this.activity.mentioning(mentions(title, scenes, whisparr.value)),
    );
    const catalogName = catalog.value?.name ?? 'the catalog';
    return {
      kind: 'catalog',
      id,
      title,
      checkedAt: new Date().toISOString(),
      sections: [
        statusSection(row, reason, null),
        whisparrSection(id, row.value, whisparr),
        ...downloadsSection(downloads),
        stashSection(stash, {
          summary:
            scenes.length === 0
              ? `No Stash scene is linked to this ${catalogName} scene.`
              : scenes.length === 1
                ? `One Stash scene is linked to it.`
                : `${scenes.length} Stash scenes are linked to it.`,
        }),
        renameSection(rename),
        activitySection(activity),
      ],
    };
  }

  /** A scene in your Stash library, by its Stash id. */
  async forLocalScene(sceneId: string): Promise<SceneEvidenceDto> {
    const id = sceneId.trim();
    const [scene, catalog, projected] = await Promise.all([
      attempt(() => this.organizer.stashScene(id)),
      attempt(() => this.organizer.primaryCatalog()),
      this.prisma.librarySceneIndex
        .findUnique({
          where: { stashSceneId: id },
          select: { linkedStashId: true },
        })
        .catch(() => null),
    ]);
    const catalogName = catalog.value?.name ?? 'the catalog';
    const paths = scene.value?.files.map((file) => file.path) ?? [];
    // Stash's own link first; the library index remembers it when Stash can't be asked.
    const linked =
      scene.value?.stashIds.find(
        (entry) => entry.endpoint === catalog.value?.endpoint,
      )?.stashId ??
      projected?.linkedStashId ??
      null;
    const ids = linked ? await this.sameSceneIds(linked) : [];
    const whisparr = await attempt(() =>
      this.organizer.whisparrFileFor(ids, paths),
    );
    // Not linked, but Whisparr imported this very file for a scene: that one.
    const catalogId = linked ?? whisparr.value?.stashId ?? null;
    const [row, rename] = await Promise.all([
      catalogId
        ? attempt(() =>
            this.prisma.sceneIndex.findUnique({
              where: { stashId: catalogId },
            }),
          )
        : Promise.resolve({ value: null, error: null }),
      attempt(() => this.organizer.renamePlansFor([id])),
    ]);
    const reason = await this.reasonFor(row.value);
    const title = scene.value?.title ?? row.value?.title ?? null;
    const scenes = scene.value ? [scene.value] : [];
    const activity = await attempt(() =>
      this.activity.mentioning(mentions(title, scenes, whisparr.value)),
    );
    return {
      kind: 'local',
      id,
      title,
      checkedAt: new Date().toISOString(),
      sections: [
        statusSection(
          row,
          reason,
          catalogId
            ? null
            : `Not linked to ${catalogName}, so Stashboard tracks no status for it. Match it in Library Tools to link it.`,
        ),
        whisparrSection(catalogId, row.value, whisparr),
        stashSection(
          { value: scenes, error: scene.error },
          {
            summary: !scene.value
              ? `Stash has no scene ${id} any more.`
              : linked
                ? `Linked to ${catalogName} scene ${linked}.`
                : `Not linked to ${catalogName}.`,
          },
        ),
        renameSection(rename),
        activitySection(activity),
      ],
    };
  }

  /** Downloads Finished downloads sent to SABnzbd for this scene, newest first. */
  private downloadsFor(ids: string[]): Promise<Attempt<DownloadHandoff[]>> {
    return attempt(() =>
      this.prisma.downloadHandoff.findMany({
        where: { sceneId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        take: MAX_DOWNLOADS,
      }),
    );
  }

  private sameSceneIds(stashId: string): Promise<string[]> {
    return sameSceneIds(this.prisma, stashId);
  }

  /** The one-line reason for the status; for "waiting for import", the organizer's own. */
  private async reasonFor(row: SceneIndex | null): Promise<string | null> {
    if (!row) {
      return null;
    }
    if (row.computedLifecycle === SceneLifecycle.IMPORT_PENDING) {
      const explained = await this.organizer
        .explainWaitingScene(row)
        .catch(() => null);
      return (
        explained?.reason ??
        'Whisparr has a file for it, but Stash doesn’t show it as in your library yet.'
      );
    }
    return lifecycleReason(row);
  }
}

const LIFECYCLE_LABEL: Record<SceneLifecycle, string> = {
  NOT_REQUESTED: 'Not requested',
  REQUESTED: 'Requested',
  DOWNLOADING: 'Downloading',
  IMPORT_PENDING: 'Awaiting import',
  AVAILABLE: 'In library',
  FAILED: 'Failed',
};

const RENAME_LABEL: Record<RenameState, string> = {
  ready: 'Would be renamed',
  same: 'Already tidy',
  missing: 'No title yet',
  whisparr: 'Whisparr’s file',
  outside: 'Outside your library folders',
  'no-file': 'No file',
  gone: 'File moved outside Stash',
  taken: 'New name already taken',
  copy: 'Extra copy',
};

const RENAME_REASON: Record<RenameState, string> = {
  ready: 'The rename preview would rename this file.',
  same: 'The file already follows your rename pattern.',
  missing: 'Not renamed: the scene has no title yet.',
  whisparr:
    'Left alone: it’s Whisparr’s file, and Whisparr names the files it manages.',
  outside: 'Left alone: the file is outside your Stash library folders.',
  'no-file': 'Nothing to rename: the scene has no file.',
  gone: 'Stash lists the file, but it isn’t on disk there any more (moved outside Stash).',
  taken: 'Another file already has the new name.',
  copy: 'An extra copy: the scene already has a file with the right name.',
};

const TAKEN_FIX: Record<'scan' | 'merge' | 'none', string> = {
  scan: 'Have Stash scan the other file’s folder',
  merge: 'Merge the other scene into this one',
  none: 'None; check both files',
};

function lifecycleReason(row: SceneIndex): string {
  switch (row.computedLifecycle) {
    case SceneLifecycle.AVAILABLE:
      return 'Stash has a file linked to this scene, so it counts as in your library.';
    case SceneLifecycle.DOWNLOADING:
      return `Whisparr is downloading it${queueNote(row)}.`;
    case SceneLifecycle.FAILED:
      return row.whisparrErrorMessage
        ? `Whisparr’s download failed or got stuck: ${row.whisparrErrorMessage}`
        : 'Whisparr’s download failed or got stuck. Open it in Whisparr to see why.';
    case SceneLifecycle.REQUESTED:
      return row.whisparrMovieId !== null
        ? `Whisparr has the scene but no file yet${row.whisparrQueueStatus ? `; it’s in the download queue${queueNote(row)}` : ', and nothing in its download queue. It’s waiting for a release'}.`
        : 'Requested, but Whisparr doesn’t list it (yet).';
    default:
      return 'Not in Whisparr and not in your Stash library.';
  }
}

function statusSection(
  row: Attempt<SceneIndex | null>,
  reason: string | null,
  /** Why there's no status at all (a local scene not linked to the catalog). */
  untracked: string | null,
): EvidenceSection {
  const base = { id: 'status' as const, title: 'Status & why' };
  if (untracked) {
    return { ...base, summary: untracked, error: null, groups: [] };
  }
  if (row.error) {
    return {
      ...base,
      summary: null,
      error: `Couldn’t read Stashboard’s index: ${row.error}`,
      groups: [],
    };
  }
  const scene = row.value;
  if (!scene) {
    return {
      ...base,
      summary:
        'Stashboard hasn’t indexed this scene yet, so it has no status for it. It’s added on the next sync.',
      error: null,
      groups: [],
    };
  }
  return {
    ...base,
    summary: reason,
    error: null,
    groups: [
      group(null, [
        ['Status', LIFECYCLE_LABEL[scene.computedLifecycle]],
        ['In your Stash library', yesNo(scene.stashAvailable)],
        ['Whisparr has a file', yesNo(scene.whisparrHasFile)],
        ['Whisparr queue', queueText(scene)],
        ['Whisparr says', scene.whisparrErrorMessage],
        ['Request', scene.requestStatus],
        ['Checked with Whisparr', when(scene.whisparrLastSyncedAt)],
        ['Checked with Stash', when(scene.stashLastSyncedAt)],
        ['Last synced', when(scene.lastSyncedAt)],
      ]),
    ],
  };
}

function whisparrSection(
  catalogId: string | null,
  row: SceneIndex | null,
  file: Attempt<WhisparrFile>,
): EvidenceSection {
  const found = file.value;
  const movieId = row?.whisparrMovieId ?? found?.movieId ?? null;
  const inWhisparr =
    found || movieId !== null ? 'Yes' : file.error ? 'Unknown' : 'No';
  return {
    id: 'whisparr',
    title: 'Whisparr',
    summary: file.error
      ? null
      : found
        ? 'Whisparr has a file for it.'
        : movieId !== null
          ? 'Whisparr has the scene, but no file for it.'
          : 'Whisparr doesn’t have this scene.',
    error: file.error ? `Couldn’t ask Whisparr: ${file.error}` : null,
    groups: [
      group(null, [
        ['In Whisparr', inWhisparr],
        ['Movie id', movieId === null ? null : String(movieId)],
        [
          'Has a file',
          file.error
            ? `${yesNo(row?.whisparrHasFile)} (as of the last sync)`
            : yesNo(!!found),
        ],
        ['File (as Stash sees it)', found?.filePath],
        ['Folder (as Stash sees it)', found?.folder],
        [
          'Whisparr knows it as',
          found && found.stashId !== catalogId ? found.stashId : null,
        ],
        ['Queue', row ? queueText(row) : null],
        ['Whisparr says', row?.whisparrErrorMessage],
      ]),
    ],
  };
}

function stashSection(
  scenes: Attempt<StashOrganizerScene[]>,
  options: { summary: string },
): EvidenceSection {
  if (scenes.error) {
    return {
      id: 'stash',
      title: 'Stash',
      summary: null,
      error: `Couldn’t ask Stash: ${scenes.error}`,
      groups: [],
    };
  }
  return {
    id: 'stash',
    title: 'Stash',
    summary: options.summary,
    error: null,
    groups: (scenes.value ?? []).map((scene) =>
      group(
        `Stash scene ${scene.id}${scene.title ? ` · ${scene.title}` : ''}`,
        [
          ['Organized', yesNo(scene.organized)],
          ...(scene.stashIds.length > 0
            ? scene.stashIds.map((entry): [string, string] => [
                `Linked to ${labelFor(entry.endpoint)}`,
                entry.stashId,
              ])
            : [['Stash-box links', 'None'] as [string, string]]),
          ...(scene.files.length === 0
            ? [['File', 'None'] as [string, string]]
            : scene.files.flatMap((file, index) => {
                const n = scene.files.length > 1 ? ` ${index + 1}` : '';
                return [
                  [`File${n}`, file.path],
                  [`Size${n}`, size(file.size)],
                  [
                    `Fingerprint (phash)${n}`,
                    file.fingerprints.some((print) => print.type === 'phash')
                      ? 'Yes'
                      : 'No',
                  ],
                ] as Array<[string, string | null]>;
              })),
        ],
      ),
    ),
  };
}

function renameSection(rename: Attempt<RenamePlans>): EvidenceSection {
  const base = { id: 'rename' as const, title: 'Rename' };
  if (rename.error) {
    return {
      ...base,
      summary: null,
      error: `Couldn’t work out the rename: ${rename.error}`,
      groups: [],
    };
  }
  const plans = rename.value?.plans ?? [];
  if (plans.length === 0) {
    return {
      ...base,
      summary: 'Nothing to rename: Stash has no scene for it.',
      error: null,
      groups: [],
    };
  }
  return {
    ...base,
    summary: plans.length === 1 ? planReason(plans[0]) : null,
    error: null,
    groups: plans.map((plan, index) =>
      group(plans.length > 1 ? `Stash scene ${plan.sceneId}` : null, [
        ['Pattern', index === 0 ? rename.value!.pattern : null],
        ['Plan', RENAME_LABEL[plan.state]],
        ['From', plan.from],
        ['To', plan.to],
        [
          'Renamed before',
          plan.renamedBefore
            ? `${when(new Date(plan.renamedBefore))}; the file got its old name back since`
            : null,
        ],
        [
          'Other file’s scene',
          plan.taken
            ? (plan.taken.otherSceneId ?? 'Not scanned by Stash')
            : null,
        ],
        ['Same size', plan.taken ? yesNo(plan.taken.sameSize) : null],
        ['Safe fix', plan.taken ? TAKEN_FIX[plan.taken.fix] : null],
        ['Note', plan.taken?.note],
        ['Why', plans.length > 1 ? planReason(plan) : null],
      ]),
    ),
  };
}

function planReason(plan: RenamePlanDto): string {
  return plan.renamedBefore
    ? `${RENAME_REASON[plan.state]} Stashboard made this same rename before and the file got its old name back since (usually Whisparr renaming its own files).`
    : RENAME_REASON[plan.state];
}

/** Only shown once something was sent to SABnzbd for the scene. */
function downloadsSection(rows: Attempt<DownloadHandoff[]>): EvidenceSection[] {
  const base = { id: 'downloads' as const, title: 'Finished downloads' };
  if (rows.error) {
    return [
      {
        ...base,
        summary: null,
        error: `Couldn’t read the downloads sent to SABnzbd: ${rows.error}`,
        groups: [],
      },
    ];
  }
  const items = rows.value ?? [];
  if (items.length === 0) {
    return [];
  }
  const latest = items[0];
  return [
    {
      ...base,
      summary: `${DOWNLOAD_STATUS[latest.status] ?? latest.status}${latest.error ? `: ${latest.error}` : '.'}`,
      error: null,
      groups: items.map((item) =>
        group(item.releaseTitle, [
          ['Status', DOWNLOAD_STATUS[item.status] ?? item.status],
          ['Sent', when(item.createdAt)],
          ['File', item.finalPath],
          ['Reason', item.error],
        ]),
      ),
    },
  ];
}

function activitySection(
  entries: Attempt<ActivityEntryDto[]>,
): EvidenceSection {
  const base = { id: 'activity' as const, title: 'Recent activity' };
  if (entries.error) {
    return {
      ...base,
      summary: null,
      error: `Couldn’t read the activity log: ${entries.error}`,
      groups: [],
    };
  }
  const items = entries.value ?? [];
  return {
    ...base,
    summary:
      items.length === 0
        ? 'Nothing in the activity log mentions this scene.'
        : null,
    error: null,
    groups: items.length
      ? [
          group(
            null,
            items.map((entry) => [
              when(new Date(entry.at)),
              entry.title +
                (entry.status !== 'done' ? ` (${entry.status})` : '') +
                (entry.undoneAt ? ' (undone)' : ''),
            ]),
          ),
        ]
      : [],
  };
}

/** The scene's title and file names, to find its entries in the activity log. */
function mentions(
  title: string | null,
  scenes: StashOrganizerScene[],
  file: WhisparrFile | null,
): string[] {
  const paths = [
    ...scenes.flatMap((scene) => scene.files.map((entry) => entry.path)),
    ...(file ? [file.filePath] : []),
  ];
  return [
    ...(title ? [title] : []),
    ...paths,
    ...paths.map((path) => splitPath(path).basename),
  ];
}

/** Facts with a value; the rest are left out. */
function group(
  heading: string | null,
  facts: Array<[string, string | null | undefined]>,
): EvidenceGroup {
  return {
    heading,
    facts: facts.flatMap(([label, value]): EvidenceFact[] =>
      value === null || value === undefined || value === ''
        ? []
        : [{ label, value }],
    ),
  };
}

async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await work(), error: null };
  } catch (error) {
    return { value: null, error: messageOf(error) };
  }
}

function yesNo(value: boolean | null | undefined): string {
  return value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
}

/** "2026-10-21 14:03 UTC", or "Never". */
function when(value: Date | null): string {
  return value
    ? `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : 'Never';
}

function size(bytes: number | null): string | null {
  if (bytes === null) {
    return null;
  }
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function queueText(row: SceneIndex): string {
  if (!row.whisparrQueueStatus) {
    return 'Not in the queue';
  }
  const state =
    row.whisparrQueueState && row.whisparrQueueState !== row.whisparrQueueStatus
      ? ` (${row.whisparrQueueState})`
      : '';
  const position =
    row.whisparrQueuePosition !== null
      ? `, position ${row.whisparrQueuePosition}`
      : '';
  return `${row.whisparrQueueStatus}${state}${position}`;
}

function queueNote(row: SceneIndex): string {
  return row.whisparrQueueStatus ? ` (Whisparr says: ${queueText(row)})` : '';
}
