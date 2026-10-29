import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const HIDDEN_WORDS_MAX = 100;
export const HIDDEN_WORD_MAX_LENGTH = 60;
export const HIDDEN_ITEMS_MAX = 100;

/** The kinds of catalog item that can be hidden one by one. */
export const HIDDEN_ITEM_KINDS = ['tag', 'studio', 'performer'] as const;
export type HiddenItemKind = (typeof HIDDEN_ITEM_KINDS)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A catalog tag, studio or performer, kept with its name so Settings can show it. */
export class HiddenItemDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  id!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;
}

export class HiddenContentSettingsDto {
  words!: string[];
  tags!: HiddenItemDto[];
  studios!: HiddenItemDto[];
  performers!: HiddenItemDto[];
  /** Leave scenes already in your library out of catalog lists. */
  hideOwned!: boolean;
}

export class UpdateHiddenContentSettingsDto {
  /** Whole words; "trans, transgender" may also come as one entry. */
  @IsArray()
  @ArrayMaxSize(HIDDEN_WORDS_MAX)
  @IsString({ each: true })
  @MaxLength(HIDDEN_WORD_MAX_LENGTH * 10, { each: true })
  words!: string[];

  @IsArray()
  @ArrayMaxSize(HIDDEN_ITEMS_MAX)
  @ValidateNested({ each: true })
  @Type(() => HiddenItemDto)
  tags!: HiddenItemDto[];

  @IsArray()
  @ArrayMaxSize(HIDDEN_ITEMS_MAX)
  @ValidateNested({ each: true })
  @Type(() => HiddenItemDto)
  studios!: HiddenItemDto[];

  /** Left out by older clients; the saved performers are kept then. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(HIDDEN_ITEMS_MAX)
  @ValidateNested({ each: true })
  @Type(() => HiddenItemDto)
  performers?: HiddenItemDto[];

  /** Left out by older clients; the saved choice is kept then. */
  @IsOptional()
  @IsBoolean()
  hideOwned?: boolean;
}

/** "Hide this studio" and friends: one item added to the list. */
export class HideItemDto extends HiddenItemDto {
  @IsIn(HIDDEN_ITEM_KINDS)
  kind!: HiddenItemKind;
}

/** "Stop hiding": one item taken off the list. */
export class UnhideItemDto {
  @IsIn(HIDDEN_ITEM_KINDS)
  kind!: HiddenItemKind;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  id!: string;
}
