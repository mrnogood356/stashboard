import { BadGatewayException, BadRequestException } from '@nestjs/common';
import {
  type StashAdapterBaseConfig,
  type StashJob,
  type StashLibraryTask,
} from './stash.types';
import { trimTrailingSeparators } from '../../path-separators';
import { MAX_REMEMBERED_JOBS } from './stash-tools.shared';
import { StashGraphqlClient } from './stash-graphql.client';

/** Stash's jobs: scans, library tasks, the job queue, and finding what Generate still has to make. */
export abstract class StashJobsApi extends StashGraphqlClient {
  /**
   * Jobs Stashboard queued, by what they do. Stash runs one job at a time, so
   * while one still waits its turn, asking again for the same scan or the
   * same scenes' previews gets that job back instead of a copy behind it.
   */
  protected readonly queuedJobs = new Map<string, Promise<string | null>>();

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
    const started = start();
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
    const payload = (await this.executeQuery(
      config,
      `mutation QuickScan($input: ScanMetadataInput!) { metadataScan(input: $input) }`,
      {
        input: {
          paths: unique,
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
    // A waiting scan of the same folders, or of everything, covers this one.
    return this.queueOnce(
      config,
      `scan:${[...paths].sort().join('\n')}`,
      async () => {
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
      },
      ['scan:*'],
    );
  }

  async startLibraryTask(
    config: StashAdapterBaseConfig,
    task: StashLibraryTask,
    sceneIds?: string[],
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
    const scope = ids?.length ? [...ids].sort().join(',') : '*';
    return this.queueOnce(config, `${task}:${scope}`, async () => {
      const payload = (await this.executeQuery(
        config,
        mutation,
        variables,
        false,
      )) as unknown as {
        data?: Record<string, unknown>;
      };
      const value = Object.values(payload.data ?? {})[0];
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
    });
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
