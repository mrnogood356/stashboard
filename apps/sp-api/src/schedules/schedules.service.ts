import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FollowsService } from '../follows/follows.service';
import { OrganizerService } from '../organizer/organizer.service';
import { LocalLibraryService } from '../playback/local-library.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  isDue,
  JOB_INFO,
  nextRun,
  SCHEDULED_JOBS,
  type ScheduledJob,
  type ScheduleTime,
} from './schedules.util';

export interface ScheduleDto extends ScheduleTime {
  job: ScheduledJob;
  label: string;
  detail: string;
  /** Where its on/off lives, when that isn't here. */
  switchIn: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  nextRunAt: string | null;
}

export interface SchedulesDto {
  /** The server's clock, so the times read right: "Server time 14:02 (Europe/London)". */
  serverTime: string;
  timeZone: string;
  schedules: ScheduleDto[];
}

/**
 * Runs the scheduled jobs at the times set in Library tools → Schedules,
 * checking once a minute. The organizer's two keep their own on/off.
 */
@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);
  private ticking = false;
  /** Swapped in tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly organizer?: OrganizerService,
    @Optional() private readonly library?: LocalLibraryService,
    @Optional() private readonly follows?: FollowsService,
  ) {}

  async list(): Promise<SchedulesDto> {
    const rows = new Map(
      (await this.prisma.jobSchedule.findMany()).map((row) => [row.job, row]),
    );
    const now = this.now();
    // The organizer's two jobs are switched on and off in its own settings.
    const organizer = await this.organizer?.getSettings().catch(() => null);
    const switchedOn: Partial<Record<ScheduledJob, boolean>> = {
      'organizer-match': organizer?.autoMatchNightly ?? false,
      'send-missing': organizer?.sendToWhisparr ?? false,
    };
    return {
      serverTime: now.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedules: SCHEDULED_JOBS.map((job) => {
        const info = JOB_INFO[job];
        const row = rows.get(job);
        const time: ScheduleTime = row
          ? {
              enabled: row.enabled,
              hour: row.hour,
              minute: row.minute,
              days: row.days,
            }
          : info.defaults;
        const runs = info.switchIn ? (switchedOn[job] ?? false) : time.enabled;
        return {
          job,
          label: info.label,
          detail: info.detail,
          switchIn: info.switchIn ?? null,
          ...time,
          enabled: runs,
          lastRunAt: row?.lastRunAt?.toISOString() ?? null,
          lastStatus: row?.lastStatus ?? null,
          nextRunAt: runs ? (nextRun(time, now)?.toISOString() ?? null) : null,
        };
      }),
    };
  }

  /** Every job's times, saved or default, for Settings → Backup. */
  async exportForBackup(): Promise<{
    schedules: Array<ScheduleTime & { job: ScheduledJob }>;
  }> {
    const rows = new Map(
      (await this.prisma.jobSchedule.findMany()).map((row) => [row.job, row]),
    );
    return {
      schedules: SCHEDULED_JOBS.map((job) => {
        const row = rows.get(job);
        const time = row
          ? {
              enabled: row.enabled,
              hour: row.hour,
              minute: row.minute,
              days: row.days,
            }
          : JOB_INFO[job].defaults;
        return { job, ...time, days: [...time.days] };
      }),
    };
  }

  async restoreFromBackup(input: {
    schedules: Array<ScheduleTime & { job: string }>;
  }): Promise<void> {
    for (const { job, ...time } of input.schedules) {
      await this.update(job, time);
    }
  }

  async update(job: string, input: ScheduleTime): Promise<SchedulesDto> {
    if (!(SCHEDULED_JOBS as readonly string[]).includes(job)) {
      throw new BadRequestException('There’s no such job.');
    }
    const days = [...new Set(input.days)]
      .filter((day) => day >= 0 && day <= 6)
      .sort();
    const data = {
      enabled: input.enabled,
      hour: input.hour,
      minute: input.minute,
      days: days.length === 7 ? [] : days,
    };
    await this.prisma.jobSchedule.upsert({
      where: { job },
      create: { job, ...data },
      update: data,
    });
    return this.list();
  }

  @Interval(60_000)
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const now = this.now();
      const { schedules } = await this.list();
      for (const schedule of schedules) {
        // The organizer's jobs run at their time either way and say why they
        // did nothing; Stash's only when switched on.
        const runs = schedule.switchIn !== null || schedule.enabled;
        const last = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
        if (runs && isDue(schedule, now, last)) {
          await this.run(schedule.job, now);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Schedules check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async run(job: ScheduledJob, now: Date): Promise<void> {
    let status = 'Started';
    try {
      switch (job) {
        case 'organizer-match':
          // Says whether it started, was off, or the organizer was busy.
          status = (await this.organizer?.nightly()) ?? status;
          break;
        case 'send-missing':
          status = (await this.organizer?.sendMissingDaily()) ?? status;
          break;
        case 'stash-scan':
        case 'stash-generate':
        case 'stash-clean':
          // Stash's job waits its turn behind Stash's others: noted as asked
          // now, and updated once it starts, without holding up the rest.
          if (this.library) {
            status = 'Waiting its turn in Stash';
            this.startInBackground(job, STASH_TASKS[job], now);
          }
          break;
        case 'follow-check':
          status = (await this.follows?.runScheduled()) ?? status;
          break;
      }
    } catch (error) {
      status =
        `Failed: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        );
      this.logger.warn(
        `Scheduled ${JOB_INFO[job].label.toLowerCase()} ${status.toLowerCase()}`,
      );
    }
    await this.record(job, now, status);
  }

  private startInBackground(
    job: ScheduledJob,
    task: 'scan' | 'generate' | 'clean',
    now: Date,
  ): void {
    void this.library!.startJob(task, { now: false })
      .then(() => 'Started')
      .catch((error: unknown) => {
        const status = `Failed: ${error instanceof Error ? error.message : String(error)}`;
        this.logger.warn(
          `Scheduled ${JOB_INFO[job].label.toLowerCase()} ${status.toLowerCase()}`,
        );
        return status;
      })
      .then((status) => this.record(job, now, status))
      .catch((error: unknown) =>
        this.logger.warn(
          `Couldn't note how ${JOB_INFO[job].label.toLowerCase()} went: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  private async record(
    job: ScheduledJob,
    now: Date,
    status: string,
  ): Promise<void> {
    await this.prisma.jobSchedule.upsert({
      where: { job },
      create: {
        job,
        ...JOB_INFO[job].defaults,
        lastRunAt: now,
        lastStatus: status.slice(0, 300),
      },
      update: { lastRunAt: now, lastStatus: status.slice(0, 300) },
    });
  }
}

/** Stash's library task for each of its scheduled jobs. */
const STASH_TASKS = {
  'stash-scan': 'scan',
  'stash-generate': 'generate',
  'stash-clean': 'clean',
} as const;
