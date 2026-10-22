import { SceneLifecycle } from '@prisma/client';
import type { DownloadHandoff, SceneIndex } from '@prisma/client';
import type { ActivityEntryDto } from '../activity/activity.model';
import type { WaitingScene } from '../organizer/organizer.model';
import type { SabnzbdQueueEntry } from '../providers/sabnzbd/sabnzbd.adapter';
import type { StashOrganizerScene } from '../providers/stash/stash.adapter';
import type {
  WhisparrHistoryEvent,
  WhisparrQueueDetail,
} from '../providers/whisparr/whisparr.adapter';
import type {
  SceneTimelineDto,
  TimelineAction,
  TimelineRoute,
  TimelineStep,
  TimelineStepId,
  TimelineStepStatus,
} from './scene-timeline.model';

/** What a lookup gave, or why it failed. */
export interface Known<T> {
  value: T | null;
  error: string | null;
}

/**
 * Everything the story is told from. Optional sources are left out by the
 * cheap batch (Acquisition cards); a Known with an error means the source
 * was asked and couldn't answer, so its steps say unknown.
 */
export interface TimelineFacts {
  stashId: string;
  /** Stashboard's own request record (Whisparr requests). */
  /** updatedAt moves on every re-request, so it's when it was last asked for. */
  request: { createdAt: Date; updatedAt: Date } | null;
  row: Pick<
    SceneIndex,
    | 'title'
    | 'requestUpdatedAt'
    | 'whisparrMovieId'
    | 'whisparrHasFile'
    | 'whisparrQueueStatus'
    | 'whisparrQueueState'
    | 'whisparrErrorMessage'
    | 'stashAvailable'
    | 'computedLifecycle'
  > | null;
  /** Downloads sent to SABnzbd for it, newest first. */
  handoffs: Array<
    Pick<
      DownloadHandoff,
      | 'nzoId'
      | 'releaseTitle'
      | 'status'
      | 'finalPath'
      | 'stashSceneId'
      | 'error'
      | 'createdAt'
    >
  >;
  /** Whisparr's queue for this scene; null when Whisparr wasn't asked. */
  queue: Known<WhisparrQueueDetail[]> | null;
  /** Whisparr's history for this scene, newest first. */
  history?: Known<WhisparrHistoryEvent[]> | null;
  /** SABnzbd's queue, for a download still in it. */
  sabQueue?: Known<SabnzbdQueueEntry[]> | null;
  /** The Stash scenes linked to it. */
  stash?: Known<StashOrganizerScene[]>;
  /** Stashboard's renames of those scenes' files, newest first. */
  renames?: Array<{ toPath: string; createdAt: Date }>;
  /** Why it still waits for import (organizer's own check). */
  waiting?: WaitingScene | null;
  /** Activity log entries mentioning it, newest first. */
  activity?: Known<ActivityEntryDto[]>;
  /** The scene's titles, to tell its own entries from ones naming a longer title. */
  titles?: string[];
}

const LABEL: Record<TimelineStepId, string> = {
  requested: 'Requested',
  searching: 'Searching',
  grabbed: 'Grabbed',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  importing: 'Importing',
  moved: 'Moved into library',
  'in-stash': 'In Stash',
  matched: 'Matched',
  renamed: 'Renamed',
  previews: 'Previews generated',
};

/** What the next step will be, said before it happens. */
const NEXT_DETAIL: Partial<Record<TimelineStepId, string>> = {
  searching: 'Whisparr looks for a release.',
  grabbed: 'A release is picked and sent to download.',
  downloading: 'The download client fetches it.',
  importing: 'Whisparr moves it into your library.',
  moved: 'Stashboard moves it into your library.',
  'in-stash': 'Stash scans it in.',
  matched: 'Stash links it to this scene.',
  renamed: 'The file gets your rename pattern.',
  previews: 'Stash makes its previews and fingerprint.',
};

const ROUTE_STEPS: Record<TimelineRoute, TimelineStepId[]> = {
  whisparr: [
    'requested',
    'searching',
    'grabbed',
    'downloading',
    'downloaded',
    'importing',
    'in-stash',
    'matched',
    'renamed',
    'previews',
  ],
  sabnzbd: [
    'requested',
    'grabbed',
    'downloading',
    'downloaded',
    'moved',
    'in-stash',
    'matched',
    'renamed',
    'previews',
  ],
  prowlarr: [
    'requested',
    'downloading',
    'in-stash',
    'matched',
    'renamed',
    'previews',
  ],
  library: ['in-stash', 'matched', 'renamed', 'previews'],
};

