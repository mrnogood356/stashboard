import { IsIn, IsOptional, Matches } from 'class-validator';
import {
  SCENE_FAVORITES_FILTER_VALUES,
  type SceneFavoritesFilter,
} from './scenes-query.dto';
import { ScenesFeedItemDto } from './scenes-feed.dto';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Where releases come from: starred on the catalog, Whisparr, or both. */
export const CALENDAR_SOURCES = ['ALL', 'CATALOG', 'WHISPARR'] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

export class ScenesCalendarQueryDto {
  /** First day shown, YYYY-MM-DD. */
  @Matches(DAY, { message: 'from must be a YYYY-MM-DD date.' })
  from!: string;

  /** Last day shown, YYYY-MM-DD. */
  @Matches(DAY, { message: 'to must be a YYYY-MM-DD date.' })
  to!: string;

  /** Whose releases: starred studios, starred performers, or both (default). */
  @IsOptional()
  @IsIn(SCENE_FAVORITES_FILTER_VALUES)
  favorites?: SceneFavoritesFilter;

  /** Starred releases from the catalog, scenes in Whisparr, or both (default). */
  @IsOptional()
  @IsIn(CALENDAR_SOURCES)
  source?: CalendarSource;
}

export class ScenesCalendarItemDto extends ScenesFeedItemDto {
  /** Whisparr has this scene (monitored), whether or not it's downloaded. */
  inWhisparr?: boolean;
}

export class ScenesCalendarResponseDto {
  from!: string;
  to!: string;
  /** Oldest first. */
  items!: ScenesCalendarItemDto[];
  /**
   * False when the catalog had more to look through than one calendar view
   * reads, so the latest days may be missing some releases.
   */
  complete!: boolean;
  /** Whisparr's part: shown, not set up, or couldn't be reached just now. */
  whisparr!: 'ok' | 'off' | 'failed';
}
