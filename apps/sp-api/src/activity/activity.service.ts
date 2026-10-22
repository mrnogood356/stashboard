import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ActivityEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTIVITY_PAGE_SIZE,
  MAX_ACTIVITY_ENTRIES,
  MAX_DETAIL_LENGTH,
  MAX_TITLE_LENGTH,
  type ActivityEntryDto,
  type ActivityPageDto,
  type ActivityStatus,
  type ActivityUndo,
  type ActivityUndoHandler,
  type NewActivity,
} from './activity.model';

/** Trim old entries after this many new ones. */
const PRUNE_EVERY = 50;
/** How many entries one scene's history shows. */
const MENTION_LIMIT = 10;
/** Shorter words than this aren't looked for in one scene's history. */
const MIN_MENTION_LENGTH = 4;

/**
 * The activity log: a plain-English list of what Stashboard did (renames,
 * moves, deletes, Whisparr runs…), with Undo where a real undo exists.
 * Recording never throws, so it can't break the action it describes.
 */
@Injectable()
export class ActivityService implements OnModuleInit {
  private readonly logger = new Logger(ActivityService.name);

  private readonly undoHandlers = new Map<string, ActivityUndoHandler>();
  /** Entries whose undo is running right now. */
  private readonly undoing = new Set<string>();