/** Steps that may simply not happen; passed over, they read "skipped", not "done". */
const OPTIONAL = new Set<TimelineStepId>(['renamed']);

/** "Where it is now" while a step is current or stuck. */
const NOW_CURRENT: Partial<Record<TimelineStepId, string>> = {
  searching: 'Searching for a release',
  downloading: 'Downloading',
  importing: 'Whisparr is importing it',
  moved: 'Moving it into your library',
  'in-stash': 'Waiting for Stash to scan it',
  matched: 'Waiting to be linked',
};
const NOW_FAILED: Partial<Record<TimelineStepId, string>> = {
  downloading: 'Download failed',
  importing: 'Whisparr couldn’t import it',
  moved: 'Couldn’t move it into your library',
  'in-stash': 'Stash hasn’t picked it up',
  matched: 'Not linked to this scene',
};

const PICK_ANOTHER: TimelineAction = {
  kind: 'pick-release',
  label: 'Pick another release',
};
const SEARCH_AGAIN: TimelineAction = {
  kind: 'find-downloads',
  label: 'Pick another release',
};
const CHECK_MATCHES: TimelineAction = {
  kind: 'check-matches',
  label: 'Check these matches',
};
const SCAN: TimelineAction = { kind: 'scan', label: 'Scan in Stash' };

type Draft = Partial<Omit<TimelineStep, 'step' | 'label' | 'status'>> & {
  status: TimelineStepStatus | null;
};
type Drafts = Partial<Record<TimelineStepId, Draft>>;

/**
 * Merges what each source says into one ordered story: every step reached,
 * the one it's on (or stuck at), and the one expected next. Pure, so it's
 * the same for the scene page and the Acquisition cards.
 */
export function buildTimeline(
  facts: TimelineFacts,
  now = new Date(),
): SceneTimelineDto {
  const unknown = unknownSources(facts);
  const route = routeOf(facts);
  const base = {
    stashId: facts.stashId,
    route,
    unknown,
    checkedAt: now.toISOString(),
  };
  if (!route) {
    return { ...base, now: 'Not requested', steps: [] };
  }
  const drafts: Drafts = {
    ...(route === 'whisparr'
      ? whisparrSteps(facts, now)
      : route === 'sabnzbd'
        ? handoffSteps(facts)
        : route === 'prowlarr'
          ? prowlarrSteps(facts)
          : {}),
  };
  Object.assign(drafts, librarySteps(facts, drafts, route));
  const steps = trim(ROUTE_STEPS[route], drafts);
  return { ...base, now: nowLine(steps), steps };
}

function routeOf(facts: TimelineFacts): TimelineRoute | null {
  const handoff = facts.handoffs[0];
  if (
    handoff &&
    (!facts.request || handoff.createdAt >= facts.request.updatedAt)
  ) {
    return 'sabnzbd';
  }
  const row = facts.row;
  if (
    facts.request ||
    row?.whisparrMovieId != null ||
    (row &&
      row.computedLifecycle !== SceneLifecycle.NOT_REQUESTED &&
      row.computedLifecycle !== SceneLifecycle.AVAILABLE)
  ) {
    return 'whisparr';
  }
  if (prowlarrGrab(facts)) {
    return 'prowlarr';
  }
  return inStash(facts) === true ? 'library' : null;
}

