import { SceneStatusDto } from '../../scene-status/dto/scene-status.dto';
import { type CatalogProviderKey } from '../../providers/catalog/catalog-provider.util';

export class ScenesFeedItemDto {
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
  source!: CatalogProviderKey;
  status!: SceneStatusDto;
  requestable!: boolean;
  /** The scene in your Stash library, when you have it (for previews and Play). */
  localSceneId!: string | null;
}

export class ScenesFeedResponseDto {
  total!: number;
  page!: number;
  perPage!: number;
  hasMore!: boolean;
  /** Scenes on this page left out by Settings → Hidden content. */
  hidden!: number;
  items!: ScenesFeedItemDto[];
  /** Tags this catalog doesn't have (by name), so they weren't filtered on. */
  unknownTags?: string[];
  /** Tags whose name couldn't be looked up just now, so their ids were used as given. */
  uncheckedTags?: string[];
}
