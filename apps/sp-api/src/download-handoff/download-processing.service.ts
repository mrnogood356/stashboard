import { Injectable, Logger, Optional } from '@nestjs/common';
import { DownloadDropIn, DownloadHandoff } from '@prisma/client';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { stashMediaUrl } from '../media/media-url.util';
import { CatalogProviderService } from '../providers/catalog/catalog-provider.service';
import { StashdbAdapter } from '../providers/stashdb/stashdb.adapter';
import { withStashImageSize } from '../providers/stashdb/stashdb-image-url.util';
import {
  SabnzbdAdapter,
  SabnzbdHistoryEntry,
  SabnzbdQueueEntry,
} from '../providers/sabnzbd/sabnzbd.adapter';
import { DownloadDropInService, toDropInDto } from './download-drop-in.service';
import { DownloadHandoffService, toDto } from './download-handoff.service';
import {
  DEFAULT_HANDOFF_CATEGORY,
  MANUAL_HANDOFF_SOURCE,
  OPEN_HANDOFF_STATUSES,
  type HandoffSceneDto,
  type HandoffStatus,
  type ProcessingDropInDto,
  type ProcessingDto,
  type ProcessingHandoffDto,
} from './download-handoff.model';

/** SABnzbd's queue and history are asked at most this often (the page polls). */
const LIVE_TTL_MS = 4_000;
const OPEN_LIMIT = 50;
const RECENT_LIMIT = 10;
const PROBLEM_WINDOW_MS = 24 * 3600_000;
/** Scenes looked up in the catalog for Downloads are remembered this long. */
const CATALOG_SCENE_TTL_MS = 6 * 3600_000;
/** A scene the catalog couldn't give is asked for again after this. */
const CATALOG_MISS_TTL_MS = 10 * 60_000;
/** At most this many catalog lookups per page load; the rest come next time. */
const CATALOG_LOOKUPS_PER_LOAD = 8;

interface LiveSab {
  at: number;
  category: string;
  queue: Map<string, SabnzbdQueueEntry>;
  history: Map<string, SabnzbdHistoryEntry>;
}

/**
 * The Processing page: everything moving through the download pipeline in
 * one place. Downloads sent to SABnzbd, or added there by hand and picked
 * up (with SABnzbd's progress while it has them), then moving, waiting for Stash and linking; and drop-ins, with
 * what the folder watcher is doing.
 */