function whisparrSteps(facts: TimelineFacts, now: Date): Drafts {
  const row = facts.row;
  const history = facts.history?.value ?? [];
  const historyKnown = !!facts.history && !facts.history.error;
  const queueKnown = !!facts.queue && !facts.queue.error;
  const whisparrDown =
    !!facts.queue?.error || (!!facts.history && !!facts.history.error);
  const queue = queueKnown ? (facts.queue?.value?.[0] ?? null) : null;
  // Live from Whisparr when it answered; Stashboard's last sync otherwise.
  const queueState = (
    queueKnown
      ? (queue?.trackedDownloadState ?? queue?.status ?? '')
      : (row?.whisparrQueueState ?? row?.whisparrQueueStatus ?? '')
  ).toLowerCase();
  const grab = history.find((event) => event.eventType === 'grabbed');
  const imported = history.find(
    (event) =>
      event.eventType === 'downloadFolderImported' ||
      event.eventType === 'movieFolderImported',
  );
  const failure = history.find((event) => event.eventType === 'downloadFailed');
  // The latest grab failed and nothing came in after it.
  const failedNow =
    !!failure &&
    (!grab || failure.date >= grab.date) &&
    (!imported || imported.date < failure.date);
  const stashHas = inStash(facts) === true;
  const hasFile = row?.whisparrHasFile === true || !!imported || stashHas;
  const importStep = [
    'importpending',
    'importblocked',
    'importing',
    'imported',
  ].includes(queueState);
  const downloaded =
    hasFile || importStep || queue?.status?.toLowerCase() === 'completed';
  const queueFailed =
    !downloaded &&
    (['failed', 'failedpending'].includes(queueState) ||
      queue?.trackedDownloadStatus?.toLowerCase() === 'error' ||
      // Stashboard's index says failed and Whisparr can't tell otherwise.
      (!queue &&
        !historyKnown &&
        row?.computedLifecycle === SceneLifecycle.FAILED));
  const inQueue = queueKnown ? !!queue : !!queueState;
  const unknownStep: Draft | null = whisparrDown
    ? { status: 'unknown', detail: 'Couldn’t ask Whisparr.' }
    : null;

  const requestedAt =
    facts.request?.updatedAt ??
    activityAt(
      facts,
      (entry) =>
        /^Requested /.test(entry.title) && namesThisScene(facts, entry),
    ) ??
    row?.requestUpdatedAt ??
    null;
  const drafts: Drafts = {
    requested: {
      status: 'done',
      at: iso(requestedAt),
      detail:
        facts.request || requestedAt
          ? 'Requested in Whisparr.'
          : 'Added in Whisparr, not through Stashboard.',
    },
  };

  const grabbed = grab || inQueue || downloaded || failedNow || queueFailed;
  drafts.searching = grabbed
    ? { status: 'done', at: iso(requestedAt) }
    : (unknownStep ??
      (queueKnown || row
        ? {
            status: 'current',
            detail: 'Whisparr is looking for a release.',
            action: { kind: 'pick-release', label: 'Pick a release' },
          }
        : { status: null }));

  drafts.grabbed = grab
    ? {
        status: 'done',
        at: grab.date,
        detail: releaseLine(grab.sourceTitle, grab.indexer),
      }
    : queue
      ? {
          status: 'done',
          at: queue.added,
          detail: releaseLine(queue.title, queue.indexer),
        }
      : grabbed
        ? historyKnown && hasFile
          ? {
              status: 'skipped',
              detail: 'Whisparr didn’t grab it; the file came in another way.',
            }
          : (unknownStep ?? { status: null })
        : (unknownStep ?? { status: null });

  if (failedNow || queueFailed) {
    const reason =
      (failedNow ? failure?.message : null) ??
      queue?.errorMessage ??
      queue?.messages[0] ??
      row?.whisparrErrorMessage ??
      null;
    drafts.downloading = {
      status: 'failed',
      at: failedNow ? failure.date : null,
      detail: reason
        ? `Whisparr says: ${reason}`
        : 'The download failed or got stuck.',
      action: PICK_ANOTHER,
    };
  } else if (inQueue && !downloaded) {
    const progress = queue ? percent(queue.size, queue.sizeLeft) : null;
    const waiting = ['queued', 'paused', 'delay'].includes(
      (queue?.status ?? '').toLowerCase(),
    );
    drafts.downloading = {
      status: 'current',
      at: queue?.added ?? null,
      progress: waiting ? null : progress,
      detail: waiting
        ? `Waiting in the download client (${queue!.status!.toLowerCase()}).`
        : progressLine(
            progress,
            eta(
              queue?.timeLeft ?? null,
              queue?.estimatedCompletionTime ?? null,
              now,
            ),
          ),
    };
  } else {
    drafts.downloading = downloaded
      ? { status: 'done' }
      : (unknownStep ?? { status: null });
  }

  drafts.downloaded = downloaded
    ? { status: 'done' }
    : (unknownStep ?? { status: null });

  drafts.importing =
    row?.whisparrHasFile || imported
      ? {
          status: 'done',
          at: imported?.date ?? null,
          detail: imported?.importedPath ? `To ${imported.importedPath}` : null,
        }
      : queueState === 'importblocked' ||
          (importStep &&
            queue?.trackedDownloadStatus?.toLowerCase() === 'warning')
        ? {
            status: 'failed',
            detail:
              queue?.messages[0] ??
              queue?.errorMessage ??
              'Whisparr couldn’t import the download.',
            action: { kind: 'open-whisparr', label: 'Open it in Whisparr' },
          }
        : importStep
          ? {
              status: 'current',
              detail: 'Whisparr is moving it into your library.',
            }
          : stashHas
            ? { status: 'done' }
            : (unknownStep ?? { status: null });
  return drafts;
}