  private sincePrune = 0;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.prune();
  }

  /** Lets a module say how to undo its entries of this type. */
  registerUndo(type: string, handler: ActivityUndoHandler): void {
    this.undoHandlers.set(type, handler);
  }

  /** Adds an entry. Never throws: a problem is logged and ignored. */
  async record(entry: NewActivity): Promise<void> {
    try {
      const { title, detail } = shorten(entry.title, entry.detail);
      if (!title) {
        return;
      }
      await this.prisma.activityEntry.create({
        data: {
          kind: entry.kind,
          title,
          detail,
          status: entry.status ?? 'done',
          count:
            entry.count === null || entry.count === undefined
              ? null
              : Math.round(entry.count),
          ...(entry.undo
            ? { undo: entry.undo as unknown as Prisma.InputJsonValue }
            : {}),
        },
      });
      this.logger.debug(
        `Activity (${entry.kind}${entry.status && entry.status !== 'done' ? `, ${entry.status}` : ''}): ${title}`,
      );
      this.sincePrune += 1;
      if (this.sincePrune >= PRUNE_EVERY) {
        this.sincePrune = 0;
        await this.prune();
      }
    } catch (error) {
      this.logger.warn(
        `Couldn’t add to the activity log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Newest first, a page at a time, optionally one kind or matching some text. */
  async list(
    options: { page?: number; kind?: string; q?: string } = {},
  ): Promise<ActivityPageDto> {
    const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
    const kind = options.kind?.trim();
    const q = options.q?.trim();
    const where: Prisma.ActivityEntryWhereInput = {
      ...(kind ? { kind } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { detail: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.activityEntry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * ACTIVITY_PAGE_SIZE,
      take: ACTIVITY_PAGE_SIZE + 1,
    });
    return {
      items: rows.slice(0, ACTIVITY_PAGE_SIZE).map((row) => this.toDto(row)),
      page,
      hasMore: rows.length > ACTIVITY_PAGE_SIZE,
    };
  }

  /**
   * The newest entries whose title or detail mentions any of these (a file
   * path, a scene title): one scene's history. Very short words are left
   * out, since they'd match almost everything.
   */
  async mentioning(
    terms: string[],
    limit = MENTION_LIMIT,
  ): Promise<ActivityEntryDto[]> {
    const wanted = [
      ...new Set(
        terms
          .map((term) => term.trim())
          .filter((term) => term.length >= MIN_MENTION_LENGTH),
      ),
    ];
    if (wanted.length === 0) {
      return [];
    }
    const rows = await this.prisma.activityEntry.findMany({
      where: {
        OR: wanted.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { detail: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => this.toDto(row));
  }

  /**
   * Runs an entry's undo, then marks it undone. A second call for the same
   * entry while the first is still running (a double-click, a retry) is
   * refused, so the undo can't run twice. This guards one API process only.
   */
  async undo(id: string): Promise<ActivityEntryDto> {
    if (this.undoing.has(id)) {
      throw new ConflictException('This is already being undone.');
    }
    this.undoing.add(id);
    try {
      return await this.runUndo(id);
    } finally {
      this.undoing.delete(id);
    }
  }

  private async runUndo(id: string): Promise<ActivityEntryDto> {
    const entry = await this.prisma.activityEntry.findUnique({
      where: { id },
    });
    if (!entry) {
      throw new NotFoundException('That activity isn’t in the log anymore.');
    }
    const undo = asUndo(entry.undo);
    if (entry.undoneAt) {
      throw new ConflictException('This was already undone.');
    }
    const handler = undo ? this.undoHandlers.get(undo.type) : undefined;
    if (!undo || !handler) {
      throw new ConflictException('This can’t be undone.');
    }
    this.logger.log(`Undoing “${entry.title}”.`);
    try {
      await handler(undo);
    } catch (error) {
      this.logger.error(
        `Undoing “${entry.title}” failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
    const saved = await this.prisma.activityEntry.update({
      where: { id },
      data: { undoneAt: new Date() },
    });
    return this.toDto(saved);
  }

  /** Marks entries undone when their undo happened elsewhere (e.g. Undo last). */
  async markUndone(type: string, key: string, value: string): Promise<void> {
    try {
      await this.prisma.activityEntry.updateMany({
        where: {
          undoneAt: null,
          AND: [
            { undo: { path: ['type'], equals: type } },
            { undo: { path: [key], equals: value } },
          ],
        },
        data: { undoneAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `Couldn’t update the activity log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Keeps only the newest entries. */
  async prune(): Promise<void> {
    try {
      const cutoff = await this.prisma.activityEntry.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: MAX_ACTIVITY_ENTRIES - 1,
        select: { createdAt: true },
      });
      if (!cutoff) {
        return;
      }
      await this.prisma.activityEntry.deleteMany({
        where: { createdAt: { lt: cutoff.createdAt } },
      });
    } catch (error) {
      this.logger.warn(
        `Couldn’t trim the activity log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private toDto(row: ActivityEntry): ActivityEntryDto {
    const undo = asUndo(row.undo);
    return {
      id: row.id,
      at: row.createdAt.toISOString(),
      kind: row.kind,
      title: row.title,
      detail: row.detail,
      status: asStatus(row.status),
      count: row.count,
      canUndo: Boolean(
        undo && !row.undoneAt && this.undoHandlers.has(undo.type),
      ),
      undoneAt: row.undoneAt?.toISOString() ?? null,
    };
  }
}

/** A long title moves to the detail, and the title keeps its start. */
export function shorten(
  rawTitle: string,
  rawDetail?: string | null,
): { title: string; detail: string | null } {
  const title = (rawTitle ?? '').replace(/\s+/g, ' ').trim();
  let detail = rawDetail?.trim() || null;
  if (title.length <= MAX_TITLE_LENGTH) {
    return { title, detail: detail?.slice(0, MAX_DETAIL_LENGTH) ?? null };
  }
  const firstSentence = title.match(/^.+?[.!?](?=\s+[A-Z“"]|$)/)?.[0];
  const short =
    firstSentence && firstSentence.length <= MAX_TITLE_LENGTH
      ? firstSentence
      : `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
  detail = detail ? `${title}\n\n${detail}` : title;
  return { title: short, detail: detail.slice(0, MAX_DETAIL_LENGTH) };
}

function asUndo(value: Prisma.JsonValue | null): ActivityUndo | null {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === 'string'
  ) {
    return value as unknown as ActivityUndo;
  }
  return null;
}

function asStatus(value: string): ActivityStatus {
  return value === 'failed' || value === 'partial' ? value : 'done';
}
