import { Injectable } from '@nestjs/common';
import {
  DownloadHandoff,
  IntegrationStatus,
  IntegrationType,
  SceneIndex,
  SceneLifecycle,
} from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { DownloadHandoffService } from '../download-handoff/download-handoff.service';
import { OrganizerService } from '../organizer/organizer.service';
import { messageOf } from '../organizer/organizer-plan.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  SabnzbdAdapter,
  SabnzbdQueueEntry,
} from '../providers/sabnzbd/sabnzbd.adapter';
import type { StashOrganizerScene } from '../providers/stash/stash.adapter';
import {
  WhisparrAdapter,
  WhisparrAdapterBaseConfig,
  WhisparrHistoryEvent,
  WhisparrQueueDetail,
} from '../providers/whisparr/whisparr.adapter';
import { sameSceneIds } from './same-scene.util';
import { SceneTimelineDto, TIMELINE_BATCH_LIMIT } from './scene-timeline.model';
import { buildTimeline, Known } from './scene-timeline.util';

const OPEN_HANDOFF = ['sent', 'downloading'];

/**
 * A scene's request as a short story (Requested → … → Previews generated),
 * merged from Stashboard's request records and index, Whisparr's history and
 * queue, Finished downloads, the activity log, renames and Stash. Each
 * source fails on its own: its steps say unknown, the rest still show.
 * Only looks; nothing is changed or refreshed.
 */