function handoffSteps(facts: TimelineFacts): Drafts {
  const handoff = facts.handoffs[0];
  const queued = facts.sabQueue?.value?.find(
    (entry) => entry.nzoId === handoff.nzoId,
  );
  const moved = !!handoff.finalPath;
  const drafts: Drafts = {
    requested: {
      status: 'done',
      at: handoff.createdAt.toISOString(),
      detail: 'Picked in Find downloads (Prowlarr) and sent to SABnzbd.',
    },
    grabbed: {
      status: 'done',
      at: handoff.createdAt.toISOString(),
      detail: handoff.releaseTitle,
    },
  };
  const open = handoff.status === 'sent' || handoff.status === 'downloading';
  if (open) {
    const progress = queued?.percentage ?? null;
    drafts.downloading = {
      status: 'current',
      progress,
      detail:
        handoff.status === 'sent' && !queued
          ? 'Waiting in SABnzbd.'
          : progressLine(
              progress,
              queued?.timeLeft ? eta(queued.timeLeft, null, new Date()) : null,
            ),
    };
    return drafts;
  }
  if (!moved && (handoff.status === 'failed' || handoff.status === 'ignored')) {
    drafts.downloading = {
      status: 'failed',
      detail:
        handoff.error ??
        (handoff.status === 'ignored'
          ? 'Stashboard stopped watching it.'
          : 'SABnzbd couldn’t download it.'),
      action: SEARCH_AGAIN,
    };
    return drafts;
  }
  drafts.downloading = { status: 'done' };
  drafts.downloaded = { status: 'done' };
  drafts.moved = moved
    ? { status: 'done', detail: `To ${handoff.finalPath}` }
    : { status: null };
  return drafts;
}

function prowlarrSteps(facts: TimelineFacts): Drafts {
  const entry = prowlarrGrab(facts)!;
  return {
    requested: {
      status: 'done',
      at: entry.at,
      detail: entry.detail
        ? `Sent through Prowlarr: ${entry.detail.replace(/\.$/, '')}.`
        : 'Sent through Prowlarr to its download client.',
    },
    downloading: {
      status: 'unknown',
      detail:
        'Prowlarr’s download client has it; Stashboard can’t see its progress.',
    },
  };
}

