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
          await this.library?.startJob('scan');
          break;
        case 'stash-generate':
          await this.library?.startJob('generate');
          break;
        case 'stash-clean':
          await this.library?.startJob('clean');
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