@Injectable()
export class DownloadProcessingService {
  private readonly logger = new Logger(DownloadProcessingService.name);
  private live: LiveSab | null = null;
  private readonly catalogScenes = new Map<
    string,
    { scene: HandoffSceneDto | null; until: number }
  >();
  private readonly pendingLookups = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly handoff: DownloadHandoffService,
    private readonly dropIns: DownloadDropInService,
    private readonly sabnzbd: SabnzbdAdapter,
    @Optional() private readonly catalog?: CatalogProviderService,
    @Optional() private readonly stashdb?: StashdbAdapter,
  ) {}

  async snapshot(now = Date.now()): Promise<ProcessingDto> {
    const [settings, sab, open, done, placed, recentDropIns] =
      await Promise.all([
        this.handoff.getSettings(),
        this.handoff.sabConfig(),
        this.prisma.downloadHandoff.findMany({
          where: { status: { in: OPEN_HANDOFF_STATUSES } },
          orderBy: { createdAt: 'desc' },
          take: OPEN_LIMIT,
        }),
        this.prisma.downloadHandoff.findMany({
          where: { status: { notIn: OPEN_HANDOFF_STATUSES }, clearedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: RECENT_LIMIT,
        }),
        this.prisma.downloadDropIn.findMany({
          where: { status: 'placed' },
          orderBy: { createdAt: 'desc' },
          take: OPEN_LIMIT,
        }),
        this.prisma.downloadDropIn.findMany({
          where: { status: { in: ['imported', 'failed'] }, clearedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: RECENT_LIMIT,
        }),
      ]);
    const category = settings.category || DEFAULT_HANDOFF_CATEGORY;
    const waiting = open.some((row) => row.status !== 'completed');
    const live =
      sab && waiting ? await this.liveSab(sab, category, now) : undefined;
    const watch = this.dropIns.status();

    const scenes = await this.scenesFor([...open, ...done]);
    const withScene = (item: ProcessingHandoffDto): ProcessingHandoffDto => ({
      ...item,
      scene:
        (item.sceneId && scenes.get(item.sceneId)) ||
        libraryScene(item.stashSceneId, item.releaseTitle),
    });
    const handoffs = open.map((row) =>
      withScene(handoffItem(row, live ?? null)),
    );
    const recentHandoffs = done.map((row) => withScene(handoffItem(row, null)));
    const recent = recentDropIns.map(dropInItem);
    const since = now - PROBLEM_WINDOW_MS;
    const recentFailures =
      recentHandoffs.filter(
        (row) => row.status === 'failed' && Date.parse(row.updatedAt) >= since,
      ).length +
      recent.filter(
        (row) => row.status === 'failed' && Date.parse(row.updatedAt) >= since,
      ).length;
    return {
      handoff: {
        enabled: settings.enabled,
        sabnzbdReady: sab !== null,
        category,
        sabnzbdUnreachable: live === null,
      },
      handoffs,
      recentHandoffs,
      dropIns: {
        watch,
        active: placed.map(dropInItem),
        recent,
      },
      activeCount: handoffs.length + watch.settling.length + placed.length,
      problemCount: recentFailures + (watch.state === 'problem' ? 1 : 0),
    };
  }

  /**
   * Takes finished, failed or ignored downloads off the list: one, or every
   * one when no id is given. They stay recorded, so a finished SABnzbd job
   * or a dropped-in file is never brought in twice. Downloads still on
   * their way are left alone.
   */
  async clearHandoffs(id?: string): Promise<number> {
    const { count } = await this.prisma.downloadHandoff.updateMany({
      where: {
        ...(id ? { id } : {}),
        status: { notIn: OPEN_HANDOFF_STATUSES },
        clearedAt: null,
      },
      data: { clearedAt: new Date() },
    });
    return count;
  }

  /** The same for files brought in from the drop-in folder. */
  async clearDropIns(id?: string): Promise<number> {
    const { count } = await this.prisma.downloadDropIn.updateMany({
      where: {
        ...(id ? { id } : {}),
        status: { in: ['imported', 'failed'] },
        clearedAt: null,
      },
      data: { clearedAt: new Date() },
    });
    return count;
  }

  /** Clears the whole history: finished and failed downloads and drop-ins. */
  async clearHistory(): Promise<void> {
    const [handoffs, dropIns] = await Promise.all([
      this.clearHandoffs(),
      this.clearDropIns(),
    ]);
    this.logger.log(
      `Cleared ${handoffs + dropIns} finished download${handoffs + dropIns === 1 ? '' : 's'} from the list.`,
    );
  }

  /**
   * The scenes these downloads are for, by id: from Stashboard's own index,
   * else from the catalog (StashDB or FansDB) itself, remembered for a while
   * so the page refreshing every few seconds doesn't ask again.
   */
  private async scenesFor(
    rows: DownloadHandoff[],
  ): Promise<Map<string, HandoffSceneDto>> {
    const providerOf = new Map<string, string | null>();
    for (const row of rows) {
      if (row.sceneId && !providerOf.has(row.sceneId)) {
        providerOf.set(row.sceneId, row.provider);
      }
    }
    const ids = [...providerOf.keys()];
    if (ids.length === 0) {
      return new Map();
    }
    const scenes = new Map<string, HandoffSceneDto>();
    try {
      const found = await this.prisma.sceneIndex.findMany({
        where: { stashId: { in: ids }, title: { not: null } },
        select: {
          stashId: true,
          title: true,
          imageUrl: true,
          studioName: true,
        },
      });
      for (const scene of found) {
        scenes.set(scene.stashId, {
          title: scene.title ?? scene.stashId,
          imageUrl: scene.imageUrl
            ? withStashImageSize(scene.imageUrl, 600)
            : null,
          studio: scene.studioName,
        });
      }
    } catch (error) {
      // The list still works with release names alone.
      this.logger.debug(
        `Scene details for downloads left off: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const missing = ids.filter((id) => !scenes.has(id));
    const now = Date.now();
    const toAsk = missing
      .filter((id) => {
        const known = this.catalogScenes.get(id);
        return !known || known.until <= now;
      })
      .slice(0, CATALOG_LOOKUPS_PER_LOAD);
    await Promise.all(
      toAsk.map((id) => {
        // Overlapping loads (polling, a second tab) share one request.
        let pending = this.pendingLookups.get(id);
        if (!pending) {
          pending = this.lookUpCatalogScene(
            id,
            providerOf.get(id),
            now,
          ).finally(() => this.pendingLookups.delete(id));
          this.pendingLookups.set(id, pending);
        }
        return pending;
      }),
    );
    for (const id of missing) {
      const scene = this.catalogScenes.get(id)?.scene;
      if (scene) {
        scenes.set(id, scene);
      }
    }
    return scenes;
  }

  /** One scene straight from its catalog; remembers a miss for a shorter while. */
  private async lookUpCatalogScene(
    id: string,
    provider: string | null | undefined,
    now: number,
  ): Promise<void> {
    if (!this.catalog || !this.stashdb) {
      return;
    }
    let scene: HandoffSceneDto | null = null;
    try {
      const catalog = await this.catalog.getProvider(
        provider === 'FANSDB' ? 'FANSDB' : 'STASHDB',
      );
      const details = await this.stashdb.getSceneById(id, {
        baseUrl: catalog.baseUrl,
        apiKey: catalog.apiKey,
      });
      scene = {
        title: details.title,
        imageUrl: details.imageUrl
          ? withStashImageSize(details.imageUrl, 600)
          : null,
        studio: details.studioName ?? null,
      };
    } catch (error) {
      this.logger.debug(
        `Couldn't look up scene ${id} for Downloads: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (this.catalogScenes.size > 500) {
      this.catalogScenes.clear();
    }
    this.catalogScenes.set(id, {
      scene,
      until: now + (scene ? CATALOG_SCENE_TTL_MS : CATALOG_MISS_TTL_MS),
    });
  }

  /** SABnzbd's queue and history for the category, briefly cached; null when unreachable. */
  private async liveSab(
    config: { baseUrl: string; apiKey?: string | null },
    category: string,
    now: number,
  ): Promise<LiveSab | null> {
    if (
      this.live &&
      this.live.category === category &&
      now - this.live.at < LIVE_TTL_MS
    ) {
      return this.live;
    }
    try {
      const [queue, history] = await Promise.all([
        this.sabnzbd.queue(config, category),
        this.sabnzbd.history(config, category),
      ]);
      this.live = {
        at: now,
        category,
        queue: new Map(queue.map((entry) => [entry.nzoId, entry])),
        history: new Map(history.map((entry) => [entry.nzoId, entry])),
      };
      return this.live;
    } catch (error) {
      this.logger.debug(
        `Couldn't read SABnzbd's queue for the Processing page: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return null;
    }
  }
}

/** Where one download is, with SABnzbd's progress while it has it. */
export function handoffItem(
  row: DownloadHandoff,
  live: Pick<LiveSab, 'queue' | 'history'> | null,
): ProcessingHandoffDto {
  const base = toDto(row);
  const item = (
    stage: ProcessingHandoffDto['stage'],
    detail: string | null,
    progress: number | null = null,
    timeLeft: string | null = null,
  ): ProcessingHandoffDto => ({
    ...base,
    stage,
    scene: null,
    detail,
    progress,
    timeLeft,
    canRetry: row.status === 'failed',
    canIgnore: OPEN_HANDOFF_STATUSES.includes(row.status as HandoffStatus),
    canClear: !OPEN_HANDOFF_STATUSES.includes(row.status as HandoffStatus),
  });
  switch (row.status as HandoffStatus) {
    case 'imported':
      return item('done', row.finalPath ? `In ${row.finalPath}` : null);
    case 'failed':
      return item('failed', row.error);
    case 'ignored':
      return item('ignored', row.error);
    case 'completed':
      return item(
        'linking',
        row.error ??
          `Moved to ${row.finalPath ?? 'the library'}; waiting for Stash to pick it up and ${row.source === MANUAL_HANDOFF_SOURCE ? 'identify' : 'link'} it.`,
      );
    default:
      break;
  }
  const queued = live?.queue.get(row.nzoId);
  if (queued) {
    const status = queued.status.toLowerCase();
    const progress =
      typeof queued.percentage === 'number'
        ? Math.max(0, Math.min(100, Math.round(queued.percentage)))
        : null;
    return status === 'downloading'
      ? item('downloading', null, progress, queued.timeLeft ?? null)
      : item(
          'queued',
          status === 'paused'
            ? 'Paused in SABnzbd.'
            : `${queued.status} in SABnzbd.`,
          progress,
          queued.timeLeft ?? null,
        );
  }
  const finished = live?.history.get(row.nzoId);
  if (finished) {
    const status = finished.status.toLowerCase();
    if (status === 'completed') {
      return item(
        'moving',
        'SABnzbd finished it; Stashboard moves it into your library on its next check.',
        100,
      );
    }
    if (status === 'failed') {
      return item(
        'failed',
        `SABnzbd couldn’t download it: ${finished.failMessage ?? 'it gave no reason'}.`,
      );
    }
    return item('unpacking', `${finished.status} in SABnzbd.`, 100);
  }
  return row.status === 'downloading'
    ? item('downloading', row.error)
    : item('queued', row.error ?? 'Sent to SABnzbd.');
}

/**
 * A download already in the library (added in SABnzbd, or not in the
 * catalog): its picture is Stash's screenshot, its title the release.
 */
function libraryScene(
  stashSceneId: string | null,
  title: string,
): HandoffSceneDto | null {
  return stashSceneId
    ? {
        title,
        imageUrl: libraryScreenshot(stashSceneId),
        studio: null,
      }
    : null;
}

function libraryScreenshot(stashSceneId: string): string {
  return stashMediaUrl(
    `scenes/${encodeURIComponent(stashSceneId)}/screenshot`,
    null,
    480,
  );
}

function dropInItem(row: DownloadDropIn): ProcessingDropInDto {
  return {
    ...toDropInDto(row),
    imageUrl: row.stashSceneId ? libraryScreenshot(row.stashSceneId) : null,
    name: path.basename(row.sourcePath),
    canRetry: row.status === 'failed',
    canClear: row.status === 'imported' || row.status === 'failed',
  };
}