/** In Stash, matched, renamed, previews: the same for every route. */
function librarySteps(
  facts: TimelineFacts,
  earlier: Drafts,
  route: TimelineRoute,
): Drafts {
  const scenes = facts.stash?.value ?? [];
  const stashAsked = !!facts.stash && !facts.stash.error;
  const stashDown: Draft | null = facts.stash?.error
    ? { status: 'unknown', detail: 'Couldn’t ask Stash.' }
    : null;
  const handoff = route === 'sabnzbd' ? facts.handoffs[0] : null;
  const waiting = facts.waiting ?? null;
  // Finished downloads only says imported once it's linked.
  const linked = inStash(facts) === true || handoff?.status === 'imported';
  const files = scenes.flatMap((scene) => scene.files);
  const scannedAt =
    scenes
      .map((scene) => scene.createdAt ?? null)
      .filter((value): value is string => !!value)
      .sort()[0] ?? null;
  const drafts: Drafts = {};

  // In Stash: linked, or Stash has the file but it isn't linked yet.
  if (linked || handoff?.stashSceneId) {
    drafts['in-stash'] = {
      status: 'done',
      at: scannedAt,
      detail: files[0] ? files[0].path : null,
    };
  } else if (
    waiting &&
    ['not-linked', 'other-scene', 'catching-up'].includes(waiting.kind)
  ) {
    drafts['in-stash'] = { status: 'done', detail: waiting.path };
  } else if (waiting?.kind === 'not-in-stash') {
    drafts['in-stash'] = {
      status: 'current',
      detail: waiting.reason,
      action: SCAN,
    };
  } else if (handoff && handoff.finalPath) {
    drafts['in-stash'] =
      handoff.status === 'failed'
        ? { status: 'failed', detail: handoff.error, action: SCAN }
        : {
            status: 'current',
            detail: handoff.error ?? 'Waiting for Stash to pick it up.',
            action: SCAN,
          };
  } else if (stashDown) {
    drafts['in-stash'] = stashDown;
  } else if (
    earlier.importing?.status === 'done' ||
    facts.row?.whisparrHasFile === true
  ) {
    drafts['in-stash'] = {
      status: 'current',
      detail: 'Waiting for Stash to scan it.',
      action: SCAN,
    };
  } else {
    drafts['in-stash'] = { status: null };
  }

  // Matched: linked to this catalog scene.
  if (linked) {
    drafts.matched = {
      status: 'done',
      at: activityAt(facts, (entry) => entry.kind === 'match'),
    };
  } else if (
    handoff?.stashSceneId &&
    (handoff.status === 'failed' || handoff.status === 'completed')
  ) {
    drafts.matched = {
      status: handoff.status === 'failed' ? 'failed' : 'current',
      detail: handoff.error ?? 'Waiting to be linked to this scene.',
      action: CHECK_MATCHES,
    };
  } else if (
    waiting?.kind === 'not-linked' ||
    waiting?.kind === 'other-scene'
  ) {
    drafts.matched = {
      status: 'failed',
      detail: waiting.reason,
      action: CHECK_MATCHES,
    };
  } else if (waiting?.kind === 'catching-up') {
    drafts.matched = { status: 'current', detail: waiting.reason };
  } else {
    drafts.matched = stashDown ?? { status: null };
  }

  // Renamed and previews: only Stash's own answer tells.
  if (stashAsked && linked) {
    const rename = facts.renames?.[0];
    drafts.renamed = rename
      ? {
          status: 'done',
          at: rename.createdAt.toISOString(),
          detail: `To ${rename.toPath}`,
        }
      : {
          status: 'skipped',
          detail: 'Not renamed by Stashboard; the name may already fit.',
        };
    drafts.previews = files.some((file) =>
      file.fingerprints.some((print) => print.type === 'phash'),
    )
      ? { status: 'done' }
      : {
          status: null,
          action: { kind: 'generate', label: 'Generate previews' },
        };
  } else {
    drafts.renamed = linked
      ? (stashDown ?? { status: null })
      : { status: null };
    drafts.previews = { status: null };
  }
  return drafts;
}

/**
 * Every step up to the last one reached (gaps filled in: a later step
 * proves an earlier one happened), then the one expected next, unless it's
 * on a step or stuck.
 */
function trim(order: TimelineStepId[], drafts: Drafts): TimelineStep[] {
  const definite = (status: TimelineStepStatus | null | undefined) =>
    status === 'done' ||
    status === 'current' ||
    status === 'failed' ||
    status === 'skipped';
  let last = -1;
  order.forEach((id, index) => {
    if (definite(drafts[id]?.status)) {
      last = index;
    }
  });
  const steps: TimelineStep[] = [];
  for (let index = 0; index <= last; index++) {
    const id = order[index];
    const draft = drafts[id] ?? { status: null };
    steps.push(
      toStep(id, {
        ...draft,
        status: draft.status ?? (OPTIONAL.has(id) ? 'skipped' : 'done'),
      }),
    );
  }
  const reached = last >= 0 ? steps[steps.length - 1].status : 'done';
  const nextId = order[last + 1];
  if (nextId && (reached === 'done' || reached === 'skipped')) {
    const draft = drafts[nextId] ?? { status: null };
    steps.push(
      toStep(
        nextId,
        draft.status === 'unknown'
          ? draft
          : {
              ...draft,
              status: 'next',
              detail: NEXT_DETAIL[nextId] ?? null,
            },
      ),
    );
  }
  return steps;
}

function toStep(id: TimelineStepId, draft: Draft): TimelineStep {
  return {
    step: id,
    label: LABEL[id],
    at: draft.at ?? null,
    status: draft.status ?? 'next',
    detail: draft.detail ?? null,
    progress: draft.progress ?? null,
    action: draft.action ?? null,
  };
}

