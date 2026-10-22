export type HeartbeatStatus = 'ok' | 'warn' | 'failed' | 'off';

export interface Heartbeat {
  at: string;
  status: HeartbeatStatus;
  message: string | null;
}

export type HeartbeatJob = 'folder-watch' | 'download-watch';

/**
 * When the background watchers that keep nothing in the database last ran,
 * and how it went, for About & health. In memory: after a restart they show
 * as not run yet until their next pass (a minute or so).
 */
export class JobHeartbeats {
  private readonly beats = new Map<HeartbeatJob, Heartbeat>();

  record(
    job: HeartbeatJob,
    status: HeartbeatStatus,
    message: string | null = null,
  ): void {
    this.beats.set(job, { at: new Date().toISOString(), status, message });
  }

  get(job: HeartbeatJob): Heartbeat | null {
    return this.beats.get(job) ?? null;
  }

  clear(): void {
    this.beats.clear();
  }
}

/** The one the watchers report to. */
export const jobHeartbeats = new JobHeartbeats();
