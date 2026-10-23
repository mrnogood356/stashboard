import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const ID = /^[A-Za-z0-9-]{1,64}$/;

export const UNMATCHED_SORTS = [
  'added-desc',
  'added-asc',
  'title',
  'path',
  'date',
] as const;
export type UnmatchedSort = (typeof UNMATCHED_SORTS)[number];
export const UNMATCHED_SCOPES = ['unmatched', 'unlinked', 'all'] as const;
export type UnmatchedScope = (typeof UNMATCHED_SCOPES)[number];

export class OrganizerPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Words in the title, file name or folder. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(UNMATCHED_SORTS)
  sort?: UnmatchedSort;

  /** Unmatched (the default), not linked to the catalog, or every scene. */
  @IsOptional()
  @IsIn(UNMATCHED_SCOPES)
  scope?: UnmatchedScope;
}

export class LookupScenesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(ID, { each: true })
  sceneIds!: string[];

  /** Your own search words (one scene only); skips the fingerprint check. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;
}

export class ApplyMatchDto {
  @IsString()
  @Matches(ID)
  sceneId!: string;

  @IsString()
  @Matches(ID)
  candidateId!: string;
}

export class UpdateOrganizerSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  renamePattern?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  renameRoot?: string;

  @IsOptional()
  @IsBoolean()
  renameAfterMatch?: boolean;

  @IsOptional()
  @IsBoolean()
  moveUnmatched?: boolean;

  @IsOptional()
  @IsBoolean()
  cleanEmptyFolders?: boolean;

  /** Folders the clean-up never removes (full paths as Stash sees them). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  keepFolders?: string[];

  @IsOptional()
  @IsBoolean()
  skipWhisparrFiles?: boolean;

  @IsOptional()
  @IsBoolean()
  autoMatchNightly?: boolean;

  @IsOptional()
  @IsBoolean()
  useStashScrapers?: boolean;

  /** Empty removes it. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tpdbApiKey?: string;

  @IsOptional()
  @IsBoolean()
  sendToWhisparr?: boolean;

  @IsOptional()
  @IsBoolean()
  addToWhisparr?: boolean;

  @IsOptional()
  @IsIn(['move', 'copy'])
  whisparrImportMode?: 'move' | 'copy';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  whisparrPathFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  whisparrPathTo?: string;
}

export class ScrapeSceneDto {
  @IsString()
  @Matches(ID)
  sceneId!: string;
}

export class RenamePreviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pattern?: string;
}

export class RenameScenesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(ID, { each: true })
  sceneIds!: string[];
}

/** Scenes picked in the Match list. */
export class PickedScenesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(ID, { each: true })
  sceneIds!: string[];
}

/** Every unmatched scene, or just the picked ones. */
export class MoveUnmatchedDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Matches(ID, { each: true })
  sceneIds?: string[];
}