/** One line: where it is now. */
function nowLine(steps: TimelineStep[]): string {
  const stuck = steps.find((step) => step.status === 'failed');
  if (stuck) {
    return NOW_FAILED[stuck.step] ?? `${stuck.label} failed`;
  }
  const current = steps.find((step) => step.status === 'current');
  if (current) {
    const phrase = NOW_CURRENT[current.step] ?? current.label;
    return current.step === 'downloading' && current.progress !== null
      ? `${phrase} · ${current.progress}%`
      : phrase;
  }
  const next = steps.find(
    (step) => step.status === 'next' || step.status === 'unknown',
  );
  const done = [...steps]
    .reverse()
    .find((step) => step.status === 'done' || step.status === 'skipped');
  if (
    steps.some((step) => step.step === 'matched' && step.status === 'done') &&
    (!next || next.step === 'renamed' || next.step === 'previews')
  ) {
    return 'In your library';
  }
  if (!next) {
    return done?.label ?? 'Not requested';
  }
  const reached = done?.label ?? 'Requested';
  return next.status === 'unknown'
    ? `${reached} · ${next.label.toLowerCase()}: unknown`
    : `${reached} · next: ${next.label.toLowerCase()}`;
}

function unknownSources(facts: TimelineFacts): string[] {
  return [
    ...(facts.queue?.error || facts.history?.error ? ['Whisparr'] : []),
    ...(facts.stash?.error ? ['Stash'] : []),
    ...(facts.sabQueue?.error ? ['SABnzbd'] : []),
    ...(facts.activity?.error ? ['the activity log'] : []),
  ];
}

/** Linked in Stash: Stash's own answer, else Stashboard's last sync. */
function inStash(facts: TimelineFacts): boolean | null {
  if (facts.stash && !facts.stash.error) {
    return (facts.stash.value ?? []).length > 0;
  }
  return facts.row?.stashAvailable ?? null;
}

/** "Sent a release of … to download through Prowlarr", the newest. */
function prowlarrGrab(facts: TimelineFacts): ActivityEntryDto | null {
  return (
    facts.activity?.value?.find(
      (entry) =>
        entry.kind === 'request' &&
        /through Prowlarr/.test(entry.title) &&
        namesThisScene(facts, entry),
    ) ?? null
  );
}

/**
 * Activity titles quote the scene (“Title”); the search behind them matches
 * any text containing it, so “Title 2” would count without this.
 */
function namesThisScene(
  facts: TimelineFacts,
  entry: ActivityEntryDto,
): boolean {
  const titles = facts.titles ?? [];
  if (titles.length === 0) {
    return true;
  }
  const text = entry.title.toLowerCase();
  return titles.some((title) =>
    text.includes(`“${title.trim().toLowerCase()}”`),
  );
}

function activityAt(
  facts: TimelineFacts,
  match: (entry: ActivityEntryDto) => boolean,
): string | null {
  return facts.activity?.value?.find(match)?.at ?? null;
}

function releaseLine(
  title: string | null,
  indexer: string | null,
): string | null {
  if (!title) {
    return indexer ? `From ${indexer}` : null;
  }
  return indexer ? `${title} · ${indexer}` : title;
}

function percent(size: number | null, left: number | null): number | null {
  if (!size || size <= 0 || left === null) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(((size - left) / size) * 100)));
}

function progressLine(progress: number | null, left: string | null): string {
  if (progress === null && !left) {
    return 'In the download client.';
  }
  return [progress !== null ? `${progress}%` : null, left]
    .filter(Boolean)
    .join(' · ');
}

/**
 * "about 12 min left" from Whisparr's or SABnzbd's "[d.]hh:mm:ss", or from
 * the expected finish time; null when neither says.
 */
export function eta(
  timeLeft: string | null,
  finishAt: string | null,
  now: Date,
): string | null {
  let seconds: number | null = null;
  const match = timeLeft?.match(/^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})$/);
  if (match) {
    seconds =
      Number(match[1] ?? 0) * 86_400 +
      Number(match[2]) * 3600 +
      Number(match[3]) * 60 +
      Number(match[4]);
  } else if (finishAt) {
    const at = Date.parse(finishAt);
    seconds = Number.isNaN(at) ? null : (at - now.getTime()) / 1000;
  }
  if (seconds === null || seconds < 0) {
    return null;
  }
  if (seconds < 60) {
    return 'under a minute left';
  }
  if (seconds < 90 * 60) {
    return `about ${Math.round(seconds / 60)} min left`;
  }
  if (seconds < 36 * 3600) {
    return `about ${Math.round(seconds / 3600)} h left`;
  }
  const days = Math.round(seconds / 86_400);
  return `about ${days} ${days === 1 ? 'day' : 'days'} left`;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return typeof value === 'string' ? value : value.toISOString();
}
