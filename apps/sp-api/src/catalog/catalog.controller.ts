import { Controller, Get } from '@nestjs/common';
import {
  type CatalogBrowseProviders,
  CatalogProviderService,
} from '../providers/catalog/catalog-provider.service';

@Controller('api/catalog')
export class CatalogController {
  constructor(
    private readonly catalogProviderService: CatalogProviderService,
  ) {}

  /** Which catalog providers can be browsed, and which one handles requests. */
  @Get('providers')
  getProviders(): Promise<CatalogBrowseProviders> {
    return this.catalogProviderService.getBrowseProviders();
  }
}
