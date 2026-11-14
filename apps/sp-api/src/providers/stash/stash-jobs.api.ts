import { BadGatewayException, BadRequestException } from '@nestjs/common';
import {
  type StashAdapterBaseConfig,
  type StashJob,
  type StashLibraryTask,
} from './stash.types';
import { trimTrailingSeparators } from '../../path-separators';
import { MAX_REMEMBERED_JOBS } from './stash-tools.shared';
import { StashGraphqlClient } from './stash-graphql.client';

/** What Stashboard asks Stash to do in the background, merged by kind. */
export type BackgroundJobKind =
  'scan' | 'quick-scan' | 'generate' | 'identify' | 'preview-scan' | 'task';

const KIND_NAMES: Record<BackgroundJobKind, string> = {
  scan: 'scan',
  'quick-scan': 'quick scan',
  generate: 'Generate',
  identify: 'Identify',
  'preview-scan': 'preview rescan',
  task: 'library task',
};

/** How often to look whether Stash's queue has room again. */
const LANE_POLL_MS = 10_000;
/** A queue stuck this long (a job that never starts) doesn't hold Stashboard up for ever. */
const LANE_MAX_WAIT_MS = 30 * 60_000;
/**
 * A batch waits this long for others of its kind before it goes: one import
 * asks for the new scene's Generate and, a moment later, the replaced one's.
 */
const LANE_GATHER_MS = 2_000;

interface BackgroundBatch {
  kind: BackgroundJobKind;
  items: Set<string>;
  promise: Promise<string | null>;
}

/** Stash's jobs: scans, library tasks, the job queue, and finding what Generate still has to make. */
export abstract class StashJobsApi extends StashGraphqlClient {
  /**
   * Jobs Stashboard queued, by what they do. Stash runs one job at a time, so
   * while one still waits its turn, asking again for the same scan or the
   * same scenes' previews gets that job back instead of a copy behind it.
   */
  protected readonly queuedJobs = new Map<string, Promise<string | null>>();

  /**
   * Stashboard's background jobs, one Stash at a time: each waits until
   * nothing is waiting in Stash's queue (anyone's jobs), so Stashboard never
   * has more than one job waiting there. Asks that come in meanwhile join the
   * batch of their kind: ten downloads make one scan, one Generate and one
   * Identify, not thirty jobs.
   */
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly batches = new Map<string, BackgroundBatch>();
  /** Batches being handed to Stash right now, until it answers with an id. */
  private readonly starting = new Map<
    string,
    { items: Set<string>; promise: Promise<string | null> }
  >();
  /** Jobs Stashboard started, by Stash and id, so the jobs page can say whose is whose. */
  private readonly ourJobs = new Set<string>();

  protected noteOurJob(
    config: StashAdapterBaseConfig,
    job: string | null,
  ): void {
    if (!job) {
      return;
    }
    this.ourJobs.add(`${config.baseUrl}|${job}`);
    while (this.ourJobs.size > MAX_REMEMBERED_JOBS * 10) {
      const oldest = this.ourJobs.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.ourJobs.delete(oldest);
    }
  }

  /** Item → the job that took it, for asks that check back later. */
  private readonly startedFor = new Map<string, string>();
  /** For tests: how long to wait between looks at Stash's queue. */
  protected lanePollMs = LANE_POLL_MS;
  protected laneMaxWaitMs = LANE_MAX_WAIT_MS;
  protected laneGatherMs = LANE_GATHER_MS;
  protected laneSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Adds these items to the waiting batch of this kind (or starts one), and
   * resolves with the job that does them once Stash has room for it.
   */
  protected async inBackground(
    config: StashAdapterBaseConfig,
    kind: BackgroundJobKind,
    items: string[],
    start: (items: string[]) => Promise<string | null>,
  ): Promise<string | null> {
    // Already in a job of ours that's still waiting or running (a download's
    // scan, and the folder watcher noticing the same file): that one does it.
    const covering = await this.activeJobFor(config, kind, items);
    if (covering) {
      return covering;
    }
    return this.enqueue(config, kind, items, start);
  }

