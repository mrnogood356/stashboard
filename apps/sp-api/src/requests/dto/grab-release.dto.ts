import { IsInt, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class GrabReleaseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  guid!: string;

  @IsInt()
  @Min(0)
  indexerId!: number;
}
