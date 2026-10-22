import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class UpdateIntegrationDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  // Only web addresses: the server fetches this URL, so file: or ftp: has no place here.
  @IsOptional()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  @MaxLength(2048)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  apiKey?: string;

  /** Removes the saved API key (a blank apiKey keeps it). A new apiKey wins. */
  @IsOptional()
  @IsBoolean()
  clearApiKey?: boolean;
}