@Injectable()
export class SceneTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizer: OrganizerService,
    private readonly activity: ActivityService,
    private readonly whisparr: WhisparrAdapter,
    private readonly sabnzbd: SabnzbdAdapter,
    private readonly handoff: DownloadHandoffService,
  ) {}

  /** The whole story for one catalog scene, for its page. */
  async forScene(stashId: string): Promise<SceneTimelineDto> {
    const id = stashId.trim();
    const ids = await sameSceneIds(this.prisma, id);
    const [row, request, handoffs, whisparrConfig, stashReady] =
      await Promise.all([
        this.prisma.sceneIndex
          .findUnique({ where: { stashId: id } })
          .catch(() => null),
        this.prisma.request
          .findFirst({
            where: { stashId: { in: ids } },
            orderBy: { updatedAt: 'desc' },
          })
          .catch(() => null),
        this.handoffsFor(ids, 1),
        this.whisparrConfig(),
        this.handoff.stashConfig().then((config) => config !== null),
      ]);
    const movie =
      whisparrConfig && (row?.whisparrMovieId != null || request)
        ? await attempt(async () =>
            row?.whisparrMovieId != null
              ? row.whisparrMovieId
              : ((await this.whisparr.findMovieByStashId(id, whisparrConfig))
                  ?.movieId ?? null),
          )
        : null;
    const movieId = movie?.value ?? null;
    const whisparrFailed = movie?.error
      ? { value: null, error: movie.error }
      : null;
    const [queue, history, sabQueue, stash, waiting] = await Promise.all([
      whisparrFailed ??
        (whisparrConfig && movieId !== null
          ? attempt(() =>
              this.whisparr.getQueueDetails(whisparrConfig, movieId),
            )
          : Promise.resolve<Known<WhisparrQueueDetail[]> | null>(null)),
      whisparrFailed ??
        (whisparrConfig && movieId !== null
          ? attempt(() =>
              this.whisparr.getMovieHistory(whisparrConfig, movieId),
            )
          : Promise.resolve<Known<WhisparrHistoryEvent[]> | null>(null)),
      this.sabQueueFor(handoffs),
      stashReady
        ? attempt(() => this.organizer.stashScenesLinkedTo(ids))
        : Promise.resolve(undefined),
      row?.computedLifecycle === SceneLifecycle.IMPORT_PENDING
        ? this.organizer.explainWaitingScene(row).catch(() => null)
        : Promise.resolve(null),
    ]);
    const scenes = stash?.value ?? [];
    const titles = [row?.title, ...scenes.map((scene) => scene.title)].flatMap(
      (title) => (title ? [title] : []),
    );
    const [renames, activity] = await Promise.all([
      this.renamesFor(scenes),
      attempt(() => this.activity.mentioning(titles)),
    ]);
    return buildTimeline({
      stashId: id,
      request,
      row,
      handoffs,
      queue,
      history,
      sabQueue,
      stash,
      renames,
      waiting,
      activity,
      titles,
    });
  }

  /**
   * The short version for many scenes at once (a page of Acquisition
   * cards): Stashboard's own records, plus one look at Whisparr's queue and
   * SABnzbd's for progress. Stash, history and the activity log are left
   * out to keep it cheap; the scene's own page has those.
   */
  async forScenes(stashIds: string[]): Promise<SceneTimelineDto[]> {
    const ids = [
      ...new Set(stashIds.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, TIMELINE_BATCH_LIMIT);
    if (ids.length === 0) {
      return [];
    }
    const [rows, requests, handoffs, whisparrConfig] = await Promise.all([
      this.prisma.sceneIndex
        .findMany({ where: { stashId: { in: ids } } })
        .catch(() => [] as SceneIndex[]),
      this.prisma.request
        .findMany({ where: { stashId: { in: ids } } })
        .catch(
          () =>
            [] as Array<{ stashId: string; createdAt: Date; updatedAt: Date }>,
        ),
      this.handoffsFor(ids),
      this.whisparrConfig(),
    ]);
    const waitingInWhisparr = rows.some(
      (row) =>
        row.whisparrMovieId !== null &&
        row.computedLifecycle !== SceneLifecycle.AVAILABLE,
    );
    const [queue, sabQueue] = await Promise.all([
      whisparrConfig && waitingInWhisparr
        ? attempt(() => this.whisparr.getQueueDetails(whisparrConfig))
        : Promise.resolve(null),
      this.sabQueueFor(handoffs),
    ]);
    return ids.map((id) => {
      const row = rows.find((entry) => entry.stashId === id) ?? null;
      const movieId = row?.whisparrMovieId ?? null;
      return buildTimeline({
        stashId: id,
        request: requests.find((entry) => entry.stashId === id) ?? null,
        row,
        handoffs: handoffs.filter((entry) => entry.sceneId === id),
        queue:
          queue && movieId !== null
            ? {
                value:
                  queue.value?.filter((entry) => entry.movieId === movieId) ??
                  null,
                error: queue.error,
              }
            : null,
        sabQueue,
      });
    });
  }

  /** Downloads sent to SABnzbd for these scenes, newest first. */
  private handoffsFor(
    sceneIds: string[],
    take?: number,
  ): Promise<DownloadHandoff[]> {
    return this.prisma.downloadHandoff
      .findMany({
        where: { sceneId: { in: sceneIds } },
        orderBy: { createdAt: 'desc' },
        ...(take ? { take } : {}),
      })
      .catch(() => [] as DownloadHandoff[]);
  }

  /** SABnzbd's queue, only when one of these downloads is still in it. */
  private async sabQueueFor(
    handoffs: DownloadHandoff[],
  ): Promise<Known<SabnzbdQueueEntry[]> | null> {
    if (!handoffs.some((row) => OPEN_HANDOFF.includes(row.status))) {
      return null;
    }
    const config = await this.handoff.sabConfig();
    if (!config) {
      return null;
    }
    return attempt(async () =>
      this.sabnzbd.queue(config, (await this.handoff.getSettings()).category),
    );
  }

  /** Stashboard's latest rename of these scenes' files that wasn't undone. */
  private async renamesFor(
    scenes: StashOrganizerScene[],
  ): Promise<Array<{ toPath: string; createdAt: Date }>> {
    if (scenes.length === 0) {
      return [];
    }
    return this.prisma.organizerRename
      .findMany({
        where: {
          sceneId: { in: scenes.map((scene) => scene.id) },
          undoneAt: null,
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      })
      .catch(() => []);
  }

  /** Whisparr, when it's set up; null otherwise (its steps then use the index). */
  private async whisparrConfig(): Promise<WhisparrAdapterBaseConfig | null> {
    const integration = await this.prisma.integrationConfig
      .findUnique({ where: { type: IntegrationType.WHISPARR } })
      .catch(() => null);
    const baseUrl = integration?.baseUrl?.trim();
    if (
      !integration ||
      !integration.enabled ||
      integration.status !== IntegrationStatus.CONFIGURED ||
      !baseUrl
    ) {
      return null;
    }
    return { baseUrl, apiKey: integration.apiKey };
  }
}

async function attempt<T>(work: () => Promise<T>): Promise<Known<T>> {
  try {
    return { value: await work(), error: null };
  } catch (error) {
    return { value: null, error: messageOf(error) };
  }
}
