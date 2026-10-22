import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { AppearanceService } from './appearance.service';
import {
  type AppearanceResponse,
  UpdateAppearanceDto,
} from './dto/appearance.dto';

/** Settings → Appearance. Signed-in admins only, like everything not marked public. */
@Controller('api/appearance')
export class AppearanceController {
  constructor(private readonly appearance: AppearanceService) {}

  @Get()
  get(): Promise<AppearanceResponse> {
    return this.appearance.get();
  }

  @Put()
  update(@Body() body: UpdateAppearanceDto): Promise<AppearanceResponse> {
    return this.appearance.update(body);
  }

  /** Back to the defaults (follow the device, Light/Dark). */
  @Delete()
  reset(): Promise<AppearanceResponse> {
    return this.appearance.reset();
  }
}
