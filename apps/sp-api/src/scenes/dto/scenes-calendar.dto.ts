import { IsIn, IsOptional, Matches } from 'class-validator';
import {
  SCENE_FAVORITES_FILTER_VALUES,
  type SceneFavoritesFilter,
} from './scenes-query.dto';
import { ScenesFeedItemDto } from './scenes-feed.dto';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
}

export class ScenesCalendarResponseDto {
  from!: string;
  to!: string;
  /** Oldest first. */
  items!: ScenesFeedItemDto[];
  /**
   * False when the catalog had more to look through than one calendar view
   * reads, so the earliest days may be missing some releases.
   */
  complete!: boolean;
}
