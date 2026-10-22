import { SceneStatusDto } from '../../scene-status/dto/scene-status.dto';
import { type CatalogProviderKey } from '../../providers/catalog/catalog-provider.util';
import { HOME_RAIL_SOURCE_VALUES, type HomeRailSource } from './home-rail.dto';

export class HomeRailItemDto {
  id!: string;
  title!: string;
  description!: string | null;
  imageUrl!: string | null;
  cardImageUrl!: string | null;
  studioId!: string | null;
  studio!: string | null;
  studioImageUrl!: string | null;
  releaseDate!: string | null;
  duration!: number | null;
  type!: 'SCENE';
  /** STASH for library scenes, otherwise the catalog the scene came from. */
  source!: HomeRailSource | CatalogProviderKey;
  status!: SceneStatusDto;
  requestable!: boolean;
  viewUrl!: string | null;
  /** How far through the scene playback got, 0 to 1 (Continue Watching). */
  progress?: number | null;
}

export class HomeRailContentDto {
  items!: HomeRailItemDto[];
  message!: string | null;
}

export { HOME_RAIL_SOURCE_VALUES };
