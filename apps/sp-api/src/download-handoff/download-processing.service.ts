import { Injectable, Logger } from '@nestjs/common';
import { DownloadDropIn, DownloadHandoff } from '@prisma/client';
import * as path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import {
  SabnzbdAdapter,
  SabnzbdHistoryEntry,
  SabnzbdQueueEntry,
} from '../providers/sabnzbd/sabnzbd.adapter';
import { DownloadDropInService, toDropInDto } from './download-drop-in.service';
import { DownloadHandoffService, toDto } from './download-handoff.service';
import {
  DEFAULT_HANDOFF_CATEGORY,
  OPEN_HANDOFF_STATUSES,
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

interface LiveSab {
  at: number;
  category: string;
  queue: Map<string, SabnzbdQueueEntry>;
  history: Map<string, SabnzbdHistoryEntry>;
}

/**
 * The Processing page: everything moving through the download pipeline in
 * one place. Downloads sent to SABnzbd (with SABnzbd's progress while it
 * has them), then moving, waiting for Stash and linking; and drop-ins, with
 * what the folder watcher is doing.
 */
@Injectable()
export class DownloadProcessingService {
  private readonly logger = new Logger(DownloadProcessingService.name);
  private live: LiveSab | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly handoff: DownloadHandoffService,
    private readonly dropIns: DownloadDropInService,
    private readonly sabnzbd: SabnzbdAdapter,
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
          where: { status: { notIn: OPEN_HANDOFF_STATUSES } },
          orderBy: { updatedAt: 'desc' },
          take: RECENT_LIMIT,
        }),
        this.prisma.downloadDropIn.findMany({
          where: { status: 'placed' },
          orderBy: { createdAt: 'desc' },
          take: OPEN_LIMIT,
        }),
        this.prisma.downloadDropIn.findMany({
          where: { status: { in: ['imported', 'failed'] } },
          orderBy: { updatedAt: 'desc' },
          take: RECENT_LIMIT,
        }),
      ]);
    const category = settings.category || DEFAULT_HANDOFF_CATEGORY;
    const waiting = open.some((row) => row.status !== 'completed');
    const live =
      sab && waiting ? await this.liveSab(sab, category, now) : undefined;
    const watch = this.dropIns.status();

    const handoffs = open.map((row) => handoffItem(row, live ?? null));
    const recentHandoffs = done.map((row) => handoffItem(row, null));
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
    detail,
    progress,
    timeLeft,
    canRetry: row.status === 'failed',
    canIgnore: OPEN_HANDOFF_STATUSES.includes(row.status as HandoffStatus),
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
          `Moved to ${row.finalPath ?? 'the library'}; waiting for Stash to pick it up and link it.`,
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

function dropInItem(row: DownloadDropIn): ProcessingDropInDto {
  return {
    ...toDropInDto(row),
    name: path.basename(row.sourcePath),
    canRetry: row.status === 'failed',
  };
}
