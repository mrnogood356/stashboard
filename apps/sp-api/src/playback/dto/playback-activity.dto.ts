import { IsNumber, Max, Min } from 'class-validator';

export class PlaybackActivityDto {
  /** Seconds into the video where playback is now. */
  @IsNumber()
  @Min(0)
  @Max(7 * 24 * 3600)
  resumeTime!: number;

  /** Seconds watched since the previous save. */
  @IsNumber()
  @Min(0)
  @Max(24 * 3600)
  playDuration!: number;
}
