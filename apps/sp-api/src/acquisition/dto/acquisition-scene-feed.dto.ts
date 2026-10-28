import { SceneStatusDto } from '../../scene-status/dto/scene-status.dto';
import { type CatalogProviderKey } from '../../providers/catalog/catalog-provider.util';

export class AcquisitionCountsByLifecycleDto {
  REQUESTED!: number;
  DOWNLOADING!: number;
  IMPORT_PENDING!: number;
  FAILED!: number;
  /** Requests that reached the library in the last few days. */
  AVAILABLE!: number;
}

/** How far along a download is, from Whisparr's queue. */
export class AcquisitionDownloadDto {
  /** 0–100, or null when the download client doesn't say. */
  progress!: number | null;
  /** "hh:mm:ss" (or "d.hh:mm:ss") left, when known. */
  timeLeft!: string | null;
}

export class AcquisitionSceneItemDto {
  id!: string;
  title!: string;
  description!: string | null;
  imageUrl!: string | null;
  cardImageUrl!: string | null;
  studioId!: string | null;
  studio!: string | null;
  studioImageUrl!: string | null;
  /** Performer names, comma-separated. */
  performers!: string | null;
  releaseDate!: string | null;
  duration!: number | null;
  type!: 'SCENE';
  source!: CatalogProviderKey;
  status!: SceneStatusDto;
  queueStatus!: string | null;
  queueState!: string | null;
  errorMessage!: string | null;
  whisparrViewUrl!: string | null;
  /** While downloading: how far along it is. */
  download!: AcquisitionDownloadDto | null;
  /** Recently added: when Stash got it, and where to open it. */
  addedAt!: string | null;
  stashViewUrl!: string | null;
}

export class AcquisitionScenesFeedDto {
  total!: number;
  page!: number;
  perPage!: number;
  hasMore!: boolean;
  countsByLifecycle!: AcquisitionCountsByLifecycleDto;
  items!: AcquisitionSceneItemDto[];
}