  /** The one job of ours, still waiting or running, that has all these items. */
  private async activeJobFor(
    config: StashAdapterBaseConfig,
    kind: BackgroundJobKind,
    items: string[],
  ): Promise<string | null> {
    const batchKey = `${config.baseUrl}|${kind}`;
    if (items.length === 0 || this.batches.get(batchKey)) {
      return null;
    }
    // Being handed to Stash this very moment: that one does it.
    const starting = this.starting.get(batchKey);
    if (starting && items.every((item) => starting.items.has(item))) {
      return starting.promise;
    }
    const jobs = new Set(
      items.map((item) => this.startedFor.get(`${batchKey}|${item}`) ?? null),
    );
    const [job] = [...jobs];
    if (jobs.size !== 1 || !job) {
      return null;
    }
    const queue = await this.getJobQueue(config).catch(() => []);
    const entry = queue.find((candidate) => candidate.id === job);
    return entry && (entry.status === 'READY' || entry.status === 'RUNNING')
      ? job
      : null;
  }

  private enqueue(
    config: StashAdapterBaseConfig,
    kind: BackgroundJobKind,
    items: string[],
    start: (items: string[]) => Promise<string | null>,
  ): Promise<string | null> {
    const batchKey = `${config.baseUrl}|${kind}`;
    const waiting = this.batches.get(batchKey);
    if (waiting) {
      items.forEach((item) => waiting.items.add(item));
      return waiting.promise;
    }
    const batch: BackgroundBatch = {
      kind,
      items: new Set(items),
      promise: Promise.resolve(null),
    };
    const previous = this.lanes.get(config.baseUrl) ?? Promise.resolve();
    batch.promise = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.laneGatherMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.laneGatherMs);
            timer.unref?.();
          });
        }
        await this.untilStashHasRoom(config);
        // From here on, new asks start a batch of their own; ones for the
        // same items wait for this job's id.
        this.batches.delete(batchKey);
        const handing = start([...batch.items]);
        this.starting.set(batchKey, { items: batch.items, promise: handing });
        const job = await handing.finally(() => {
          if (this.starting.get(batchKey)?.promise === handing) {
            this.starting.delete(batchKey);
          }
        });
        this.logger.log(
          `Started Stash's ${KIND_NAMES[kind]} for ${batch.items.size} ${kind.endsWith('scan') ? 'folder(s)' : kind === 'task' ? 'library task' : 'scene(s)'}${job ? ` (job ${job})` : ''}.`,
        );
        this.noteOurJob(config, job);
        if (job) {
          for (const item of batch.items) {
            this.startedFor.set(`${batchKey}|${item}`, job);
          }
          while (this.startedFor.size > MAX_REMEMBERED_JOBS * 10) {
            const oldest = this.startedFor.keys().next().value;
            if (oldest === undefined) {
              break;
            }
            this.startedFor.delete(oldest);
          }
        }
        return job;
      });
    this.batches.set(batchKey, batch);
    this.lanes.set(
      config.baseUrl,
      batch.promise.catch(() => undefined),
    );
    return batch.promise;
  }

  /**
   * Where an item stands without waiting: 'waiting' while its batch waits for
   * room in Stash, the job's id once started, null when it was never asked.
   */
  protected backgroundStatus(
    config: StashAdapterBaseConfig,
    kind: BackgroundJobKind,
    item: string,
  ): string | null {
    const batchKey = `${config.baseUrl}|${kind}`;
    if (this.batches.get(batchKey)?.items.has(item)) {
      return 'waiting';
    }
    return this.startedFor.get(`${batchKey}|${item}`) ?? null;
  }

  protected forgetBackground(
    config: StashAdapterBaseConfig,
    kind: BackgroundJobKind,
    item: string,
  ): void {
    this.startedFor.delete(`${config.baseUrl}|${kind}|${item}`);
  }

  /**
   * Waits until no job is waiting its turn in Stash's queue, or until it has
   * waited laneMaxWaitMs: a stuck queue gets one job of ours, not none for ever.
   */
  private async untilStashHasRoom(
    config: StashAdapterBaseConfig,
  ): Promise<void> {
    const since = Date.now();
    for (;;) {
      const queue = await this.getJobQueue(config).catch(() => null);
      // Can't ask: go ahead rather than wait for ever; Stash queues it.
      if (!queue || !queue.some((job) => job.status === 'READY')) {
        return;
      }
      if (Date.now() - since >= this.laneMaxWaitMs) {
        this.logger.warn(
          `Stash's job queue hasn't moved in ${Math.round(this.laneMaxWaitMs / 60_000)} minutes; adding Stashboard's job anyway. Check Stash's Tasks page for a stuck job.`,
        );
        return;
      }
      await this.laneSleep(this.lanePollMs);
    }
  }

  protected async queueOnce(
    config: StashAdapterBaseConfig,
    key: string,
    start: () => Promise<string | null>,
    alsoReuse: string[] = [],
  ): Promise<string | null> {
    const fullKey = `${config.baseUrl}|${key}`;
    const candidates = [
      fullKey,
      ...alsoReuse.map((k) => `${config.baseUrl}|${k}`),
    ];
    const earlier = candidates
      .map((candidate) => this.queuedJobs.get(candidate))
      .filter((job): job is Promise<string | null> => !!job);
    if (earlier.length > 0) {
      const ids = (
        await Promise.all(earlier.map((job) => job.catch(() => null)))
      ).filter((id): id is string => !!id);
      if (ids.length > 0) {
        const queue = await this.getJobQueue(config).catch(() => []);
        const waiting = ids.find((id) =>
          queue.some((job) => job.id === id && job.status === 'READY'),
        );
        if (waiting) {
          return waiting;
        }
      }
    }
    const started = start().then((job) => {
      this.noteOurJob(config, job);
      return job;
    });
    this.queuedJobs.delete(fullKey);
    this.queuedJobs.set(fullKey, started);
    started.catch(() => {
      if (this.queuedJobs.get(fullKey) === started) {
        this.queuedJobs.delete(fullKey);
      }
    });
    // Only recent jobs are worth reusing: each import adds a key (its scene
    // or folder), so the oldest are forgotten rather than kept for ever.
    while (this.queuedJobs.size > MAX_REMEMBERED_JOBS) {
      const oldest = this.queuedJobs.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.queuedJobs.delete(oldest);
    }
    return started;
  }

  protected async getStashBoxEndpoints(
    config: StashAdapterBaseConfig,
  ): Promise<string[]> {
    const payload = (await this.executeQuery(
      config,
      `query Boxes { configuration { general { stashBoxes { endpoint } } } }`,
    )) as unknown as {
      data?: {
        configuration?: {
          general?: { stashBoxes?: Array<{ endpoint?: unknown }> };
        };
      };
    };
    return (payload.data?.configuration?.general?.stashBoxes ?? [])
      .map((box) => this.normalizeOptionalString(box.endpoint))
      .filter((endpoint): endpoint is string => !!endpoint);
  }

  async getJobQueue(config: StashAdapterBaseConfig): Promise<StashJob[]> {
    const payload = (await this.executeQuery(
      config,
      `query Jobs { jobQueue { id status description progress subTasks addTime startTime } }`,
    )) as unknown as {
      data?: { jobQueue?: Array<Record<string, unknown>> | null };
    };
    return (payload.data?.jobQueue ?? []).flatMap((job) => {
      const id = this.normalizeOptionalString(job.id);
      if (!id) {
        return [];
      }
      return [
        {
          id,
          status: this.normalizeOptionalString(job.status) ?? 'READY',
          description:
            this.normalizeOptionalString(job.description) ?? 'Stash task',
          progress: typeof job.progress === 'number' ? job.progress : null,
          subTasks: Array.isArray(job.subTasks)
            ? job.subTasks.filter(
                (task): task is string => typeof task === 'string',
              )
            : [],
          addTime: this.normalizeOptionalString(job.addTime),
          startTime: this.normalizeOptionalString(job.startTime),
          byStashboard: this.ourJobs.has(`${config.baseUrl}|${id}`),
        },
      ];
    });
  }

  /**
   * Waits for a Stash job to finish. Stash drops finished jobs from its queue
   * shortly after, so "gone from the queue" also counts as finished.
   */
  async waitForJob(
    config: StashAdapterBaseConfig,
    jobId: string,
    options: {
      pollMs?: number;
      timeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<'FINISHED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'> {
    const pollMs = options.pollMs ?? 5000;
    const deadline = Date.now() + (options.timeoutMs ?? 3 * 3600_000);
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (Date.now() < deadline) {
      const job = (await this.getJobQueue(config)).find(
        (entry) => entry.id === jobId,
      );
      if (!job || job.status === 'FINISHED') {
        return 'FINISHED';
      }
      if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        return job.status;
      }
      await sleep(pollMs);
    }
    return 'TIMEOUT';
  }

  async stopJob(config: StashAdapterBaseConfig, jobId: string): Promise<void> {
    const id = this.normalizeEntityId(jobId);
    if (!id) {
      return;
    }
    await this.executeQuery(
      config,
      `mutation StopJob($id: ID!) { stopJob(job_id: $id) }`,
      { id },
      false,
    );
  }

  /** Starts one of Stash's library tasks and returns its job id. */
  /**
   * Scans only these folders, without generating covers, previews, sprites or
   * phashes — just enough for Stash to find new files and follow moved ones
   * (it recognizes a moved file by its fingerprint and keeps the scene).
   */
  async scanPaths(
    config: StashAdapterBaseConfig,
    paths: string[],
  ): Promise<string | null> {
    const unique = [
      ...new Set(
        paths.map((path) => trimTrailingSeparators(path)).filter(Boolean),
      ),
    ];
    if (unique.length === 0) {
      return null;
    }
    return this.inBackground(config, 'quick-scan', unique, async (batch) => {
      const payload = (await this.executeQuery(
        config,
        `mutation QuickScan($input: ScanMetadataInput!) { metadataScan(input: $input) }`,
        {
          input: {
            paths: batch,
            scanGenerateCovers: false,
            scanGeneratePreviews: false,
            scanGenerateImagePreviews: false,
            scanGenerateSprites: false,
            scanGeneratePhashes: false,
            scanGenerateThumbnails: false,
            scanGenerateClipPreviews: false,
          },
        },
      )) as unknown as { data?: { metadataScan?: unknown } };
      const job = payload.data?.metadataScan;
      return typeof job === 'string' || typeof job === 'number'
        ? String(job)
        : null;
    });
  }

  /**
   * Scans only these folders, with Stash's own scan settings (covers and the
   * rest as the library's default scan would make them).
   */
  async scanLibraryFolders(
    config: StashAdapterBaseConfig,
    folders: string[],
  ): Promise<string | null> {
    const paths = [
      ...new Set(
        folders.map((path) => trimTrailingSeparators(path)).filter(Boolean),
      ),
    ];
    if (paths.length === 0) {
      return null;
    }
    return this.inBackground(config, 'scan', paths, (batch) =>
      this.startFolderScan(config, batch),
    );
  }

  /**
   * Asks for a folder scan without waiting for it: 'waiting' while it waits
   * its turn behind Stash's other jobs, then the job's id, running or done.
   * Once a finished scan has been looked at, forgetFolderScan lets the next
   * ask queue a new one: an ask never turns into a scan every check.
   */
  requestFolderScan(
    config: StashAdapterBaseConfig,
    folder: string,
  ): Promise<string> {
    const path = trimTrailingSeparators(folder);
    const status = this.backgroundStatus(config, 'scan', path);
    if (status) {
      return Promise.resolve(status);
    }
    // With Stash free it starts at once: wait a moment for that, so the
    // same check can follow it, rather than saying "busy" until the next.
    const started = this.scanLibraryFolders(config, [path]).catch(() => null);
    return Promise.race([
      started.then((job) => job ?? 'waiting'),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('waiting'), this.startGraceMs);
        timer.unref?.();
      }),
    ]);
  }

  /** How long an ask waits for its scan to start before saying "waiting". */
  protected startGraceMs = 15_000;

  /** The folder's last scan has been looked at: the next ask scans again. */
  forgetFolderScan(config: StashAdapterBaseConfig, folder: string): void {
    this.forgetBackground(config, 'scan', trimTrailingSeparators(folder));
  }

  private async startFolderScan(
    config: StashAdapterBaseConfig,
    paths: string[],
  ): Promise<string | null> {
    const payload = (await this.executeQuery(
      config,
      `mutation ScanFolders($input: ScanMetadataInput!) { metadataScan(input: $input) }`,
      { input: { paths } },
      false,
    )) as unknown as { data?: { metadataScan?: unknown } };
    const job = payload.data?.metadataScan;
    return typeof job === 'string' || typeof job === 'number'
      ? String(job)
      : null;
  }

  /**
   * Starts one of Stash's library tasks. In the background (the default)
   * it waits its turn behind Stash's other jobs and joins others of its kind;
   * `now` starts it straight away, for something you just tapped.
   */
  async startLibraryTask(
    config: StashAdapterBaseConfig,
    task: StashLibraryTask,
    sceneIds?: string[],
    options: { now?: boolean } = {},
  ): Promise<string | null> {
    const ids = sceneIds
      ?.map((id) => this.normalizeEntityId(id))
      .filter((id): id is string => !!id);
    // Scenes were named but none is a real id: never fall through to the
    // whole library.
    if (sceneIds && ids?.length === 0) {
      throw new BadRequestException('None of those is a scene Stash knows.');
    }
    let mutation: string;
    let variables: Record<string, unknown> = {};
    switch (task) {
      case 'scan':
        mutation = `mutation Scan($input: ScanMetadataInput!) { metadataScan(input: $input) }`;
        variables = { input: {} };
        break;
      case 'generate':
        mutation = `mutation Generate($input: GenerateMetadataInput!) { metadataGenerate(input: $input) }`;
        variables = {
          input: {
            covers: true,
            sprites: true,
            previews: true,
            markers: true,
            markerScreenshots: true,
            phashes: true,
            ...(ids?.length ? { sceneIDs: ids } : {}),
          },
        };
        break;
      case 'identify': {
        const endpoints = await this.getStashBoxEndpoints(config);
        if (endpoints.length === 0) {
          throw new BadGatewayException(
            'Stash has no StashDB-style source set up. Add one in Stash under Settings → Metadata Providers.',
          );
        }
        mutation = `mutation Identify($input: IdentifyMetadataInput!) { metadataIdentify(input: $input) }`;
        variables = {
          input: {
            sources: endpoints.map((endpoint) => ({
              source: { stash_box_endpoint: endpoint },
            })),
            ...(ids?.length ? { sceneIDs: ids } : {}),
          },
        };
        break;
      }
      case 'auto-tag':
        mutation = `mutation AutoTag($input: AutoTagMetadataInput!) { metadataAutoTag(input: $input) }`;
        variables = {
          input: { performers: ['*'], studios: ['*'], tags: ['*'] },
        };
        break;
      case 'clean':
        mutation = `mutation Clean($input: CleanMetadataInput!) { metadataClean(input: $input) }`;
        variables = { input: { dryRun: false } };
        break;
    }
    const run = async (vars: Record<string, unknown>) => {
      const payload = (await this.executeQuery(
        config,
        mutation,
        vars,
        false,
      )) as unknown as {
        data?: Record<string, unknown>;
      };
      const value = Object.values(payload.data ?? {})[0];
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
    };
    const scope = ids?.length ? [...ids].sort().join(',') : '*';
    if (options.now) {
      return this.queueOnce(config, `${task}:${scope}`, () => run(variables));
    }
    // Scenes' Generate or Identify: one job for every scene asked meanwhile.
    if (ids?.length && (task === 'generate' || task === 'identify')) {
      return this.inBackground(config, task, ids, (batch) => {
        const input = variables['input'] as Record<string, unknown>;
        return run({ input: { ...input, sceneIDs: batch } });
      });
    }
    // A whole-library task: once, whoever asks while it waits.
    return this.inBackground(config, 'task', [task], () => run(variables));
  }

  /**
   * Whether Stash transcodes with the GPU (Settings → System → Transcoding,
   * hardware encoding). Null when this Stash doesn't have the setting.
   */
  async getTranscodeHardwareAcceleration(
    config: StashAdapterBaseConfig,
  ): Promise<boolean | null> {
    try {
      const payload = (await this.executeQuery(
        config,
        `query Transcoding { configuration { general { transcodeHardwareAcceleration } } }`,
        undefined,
        // Older Stash has no such field: that's not Stash being unwell.
        false,
      )) as unknown as {
        data?: {
          configuration?: {
            general?: { transcodeHardwareAcceleration?: unknown };
          };
        };
      };
      const value =
        payload.data?.configuration?.general?.transcodeHardwareAcceleration;
      return typeof value === 'boolean' ? value : null;
    } catch {
      // Older Stash: no such field.
      return null;
    }
  }
}
